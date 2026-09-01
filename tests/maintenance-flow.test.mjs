import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TEST_DATA = join(ROOT, 'tmp', '_data', 'unit-maintenance-flow');
const MAIN = join(ROOT, 'src', 'server', 'main.mjs');
const CLIENT = join(ROOT, 'src', 'client', 'chat.mjs');
const MARKER = join(TEST_DATA, 'MAINTENANCE');

/*
 * 印を置いたまま起動し、消したときに切り替わるところまでを通しで見る。
 *
 * 別プロセスで動かすのは、main.mjs がトップレベルで待ち受けを始める作りだから。
 * import では試せない。
 *
 * 本番（_data・8787）には触らない。置き場もポートもテスト用に差し替える。
 */

/** 空いているポートを 1 つ borrow する */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

/**
 * 落として、終わるまで待つ。
 *
 * Windows は掴まれているファイルを消せない。kill はすぐ返るが、その時点では
 * まだ DB のハンドルを握っているため、待たずに消すと EPERM になる。
 */
function killAndWait(proc) {
	if (!proc || proc.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		proc.once('exit', resolve);
		proc.kill();
		// 落ちない場合でも先へ進む。消せなければ次の行で拾う
		setTimeout(resolve, 5000).unref?.();
	});
}

/** 消す。掴まれていたら少し待って試し直す */
async function removeWhenFree(dir) {
	for (let i = 0; i < 20; i++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	// 消せなくてもテストの結果には影響しない。tmp/ は Git 管理外
}

/** 条件が満たされるまで待つ。満たされなければ失敗させる */
async function until(check, { timeoutMs = 20000, everyMs = 200, what = '条件' } = {}) {
	const limit = Date.now() + timeoutMs;
	while (Date.now() < limit) {
		try {
			const value = await check();
			if (value) return value;
		} catch {
			/* まだ繋がらない。待つ */
		}
		await new Promise((r) => setTimeout(r, everyMs));
	}
	assert.fail(`${what} が満たされませんでした（${timeoutMs}ms）`);
}

let child;
let port;
let base;
let token = '';

describe('メンテナンスの通し', () => {
	before(async () => {
		rmSync(TEST_DATA, { recursive: true, force: true });
		mkdirSync(TEST_DATA, { recursive: true });
		writeFileSync(MARKER, 'DB を作り直しています\n見込み: 3 分', 'utf8');

		port = await freePort();
		base = `http://127.0.0.1:${port}`;

		child = spawn(process.execPath, [MAIN], {
			env: { ...process.env, AICHAT_DATA: TEST_DATA, AICHAT_PORT: String(port) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			// テスト用として立つとアクセストークンを求められる。ログから取り出す
			const m = chunk.match(/アクセストークン: (\S+)/);
			if (m) token = m[1];
		});

		// 印があっても待ち受けは始まる。始まるまで待つ
		await until(() => fetch(`${base}/api/version`).then((r) => r.ok), { what: '待ち受けの開始' });
	});

	after(async () => {
		await killAndWait(child);
		await removeWhenFree(TEST_DATA);
	});

	test('印があっても待ち受けは始まる', async () => {
		// 待ってから始めるとポートが開かず、繋いだ側は ECONNREFUSED を受ける。
		// メンテナンス中なのか、死んでいるのか、ポート違いかが区別できない
		const json = await (await fetch(`${base}/api/version`)).json();

		assert.equal(json.maintenance, true);
		assert.ok(json.maintenance_since, 'いつからかが入っていない');
	});

	test('API は 503 で、印に書いた理由と見込みが出る', async () => {
		const res = await fetch(`${base}/api/users?access_token=${token}`);
		const json = await res.json();

		assert.equal(res.status, 503);
		assert.equal(res.headers.get('retry-after'), '180', '「見込み: 3 分」が反映されていない');
		assert.equal(json.detail, 'DB を作り直しています');
	});

	test('印を消すと、ポートを閉じずに通常の応答へ切り替わる', async () => {
		rmSync(MARKER, { force: true });

		const json = await until(
			async () => {
				const v = await (await fetch(`${base}/api/version`)).json();
				return v.maintenance === false ? v : null;
			},
			{ what: '通常の応答への切り替え' }
		);

		assert.equal(json.maintenance, false);
		assert.ok(json.started_at, '起動した時刻が入っていない');

		// 切り替わったあとは API が通る
		const users = await fetch(`${base}/api/users?access_token=${token}`);
		assert.equal(users.status, 200);
	});

	test('再開したことを既定のルームに知らせる', async () => {
		const messages = await until(
			async () => {
				const r = await fetch(`${base}/api/history?limit=5&access_token=${token}`);
				const { messages } = await r.json();
				return messages.some((m) => m.msg_body.includes('運用を再開しました')) ? messages : null;
			},
			{ what: '再開の案内' }
		);

		const notice = messages.find((m) => m.msg_body.includes('運用を再開しました'));

		// 【メンテナンス】で始める。say の間はセッションの発言と名前で区別できないため
		assert.match(notice.msg_body, /^【メンテナンス】/);
		// 名乗るのはこのプロジェクトのフォルダ名。専用の名前にすると参加者一覧に増える
		assert.equal(notice.from_user_id, 'ai-chat-lite');
		// 読んだ位置は保たれるので取りこぼしは無いが、遅れたことは書かないと分からない
		assert.match(notice.msg_body, /止まっていました/);
	});

	test('印を待たずに起動したときは案内を出さない', async () => {
		/*
		 * 素の restart（コードの入れ替え）でも流すと、開発中にルームが
		 * 起動メッセージで埋まる。印を待った起動のときだけにしてある。
		 */
		const data = join(ROOT, 'tmp', '_data', 'unit-maintenance-flow-plain');
		rmSync(data, { recursive: true, force: true });
		mkdirSync(data, { recursive: true });

		const p = await freePort();
		let tok = '';
		const plain = spawn(process.execPath, [MAIN], {
			env: { ...process.env, AICHAT_DATA: data, AICHAT_PORT: String(p) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		plain.stdout.setEncoding('utf8');
		plain.stdout.on('data', (c) => {
			const m = c.match(/アクセストークン: (\S+)/);
			if (m) tok = m[1];
		});

		try {
			await until(
				async () => (await (await fetch(`http://127.0.0.1:${p}/api/version`)).json()).maintenance === false,
				{ what: '起動' }
			);

			const { messages } = await (await fetch(`http://127.0.0.1:${p}/api/history?limit=20&access_token=${tok}`)).json();

			assert.equal(
				messages.filter((m) => m.msg_body.includes('運用を再開しました')).length,
				0,
				'印を待っていないのに案内が出ている'
			);
		} finally {
			await killAndWait(plain);
			await removeWhenFree(data);
		}
	});

	test('メンテナンス中に張った待受けは、明けてから新着で終わる', async () => {
		/*
		 * 粘って繋がる道筋を見る。諦める道筋は wait だと 10 分かかるので、
		 * 粘らないコマンド（stop）で別に見ている（client-unreachable）。
		 *
		 * 間隔が 10 秒なので、印を消してから最初の繋ぎ直しまで最大 10 秒かかる。
		 */
		const data = join(ROOT, 'tmp', '_data', 'unit-maintenance-flow-retry');
		await removeWhenFree(data);
		mkdirSync(data, { recursive: true });
		const marker = join(data, 'MAINTENANCE');
		writeFileSync(marker, '作業中', 'utf8');

		const p = await freePort();
		let tok = '';
		const server = spawn(process.execPath, [MAIN], {
			env: { ...process.env, AICHAT_DATA: data, AICHAT_PORT: String(p) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		server.stdout.setEncoding('utf8');
		server.stdout.on('data', (c) => {
			const m = c.match(/アクセストークン: (\S+)/);
			if (m) tok = m[1];
		});

		try {
			await until(async () => (await (await fetch(`http://127.0.0.1:${p}/api/version`)).json()).maintenance === true, {
				what: 'メンテナンス中での待ち受け',
			});

			// メンテナンス中に待受けを張る。ここでは繋がらず、粘りに入る
			let outText = '';
			let errText = '';
			const waiter = spawn(process.execPath, [
				CLIENT, 'wait', '--port', String(p), '--access-token', tok, '--connector-id', 'user1', '--wait-sec', '45',
			]);
			waiter.stdout.setEncoding('utf8');
			waiter.stderr.setEncoding('utf8');
			waiter.stdout.on('data', (c) => { outText += c; });
			waiter.stderr.on('data', (c) => { errText += c; });
			const waiting = new Promise((resolve) => waiter.once('exit', resolve));

			/*
			 * 粘りに入ったことを確かめてから明ける。
			 *
			 * 先に明けると、CLI が最初の要求を出す前に通常へ戻ってしまい、
			 * 一度も断られずに繋がる。それでは繋ぎ直しを見たことにならない。
			 */
			await until(() => errText.includes('メンテナンス中です'), { what: '粘りに入ること', timeoutMs: 15000 });

			// 明ける
			rmSync(marker, { force: true });

			/*
			 * 繋ぎ直しを待ってから投稿する。
			 *
			 * 先に投稿すると、待受けは繋いだ時点の位置から待ち始めるため、
			 * その発言を新着として受け取れない（読んだ位置がそこまで進んでいる）。
			 * 待っている間は接続を保持しているので、在席に出たら繋がったと分かる。
			 */
			await until(
				async () => {
					const r = await fetch(`http://127.0.0.1:${p}/api/users?access_token=${tok}`);
					if (!r.ok) return false;
					const { users } = await r.json();
					return users.some((u) => u.user_id === 'user1' && u.status === 'online');
				},
				{ what: '待受けの繋ぎ直し', timeoutMs: 30000 }
			);

			const posted = await fetch(`http://127.0.0.1:${p}/api/say`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-AiChat-Access-Token': tok },
				body: JSON.stringify({ from_user_id: 'user2', msg_body: 'メンテ明けの発言' }),
			});
			assert.ok(posted.ok, '投稿できなかった');

			assert.equal(await waiting, 0, `待受けが正常に終わっていない\n${errText}`);

			// 粘ったことは始めの 1 行で分かる。途中は出さない
			assert.match(errText, /メンテナンス中です/);
			assert.equal(errText.split('\n').filter((l) => l.includes('メンテナンス中です')).length, 1, '途中も出している');
			assert.match(outText, /新着 1 件/);
			assert.match(outText, /メンテ明けの発言/);
		} finally {
			await killAndWait(server);
			await removeWhenFree(data);
		}
	});

	test('後始末で印が残っていない', () => {
		assert.equal(existsSync(MARKER), false);
	});
});

/*
 * 名乗る ID の渡し方を確かめる。
 *
 * ID はコマンドの直後の位置引数で、コロンで囲む（wait :ai-chat-lite: -p 8787）。
 * --connector-id / -c は廃止した。
 *
 * なぜ囲むのか。囲みが無いと、プロセス一覧から待受けを探す式が前方一致する。
 * project-a を探すと project-aa にも当たり、1 本しか張っていない待受けが
 * 2 本に見える。それを二重と誤認して片方を止めると、相手は原因不明の
 * exit 255 で落ちる（実際に起きた。issues の i260901-07）。
 * 閉じのコロンが境目になるので、囲めば起きない。
 *
 * なぜ位置を固定するのか。オプションはコマンドの前にも後ろにも書けるため、
 * 探す側が場所を決め打ちできない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { wrapId } from './helpers/cli-args.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-connector-id');
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

process.env.AICHAT_NO_EXIT = '1';
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');
const { ID_WRAP, ID_PATTERN } = await import('../src/client/options.mjs');

let servers;
let base;

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
});

after(async () => {
	await stopServers(servers);
});

/** 引数をそのまま渡す。ID の差し込みはしない（形そのものを試すため） */
function raw(args) {
	return run(process.execPath, [CLIENT, ...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN], {
		env: { ...process.env },
	});
}

/** 失敗する呼び出しを、終了コードと標準エラーごと受け取る */
async function failing(args) {
	try {
		await raw(args);
		assert.fail(`エラーにならなかった: ${args.join(' ')}`);
	} catch (err) {
		return { code: err.code, stderr: err.stderr, stdout: err.stdout };
	}
}

describe('ID はコマンドの直後に置く', () => {
	test('コマンドの次の語が名乗る ID になる', async () => {
		const { stdout } = await raw(['join', wrapId('test-id1')]);

		assert.match(stdout, /^test-id1 として/);
	});

	test('本文は ID の次から数える', async () => {
		// ID を位置引数にしたので、say の本文は 2 つめの位置引数になる
		await raw(['join', wrapId('test-id1')]);
		const { stdout } = await raw(['say', wrapId('test-id1'), '位置の確認']);

		assert.match(stdout, /送信しました/);

		const { stdout: recent } = await raw(['recent', '-n', '1']);
		assert.match(recent, /test-id1\r?\n位置の確認/);
	});

	test('読むだけのコマンドは ID を取らない', async () => {
		// recent / who / dump / archives は名乗る必要がない
		const { stdout } = await raw(['who']);

		assert.match(stdout, /参加者:/);
	});

	test('ID を書かないと止まる', async () => {
		const { code, stderr } = await failing(['wait', '--wait-sec', '1']);

		assert.equal(code, 1);
		assert.match(stderr, /名乗る ID が指定されていません/);
		assert.match(stderr, /wait の直後に、コロンで囲んで置いてください/);
	});
});

describe('囲みの検査', () => {
	test('囲みが無ければ断る', async () => {
		/*
		 * 黙って受けると新しい形と古い形が混ざる。混ざると
		 * 「コマンドの次の語が ID」という前提が崩れ、探す側が場所を決め打ちできない。
		 */
		const { code, stderr } = await failing(['join', 'test-id1']);

		assert.equal(code, 2);
		assert.match(stderr, /ID は : で囲んでください/);
		assert.match(stderr, /例: :test-id1:/);
	});

	test('片側だけの囲みも断る', async () => {
		for (const bad of [':test-id1', 'test-id1:']) {
			const { code, stderr } = await failing(['join', bad]);

			assert.equal(code, 2, `${bad} が断られていない`);
			assert.match(stderr, /で囲んでください/);
		}
	});

	test('中身が空の囲みは断る', async () => {
		// :: は囲みの形をしているが ID が無い
		const { code } = await failing(['join', '::']);

		assert.equal(code, 2);
	});

	test('使えない文字は断る', async () => {
		for (const bad of [':te st:', ':te.st:', ':te@st:', ':te/st:']) {
			const { code, stderr } = await failing(['join', bad]);

			assert.equal(code, 2, `${bad} が断られていない`);
			assert.match(stderr, /ID に使えない文字が入っています/);
		}
	});

	test('英数字・ハイフン・下線は通る', async () => {
		for (const ok of ['abc', 'ABC', 'a1', 'a-b', 'a_b', '20260824-ai-pc']) {
			const { stdout } = await raw(['join', wrapId(ok)]);

			assert.match(stdout, new RegExp(`^${ok} として`), `${ok} が通らない`);
		}
	});
});

describe('前方一致する ID を取り違えない', () => {
	/*
	 * この課題そのもの。囲みが無いと project-a を探す式が project-aa にも当たる。
	 * 囲めば当たらないことを、探す側の書き方で確かめる。
	 */
	test('コマンドラインを部分一致で探しても混ざらない', () => {
		const shorter = `aichat.exe wait ${wrapId('project-a')} -p 8787`;
		const longer = `aichat.exe wait ${wrapId('project-aa')} -p 8787`;

		// 囲まないと 2 本に見える（これが事故の元）
		assert.ok(shorter.includes('project-a'));
		assert.ok(longer.includes('project-a'), '囲まなければ前方一致してしまう');

		// 囲めば 1 本だけに当たる
		const needle = wrapId('project-a');
		assert.ok(shorter.includes(needle));
		assert.ok(!longer.includes(needle), '囲んでいるのに前方一致している');
	});

	test('名乗った ID が別の ID に化けない', async () => {
		await raw(['join', wrapId('test-pre-a')]);
		await raw(['join', wrapId('test-pre-aa')]);

		const { stdout } = await raw(['who']);

		// 2 件が別々に並ぶこと。片方に吸収されない
		assert.match(stdout, /test-pre-a\s/);
		assert.match(stdout, /test-pre-aa\s/);
	});
});

describe('--to も囲む', () => {
	test('名指しの相手もコロンで囲んで渡す', async () => {
		await raw(['join', wrapId('test-id1')]);
		await raw(['join', wrapId('test-id2')]);
		await raw(['say', wrapId('test-id1'), '名指しの確認', '--to', wrapId('test-id2')]);

		const { stdout } = await raw(['recent', '-n', '1']);

		assert.match(stdout, /test-id1 @test-id2\r?\n名指しの確認/);
	});

	test('--to の囲みが無ければ断る', async () => {
		const { code, stderr } = await failing(['say', wrapId('test-id1'), 'x', '--to', 'test-id2']);

		assert.equal(code, 2);
		assert.match(stderr, /ID は : で囲んでください（--to）/);
	});
});

describe('廃止した --connector-id', () => {
	test('長い形は新しい書き方を案内して止まる', async () => {
		const { code, stderr } = await failing(['wait', '--connector-id', 'test-id1']);

		assert.equal(code, 2);
		assert.match(stderr, /--connector-id は廃止されました/);
		assert.match(stderr, /コマンドの直後に、コロンで囲んで置きます/);
	});

	test('短い形 -c も捕まえる', async () => {
		/*
		 * ルールと手順書に -c の形が残っている。長い形だけ見ていると、
		 * -c で叩いた相手が「知らないオプションです」で止まり、直し方が分からない。
		 */
		const { code, stderr } = await failing(['wait', '-c', 'test-id1']);

		assert.equal(code, 2);
		assert.match(stderr, /-c は廃止されました/);
		assert.match(stderr, /コマンドの直後に、コロンで囲んで置きます/);
	});
});

describe('サーバー側でも文字を検査する', () => {
	/*
	 * CLI だけだと web UI や curl から直に叩いた分が抜ける。
	 * 逆にサーバーだけだと、往復してからでないと誤りが分からない。両方に置く。
	 */
	test('使えない文字の ID は 400 で断る', async () => {
		const res = await fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: 'te st', connector_role: 'ai' }),
		});

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error, /英数字・ハイフン・下線だけです/);
	});

	test('ルーム ID にも同じ規則を効かせる', async () => {
		// 囲みは参加者の ID だけだが、文字の制限はルームにも揃える
		const res = await fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: 'test-id1', connector_role: 'ai', room_id: 'bad room' }),
		});

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error, /room_id/);
	});

	test('コロンを含む ID は断る（囲みと紛れる）', async () => {
		const res = await fetch(`${base}/api/join`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-AiChat-Access-Token': TEST_ACCESS_TOKEN },
			body: JSON.stringify({ connector_id: 'te:st', connector_role: 'ai' }),
		});

		assert.equal(res.status, 400);
	});
});

describe('規則の置き場', () => {
	test('囲みと文字の規則は options.mjs 1 か所から来る', () => {
		// CLI 2 本とサーバーが同じ値を見る。写すと必ずずれる
		assert.equal(ID_WRAP, ':');
		assert.equal(ID_PATTERN, '^[A-Za-z0-9_-]+$');
	});

	test('規則は下線を許すので、囲みに下線は使えない', () => {
		// _id_ を囲みにすると、ID の中の下線と境目が区別できない
		assert.ok(new RegExp(ID_PATTERN).test('a_b'), '下線が使えなくなっている');
		assert.notEqual(ID_WRAP, '_');
	});
});

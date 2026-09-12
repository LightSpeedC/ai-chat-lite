/*
 * テスト専用のサーバーを立てる。
 *
 * 本番（8787 / 既定の置き場）とは別のポート・別の置き場で動かす。
 * 本番には他プロジェクトの AI が待ち受けているため、テストの投稿にも返事が来る。
 * ポートを分ければそもそも届かない。
 *
 * 本番サービスは止めない。ポートが違えば共存できるし、止めるには管理者権限が要る。
 *
 *   node tools/40_test/start-test-server.mjs        立てる
 *   node tools/40_test/start-test-server.mjs --stop 止める
 *
 * 立てると <置き場>/server.json に { port, env, data, pid, url, access_token, open } を書く。
 * ポートは空きを探して決まるので、テスト側はこれを読んで接続先を知る。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * テストの置き場。本番と同じ構造にする。
 *
 * DB も、バックアップ・メンテナンスの印も、接続情報もすべてこの下に入る。
 * 置き場が既定でなければテスト用として動く（config.mjs の IS_TEST）。
 */
const DATA_DIR = process.env.AICHAT_DATA ?? join(root, 'tmp', '_data');
const INFO = join(DATA_DIR, 'server.json');
const LOG = join(DATA_DIR, 'server.log');

/*
 * 探し始めるポート。Git 管理外の設定ファイルから読む。
 *
 * 【なぜソースに書かないか】
 * このリポジトリは公開されている。テスト用サーバーの番号は USAGE に載せて
 * おらず、他プロジェクトへ案内していない値なので、公開する側に置かない。
 *
 * 既定値をここに書くと、設定ファイルを消しても動いてしまい、番号がソースに
 * 残ったままになる。だから既定値は持たず、無ければ起動を断る。
 *
 * 置き場は先頭 _ のフォルダ。.gitignore が全階層を管理外にしている。
 */
const SECRETS = join(root, '_secrets', 'test-server.json');

function readFirstPort() {
	if (!existsSync(SECRETS)) {
		console.error('テスト用サーバーの設定がありません。');
		console.error('  _secrets/test-server.json に { "firstPort": <番号> } を置いてください。');
		console.error('  本番のポートとは離れた番号にすること。打ち間違いがそのまま本番に飛びます。');
		process.exit(2);
	}
	let conf;
	try {
		conf = JSON.parse(readFileSync(SECRETS, 'utf8'));
	} catch (err) {
		console.error(`テスト用サーバーの設定が読めません: ${err.message}`);
		process.exit(2);
	}
	const port = Number(conf.firstPort);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		console.error(`firstPort は 1024〜65535 の整数にしてください: ${conf.firstPort}`);
		process.exit(2);
	}
	return port;
}

const FIRST_PORT = readFirstPort();

/*
 * 下げる回数に上限を置く。
 *
 * address in use の元をたどると、多くは前回のテストサーバーが残っている。
 * 下げ続けると多重起動が積み上がるので、10 個で諦めて知らせる。
 */
const MAX_TRIES = 10;

/** 待つ。プロセスの終了やファイルの解放を見るのに使う */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 止める ---

if (process.argv.includes('--stop')) {
	if (!existsSync(INFO)) {
		console.log('立っていません。');
		process.exit(0);
	}
	const info = JSON.parse(readFileSync(INFO, 'utf8'));
	try {
		process.kill(info.pid);
		console.log(`止めました（pid ${info.pid} / ポート ${info.port}）。`);
	} catch (err) {
		console.log(`既に居ません（pid ${info.pid}）: ${err.code}`);
	}

	/*
	 * プロセスが閉じるのを待つ。
	 *
	 * kill はすぐ返るが、その時点ではまだ DB のハンドルを握っている。
	 * 待たずに消すと EPERM になる（実際になった）。
	 */
	for (let i = 0; i < 40; i++) {
		try {
			process.kill(info.pid, 0); // 生きているかを見るだけ
		} catch {
			break; // 居なくなった
		}
		await wait(100);
	}

	/*
	 * 置き場ごと捨てる。テスト用なので取っておく意味がない。
	 *
	 * 後始末を抜けた分（猶予のあとに積まれた離脱など）もここで消える。
	 * DB は本体・-wal・-shm の 3 つ組だが、フォルダごと消すので数えなくてよい。
	 */
	let left = null;
	for (let i = 0; i < 20; i++) {
		try {
			rmSync(DATA_DIR, { recursive: true, force: true });
			left = null;
			break;
		} catch (err) {
			left = err.code;
			await wait(200);
		}
	}
	console.log(left ? `  置き場を消せませんでした（${left}）。` : '  置き場ごと捨てました。');
	process.exit(0);
}

// --- 空いているポートを探す ---

/** そのポートで listen できるかを確かめる。できたらすぐ閉じる */
function canListen(port) {
	return new Promise((done) => {
		const probe = createServer();
		probe.once('error', () => done(false));
		probe.once('listening', () => probe.close(() => done(true)));
		probe.listen(port, '127.0.0.1');
	});
}

async function findPort() {
	for (let i = 0; i < MAX_TRIES; i++) {
		const port = FIRST_PORT - i;
		if (await canListen(port)) return port;
		console.log(`  ${port} は使われています`);
	}
	throw new Error(
		`${FIRST_PORT} から ${MAX_TRIES} 個下げても空きがありません。` +
			'前のテストサーバーが残っていないか確かめてください。'
	);
}

// --- 立てる ---

/** サーバーが応えるまで待つ。プロセスが起きても listen までに間がある */
async function waitReady(url, ms = 15000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		try {
			const res = await fetch(`${url}/api/version`);
			if (res.ok) return await res.json();
		} catch {
			/* まだ立っていない */
		}
		await wait(200);
	}
	return null;
}

// 前回の置き場は捨ててから作り直す
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const port = await findPort();
const url = `http://localhost:${port}`;

/*
 * 出力はログに落とす。捨てると立ち上がらなかったときに理由が分からない。
 * 実際に一度これで詰まった。
 */
const log = openSync(LOG, 'a');

// 入口は main.mjs。server.mjs は startServers を export するだけで、直に叩いても何も起きない
const child = spawn(process.execPath, [join(root, 'src', 'server', 'main.mjs')], {
	cwd: root,
	env: { ...process.env, AICHAT_PORT: String(port), AICHAT_DATA: DATA_DIR },
	detached: true,
	stdio: ['ignore', log, log],
});
child.unref();

const version = await waitReady(url);
if (!version) {
	try {
		process.kill(child.pid);
	} catch {
		/* 既に落ちている */
	}
	const tail = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim() : '(ログがありません)';
	throw new Error(`立ち上がりません（ポート ${port}）。\n--- サーバーの出力 ---\n${tail}`);
}

/*
 * テストとして立ったことを確かめる。
 *
 * 置き場を渡したのに production で立つのは、置き場の判定が壊れているとき。
 * 気づかずにテストを流すと本番と同じ扱いで動いてしまう。
 */
if (version.env !== 'test') {
	try {
		process.kill(child.pid);
	} catch {
		/* 既に落ちている */
	}
	throw new Error(`テストとして立ちませんでした（env=${version.env}）。置き場: ${DATA_DIR}`);
}

/*
 * アクセストークンはサーバーが起動のたびに作る。/api/version では返さない（誰でも読めてしまう）。
 * ログの 1 行目に出しているので、そこから取り出す。
 */
const accessToken = readFileSync(LOG, 'utf8').match(/アクセストークン: (\S+)/)?.[1] ?? '';

/** 画面を開くための URL。アクセストークンをクエリに載せる */
const openUrl = accessToken ? `${url}/?access_token=${accessToken}` : url;

writeFileSync(
	INFO,
	JSON.stringify(
		{ port, env: version.env, data: DATA_DIR, pid: child.pid, url, access_token: accessToken, open: openUrl },
		null,
		'\t'
	) + '\n'
);

console.log('テスト用サーバーを立てました。');
console.log(`  ポート  ${port}`);
console.log(`  置き場  ${DATA_DIR.replace(root, '.')}`);
console.log(`  環境    ${version.env}`);
console.log(`  pid     ${child.pid}`);
console.log(`  画面    ${openUrl}`);

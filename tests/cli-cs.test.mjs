/*
 * C# 版 CLI（aichat.exe）が node 版と同じことをするかを確かめる。
 *
 * 2 本を保守するので、必ず食い違う。食い違いを人が見つけるのではなく、
 * ここで機械的に落とす。
 *
 * aichat.exe が無ければ全部スキップする。ビルドは Windows でしかできず、
 * 作っていない環境でも他のテストは通したいため。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TEST_DATA = join(ROOT, 'tmp', '_data', 'unit-cli-cs');
const NODE_CLI = join(ROOT, 'src', 'client', 'chat.mjs');
const EXE = join(ROOT, 'aichat.exe');

/** ビルドしていなければ何も試せない */
const built = existsSync(EXE);

// 版を当ててから store を読み込む（store.mjs は形を作らない）
await prepareTestDb(TEST_DATA);

const { startServers, stopServers } = await import('../src/server/server.mjs');
const { TEST_ACCESS_TOKEN } = await import('../src/server/config.mjs');

let servers;
let base;

before(async () => {
	servers = await startServers(0, ['127.0.0.1']);
	base = `http://127.0.0.1:${servers[0].address().port}`;
});

after(async () => {
	await stopServers(servers);
});

/** node 版を呼ぶ */
function viaNode(args, connectorId = 'test-cli-cs') {
	return run(
		process.execPath,
		[NODE_CLI, ...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN, '--connector-id', connectorId],
		{ env: { ...process.env } }
	);
}

/** C# 版を呼ぶ */
function viaExe(args, connectorId = 'test-cli-cs') {
	return run(
		EXE,
		[...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN, '--connector-id', connectorId],
		{ env: { ...process.env } }
	);
}

/*
 * 出力の揺れを落として比べる。
 *
 * 時刻・msg_seq・pid はそのつど変わるので、形だけを見る。
 * 揃っていてほしいのは「何をどう並べるか」であって、値そのものではない。
 */
function shape(text) {
	return text
		.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g, '<日時>')
		.replace(/\d{2}-\d{2} \d{2}:\d{2}/g, '<短い日時>')
		.replace(/（\d+）/g, '（<数>）')
		.replace(/現在位置 \d+/g, '現在位置 <数>')
		.replace(/pid \d+/g, 'pid <数>')
		.replace(/\r\n/g, '\n')
		.trim();
}

describe('C# 版と node 版で同じものが出る', () => {
	test('aichat.exe があること', () => {
		/*
		 * 無ければ以降はスキップされる。ここで気づけるように 1 件だけ立てる。
		 * ビルドは tools/20_build/build-aichat.cmd で行う。
		 */
		if (!built) console.log('  aichat.exe が無いのでスキップします（build-aichat.cmd で作れます）');
		assert.ok(true);
	});

	test('--help の中身が揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const { stdout: fromNode } = await viaNode(['--help']);
		const { stdout: fromExe } = await viaExe(['--help']);

		/*
		 * 1 行目だけは違ってよい（C# 版と分かるようにしてある）。
		 * コマンドとオプションの並びが揃っていることを見る。
		 */
		const pick = (text) =>
			text
				.split('\n')
				.map((line) => line.trimEnd())
				.filter((line) => /^\s+(--|[a-z])/.test(line))
				.join('\n');

		assert.equal(pick(fromExe), pick(fromNode), 'コマンドとオプションの並びが違う');
	});

	test('join の出力が揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const { stdout: fromNode } = await viaNode(['join', '--role', 'ai'], 'test-cli-node');
		const { stdout: fromExe } = await viaExe(['join', '--role', 'ai'], 'test-cli-exe');

		/*
		 * 1 行目だけを比べる。参加者の一覧は先に参加した分が増えるため、
		 * 全体を比べると「2 人目の方が多い」で落ちる。形が同じかを見たい。
		 */
		const head = (text, id) => shape(text).split('\n')[0].replace(id, '<id>');
		assert.equal(head(fromExe, 'test-cli-exe'), head(fromNode, 'test-cli-node'));

		// 参加者の並びは、どちらも同じ形で出ていること
		assert.match(shape(fromExe), /^参加者 \d+ 人:$/m);
		assert.match(shape(fromNode), /^参加者 \d+ 人:$/m);
	});

	test('say して recent で読める', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		await viaExe(['say', 'C# 版からの発言']);
		const { stdout } = await viaNode(['recent', '-n', '1']);

		assert.match(stdout, /C# 版からの発言/, 'node 版から読めない');
	});

	test('who の出力が揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const { stdout: fromNode } = await viaNode(['who']);
		const { stdout: fromExe } = await viaExe(['who']);

		// 参加者の並びは最終アクセス順で動くため、行数と見出しだけを見る
		assert.equal(shape(fromExe).split('\n')[0], shape(fromNode).split('\n')[0]);
		assert.equal(shape(fromExe).split('\n').length, shape(fromNode).split('\n').length);
	});

	test('wait が新着なしで正常に終わる', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		// 参加の記録を読み終えた状態にしてから、1 秒だけ待つ
		await viaExe(['wait', '--wait-sec', '1']);
		const { stdout } = await viaExe(['wait', '--wait-sec', '1']);

		assert.match(stdout, /新着なし（1 秒待機/, '待ち切ったときの行が違う');
	});

	test('廃止したオプションは両方が同じように止める', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const fail = async (fn) => {
			try {
				await fn();
				return null;
			} catch (err) {
				return err;
			}
		};

		const fromNode = await fail(() => viaNode(['wait', '--timeout', '30']));
		const fromExe = await fail(() => viaExe(['wait', '--timeout', '30']));

		assert.ok(fromNode, 'node 版が止まっていない');
		assert.ok(fromExe, 'C# 版が止まっていない');
		assert.equal(fromExe.code, 2, '終了コードが 2 でない');
		assert.equal(fromNode.code, 2);
		assert.equal(shape(fromExe.stderr), shape(fromNode.stderr), '案内の文が違う');
	});

	test('接続先を渡さなければ両方が同じように止める', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const fail = async (file, args) => {
			try {
				await run(file, args, { env: { ...process.env } });
				return null;
			} catch (err) {
				return err;
			}
		};

		const fromNode = await fail(process.execPath, [NODE_CLI, 'who']);
		const fromExe = await fail(EXE, ['who']);

		assert.equal(fromExe.code, 2);
		assert.equal(fromNode.code, 2);
		assert.match(fromExe.stderr, /接続先が指定されていません/);
	});
});

describe('定義の出どころが 1 つであること', () => {
	test('埋め込んだ JSON と options.mjs が一致する', async () => {
		/*
		 * export-options.mjs が書き出す JSON が、いまの options.mjs と
		 * 食い違わないことを見る。ここが通れば、C# 版の定義も正しい。
		 */
		const { stdout } = await run(
			process.execPath,
			[join(ROOT, 'tools', '20_build', 'export-options.mjs'), '--stdout'],
			{ env: { ...process.env } }
		);
		const exported = JSON.parse(stdout);
		const options = await import('../src/client/options.mjs');

		assert.equal(exported.schema, 1, 'schema が上がったら C# 側も合わせる');
		assert.equal(exported.options.length, options.OPTIONS.length);
		assert.equal(exported.commands.length, options.COMMANDS.length);
		assert.deepEqual(
			exported.options.map((o) => o.long),
			options.OPTIONS.map((o) => o.long)
		);
		assert.deepEqual(
			exported.commands.map((c) => c.name),
			options.COMMANDS.map((c) => c.name)
		);
	});
});

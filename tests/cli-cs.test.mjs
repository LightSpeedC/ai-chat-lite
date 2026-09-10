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
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

import { prepareTestDb } from './helpers/prepare-db.mjs';
import { withId } from './helpers/cli-args.mjs';

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
const { TEST_ACCESS_TOKEN, PORT: DEFAULT_PORT, DEFAULT_ROOM } = await import('../src/server/config.mjs');

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
		[NODE_CLI, ...withId(args, connectorId), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
		{ env: { ...process.env } }
	);
}

/** C# 版を呼ぶ */
function viaExe(args, connectorId = 'test-cli-cs') {
	return run(
		EXE,
		[...withId(args, connectorId), '--url', base, '--access-token', TEST_ACCESS_TOKEN],
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
		.replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g, '<日時>')
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

	test('recent の絞り込み（--find・--from・--since-day）の出力が node 版と一字一句揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const ROOM = 'sandbox-cli-cs-filter';
		await viaExe(['say', 'ルールを更新しました', '--room', ROOM], 'test-cli-filter-a');
		await viaExe(['say', '雑談です', '--room', ROOM], 'test-cli-filter-b');

		const cases = [
			['recent', '--room', ROOM, '--find', 'ルール'],
			['recent', '--room', ROOM, '--find', 'ルール|雑談'],
			['recent', '--room', ROOM, '--from', 'test-cli-filter-a'],
			['recent', '--room', ROOM, '--since-day', '1'],
		];
		for (const args of cases) {
			const { stdout: fromNode } = await viaNode(args);
			const { stdout: fromExe } = await viaExe(args);
			assert.equal(shape(fromExe), shape(fromNode), `${args.join(' ')} の出力が違う`);
		}
	});

	test('recent の排他・書式エラーが node 版と同じ文言・終了コードになる', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const cases = [
			['recent', '--since', '1/1', '--since-day', '1'],
			['recent', '--since', '13/1'],
			['recent', '--since', 'foo'],
			['recent', '--from', 'bad id'],
		];
		for (const args of cases) {
			const node = await run(process.execPath, [NODE_CLI, ...withId(args, 'test-cli-cs'), '--url', base, '--access-token', TEST_ACCESS_TOKEN]).catch((e) => e);
			const exe = await run(EXE, [...withId(args, 'test-cli-cs'), '--url', base, '--access-token', TEST_ACCESS_TOKEN]).catch((e) => e);
			assert.equal(exe.code, node.code, `${args.join(' ')} の終了コードが違う`);
			assert.equal(shape(exe.stderr ?? ''), shape(node.stderr ?? ''), `${args.join(' ')} のエラー文言が違う`);
		}
	});

	/*
	 * 【なぜ必要か】
	 * node 版（/^\d+$/）は前後の空白・符号を許さない厳格な一致だが、C# 版は
	 * int.TryParse の既定（NumberStyles.Integer）で空白・先頭の符号（+/-）も
	 * 通してしまい、int の範囲（約 21 億）も node 版（Number）より狭かった。
	 * tests/client-reply.test.mjs は node 版だけを見ており、両者の突き合わせが
	 * 無かった（レビュー #19、i260908-05）
	 */
	test('--reply-to の受け方が node 版と揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const cases = [' 5', '+5', '5 ', '5.0', '999999999999'];
		for (const value of cases) {
			const node = await viaNode(['say', '本文', '--reply-to', value]).catch((e) => e);
			const exe = await viaExe(['say', '本文', '--reply-to', value]).catch((e) => e);
			assert.equal(exe.code ?? 0, node.code ?? 0, `--reply-to "${value}" の終了コードが違う`);
		}
	});

	/*
	 * 【なぜ必要か】
	 * Path.GetDirectoryName(outPath) は、階層なしの名前（例: messages.jsonl）
	 * を渡すと空文字列を返す。Directory.CreateDirectory("") は
	 * ArgumentException を投げるため、C# 版だけが --out に相対ファイル名を
	 * 渡すと落ちていた。node 版は dirname(out) を使わず常に ROOT/tmp だけ
	 * mkdir するので同条件でも落ちない（レビュー #19、i260908-05）
	 */
	test('dump --out に階層なしの名前を渡しても落ちない', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const cwd = join(ROOT, 'tmp');
		const outName = 'cli-cs-dump-test.jsonl';
		const outPath = join(cwd, outName);
		if (existsSync(outPath)) rmSync(outPath);
		try {
			await run(EXE, [
				...withId(['dump'], 'test-cli-cs'), '--url', base, '--access-token', TEST_ACCESS_TOKEN, '--out', outName,
			], { cwd });
			assert.ok(existsSync(outPath), '出力ファイルが作られていない');
		} finally {
			if (existsSync(outPath)) rmSync(outPath);
		}
	});

	/*
	 * 【なぜ必要か】
	 * rename は 4 テーブル 7 か所を書き換える。2 本で下見の出し方や確認の求め方が
	 * 食い違うと、片方だけが「何が書き換わるか」を出さないまま実行することになる
	 * （i260909-02）。実行はせず、下見と確認までを突き合わせる。
	 */
	test('rename の下見と確認の求め方が node 版と揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const target = 'test-cli-rename';
		await viaNode(['say', '付け替えの下見'], target);
		await viaNode(['say', `@${target} 本文でも名指しする`], 'test-cli-rename-writer');

		const args = ['rename', 'connector', `:${target}:`, ':test-cli-renamed:'];
		/*
		 * 確認に空行を渡して中止させる。実行はしない（下見と確認の形だけを見る）。
		 *
		 * 同期の execFileSync は使えない。このテストはサーバーを同じ Node の
		 * プロセスで動かしているため、同期呼び出しがイベントループを止めて
		 * しまい、子プロセスの下見のリクエストに応答できずタイムアウトする
		 * （実測。30 秒待って stdout が空になった）。
		 *
		 * execFile（非同期）は input オプションを持たないので、spawn で
		 * 標準入力に書く。
		 */
		const withInput = (cmd, cmdArgs) =>
			new Promise((resolve) => {
				const child = spawn(cmd, cmdArgs);
				let stdout = '';
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (c) => { stdout += c; });
				child.stdin.write('\n');
				child.stdin.end();
				child.once('exit', (code) => resolve({ stdout, code }));
			});

		const fromNode = await withInput(process.execPath, [
			NODE_CLI, ...withId(args, 'test-cli-cs'), '--url', base, '--access-token', TEST_ACCESS_TOKEN,
		]);
		const fromExe = await withInput(EXE, [
			...withId(args, 'test-cli-cs'), '--url', base, '--access-token', TEST_ACCESS_TOKEN,
		]);

		assert.equal(shape(fromExe.stdout), shape(fromNode.stdout), '下見の出力が違う');
		assert.equal(fromExe.code, fromNode.code, '中止したときの終了コードが違う');
		assert.match(fromNode.stdout, /本文の @test-cli-rename/, '本文の件数が出ていない');
		assert.match(fromNode.stdout, /中止しました/, '中止していない');
	});

	test('who の出力が揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const { stdout: fromNode } = await viaNode(['who']);
		const { stdout: fromExe } = await viaExe(['who']);

		// 参加者の並びは最終アクセス順で動くため、行数と見出しだけを見る
		assert.equal(shape(fromExe).split('\n')[0], shape(fromNode).split('\n')[0]);
		assert.equal(shape(fromExe).split('\n').length, shape(fromNode).split('\n').length);
	});

	test('初めての wait は案内を出してすぐ終わる（i260909-01）', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const { stdout: fromNode } = await viaNode(['wait'], 'test-cli-first-node');
		const { stdout: fromExe } = await viaExe(['wait'], 'test-cli-first-exe');

		for (const stdout of [fromNode, fromExe]) {
			assert.match(stdout, /初めての接続です/);
			assert.match(stdout, /recent --find "ルール"/);
			assert.match(stdout, /recent --since-day 1/);
			assert.match(stdout, /カーソルを立てました。改めて wait を実行してください。/);
			assert.doesNotMatch(stdout, /pid \d+ で待受け中/, '即終わらず、通常の待受けに入ってしまっている');
		}
	});

	/*
	 * 【なぜ必要か】
	 * 初めての接続案内のあとの wait=0 poll が、指定した room 全体（既存
	 * カーソルを持つルームも含む）に対して行われると、既存ルームの未読の
	 * 新着まで取得したうえで画面に出さずカーソルだけ最新へ進めてしまう。
	 * node 版・C# 版とも同じ穴を持っていた（実際に他プロジェクトから
	 * 報告があった事故）
	 */
	test('初めてのルームと混ぜても、既存ルームの未読は消えない（両方で確認）', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		for (const [via, id] of [[viaNode, 'test-cli-mixed-node'], [viaExe, 'test-cli-mixed-exe']]) {
			await via(['join'], id);
			await via(['wait', '--wait-sec', '1'], id); // public のカーソルを立てる

			await viaNode(['say', 'これは読めるはず'], 'test-cli-mixed-writer');

			// 初めてのルームを混ぜて待つ。案内を出して終わる 1 回を消費する
			await via(['wait', '-r', 'public,sandbox-cli-mixed', '--wait-sec', '1'], id);

			const { stdout } = await via(['wait', '-r', 'public,sandbox-cli-mixed', '--wait-sec', '3'], id);
			assert.match(stdout, /これは読めるはず/, `${id} で既存ルームの未読が消えている`);
		}
	});

	test('wait が新着なしで正常に終わる', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		// 1 回目は初めての接続なので、案内を出してカーソルだけ立てて即終わる
		// （i260909-01）。2 回目でようやく普通に待つので、そちらを見る
		await viaExe(['wait', '--wait-sec', '1']);
		const { stdout } = await viaExe(['wait', '--wait-sec', '1']);

		assert.match(stdout, /新着なし（1 秒待機/, '待ち切ったときの行が違う');
	});

	test('waiters の出力が揃う', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		/*
		 * waiters はサーバーに繋がない。手元のプロセスを見るだけなので、
		 * --port も --url も渡さずに動くことが要点。C# 版は以前、コマンドを
		 * 問わず先に接続先を要求していて、waiters が使えなかった。
		 *
		 * 2 つの出力をそのまま突き合わせることはできない。呼ぶ間に他のテストが
		 * 待受けを立てたり終えたりするので、本数が変わる。代わりに、両方が
		 * 同じ書式に従っていることを見る。書式がずれれば、どちらかが落ちる。
		 */
		/*
		 * 接続先は省略できない（既定値を持たない）。本番の基準を渡して数える。
		 * テスト用サーバーの分は基準が違うので、この一覧には出ない。
		 */
		const basis = ['-p', String(DEFAULT_PORT), '-r', DEFAULT_ROOM];
		const fromNode = await run(process.execPath, [NODE_CLI, 'waiters', ':test-cli-cs:', ...basis], {
			env: { ...process.env },
		});
		const fromExe = await run(EXE, ['waiters', ':test-cli-cs:', ...basis], { env: { ...process.env } });

		const BASIS = /^ {2}:\d+ を見ている待受け$/;
		const HEADER = /^ {2}ID {2,}張り方 {2,}いつから {2,}経過 {2,}ルーム {2,}pid$/;
		const ROW = /^[* ] \S+ +\S+ +\d{2}:\d{2}:\d{2} +\d+:\d{2} +\S.* +\d+$/;
		const SUMMARY = /^ {2}自分（[A-Za-z0-9_-]+）: \d+ 本 \/ この場所に \d+ 本$/;
		/*
		 * 集計のあとに付く行。別の場所・他プロジェクト・次にやること。
		 * 「次を張ってください:」のあとは 4 字下げのコマンドが 1 行続く
		 */
		const NOTE = /^( {2}(自分の分が別の場所に|他に |.+ を二重に張って|.+ の待受けがありません|すべて覆えています)| {4}aichat wait )/;

		for (const [name, out] of [['node 版', fromNode.stdout], ['C# 版', fromExe.stdout]]) {
			const lines = out.split(/\r?\n/).filter((l) => l !== '');

			if (lines[0] === '待受けは走っていません。') {
				assert.match(lines[1], NOTE, `${name}: 0 本のときの案内が無い`);
				continue;
			}

			assert.match(lines[0], BASIS, `${name}: どこを見ているかの行が無い`);

			const summaryAt = lines.findIndex((l) => SUMMARY.test(l));
			assert.ok(summaryAt > 0, `${name}: 集計の行が無い`);

			// 基準の次は、見出し＋行か「ありません。」のどちらか
			if (lines[1] === '  ありません。') {
				assert.equal(summaryAt, 2, `${name}: 0 本なのに行がある`);
			} else {
				assert.match(lines[1], HEADER, `${name}: 見出しの形が違う`);
				for (const row of lines.slice(2, summaryAt)) {
					assert.match(row, ROW, `${name}: 行の形が違う`);
				}
			}

			for (const note of lines.slice(summaryAt + 1)) {
				assert.match(note, NOTE, `${name}: 集計の後ろに知らない行がある`);
			}
		}
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

	/*
	 * 【なぜ必要か】
	 * waiters の -r はカンマで分割するだけで、文字種の検証をしていなかった。
	 * waiters はサーバーに繋がないため、サーバー側の room_id 検証を経由できず、
	 * シングルクォート等の不正な文字を含む値がそのまま「ルーム名」として
	 * 扱われていた（実際に指摘があった）。node 版・C# 版とも直した
	 */
	test('waiters の -r に不正な文字を含むと両方が同じように止める', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		const fail = async (fn) => {
			try {
				await fn();
				return null;
			} catch (err) {
				return err;
			}
		};

		const bad = "'public,ai-chat-lite'";
		const fromNode = await fail(() => viaNode(['waiters', '-r', bad]));
		const fromExe = await fail(() => viaExe(['waiters', '-r', bad]));

		assert.ok(fromNode, 'node 版が止まっていない');
		assert.ok(fromExe, 'C# 版が止まっていない');
		assert.equal(fromNode.code, 2);
		assert.equal(fromExe.code, 2, '終了コードが 2 でない');
		assert.equal(shape(fromExe.stderr), shape(fromNode.stderr), '案内の文が違う');
	});

	test('使い方を誤ったときの終了コードが揃っている', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		/*
		 * 終了コードは呼ぶ側の判断材料になる。2 は「自分の書き方が悪い」、
		 * 3 は「向こうが止まっている」。片方だけ違う値を返すと、同じ誤りなのに
		 * 呼ぶ側の扱いが変わる。
		 *
		 * 実際に say の本文を書き忘れたときだけ食い違っていた（node 1 / C# 2）。
		 * 出力の文が同じでも終了コードは揃わないので、別に見る必要がある。
		 */
		const cases = [
			{ name: '本文を書かない say', args: ['say'], expected: 2 },
			{ name: 'ID を囲まない', args: ['join', 'test-cli-cs'], expected: 2, bare: true },
			{ name: 'ID に使えない文字', args: ['join', ':te st:'], expected: 2, bare: true },
			{ name: '待つ長さを 2 つ', args: ['wait', '--wait-hour', '1', '--wait-min', '30'], expected: 2 },
			{ name: '戻す番号が数でない', args: ['restore', 'あ'], expected: 2 },
			{ name: '知らない片付け方', args: ['archive', 'nope', 'x'], expected: 2 },
		];

		const fail = async (file, args) => {
			try {
				await run(file, [...args, '--url', base, '--access-token', TEST_ACCESS_TOKEN], {
					env: { ...process.env },
				});
				return null;
			} catch (err) {
				return err;
			}
		};

		for (const c of cases) {
			// bare は ID の形そのものを試すので、helper に差し込ませない
			const args = c.bare ? c.args : withId(c.args, 'test-cli-cs');
			const fromNode = await fail(process.execPath, [NODE_CLI, ...args]);
			const fromExe = await fail(EXE, args);

			assert.ok(fromNode, `node 版が止まっていない: ${c.name}`);
			assert.ok(fromExe, `C# 版が止まっていない: ${c.name}`);
			assert.equal(fromNode.code, c.expected, `node 版の終了コードが違う: ${c.name}`);
			assert.equal(fromExe.code, c.expected, `C# 版の終了コードが違う: ${c.name}`);
			assert.equal(shape(fromExe.stderr), shape(fromNode.stderr), `案内の文が違う: ${c.name}`);
		}
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

		assert.equal(exported.schema, 4, 'schema が上がったら C# 側も合わせる');
		assert.equal(exported.options.length, options.OPTIONS.length);
		assert.equal(exported.commands.length, options.COMMANDS.length);

		/*
		 * サーバーに繋がないコマンドの印。ここが渡らないと C# 版だけ接続先を
		 * 要求し、どちらの環境かの印も出す側と出さない側で食い違う
		 */
		const offline = exported.commands.filter((c) => c.offline).map((c) => c.name);
		assert.deepEqual(offline, ['waiters']);

		// ID の囲み・使える文字・待受けを探す式も、出どころは options.mjs 1 か所にする
		assert.equal(exported.id_wrap, options.ID_WRAP);
		assert.equal(exported.id_pattern, options.ID_PATTERN);
		assert.equal(exported.waiter_pattern, options.WAITER_PATTERN);
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

/*
 * TryGet（C# 版だけの経路）が Environment.Exit を貫通させないかを確かめる。
 *
 * node 版には対応する道具が無い（node 版の announceEnv はもともと素直に
 * try/catch で諦めるだけなので、この穴が最初から無い）。node 版との
 * 突き合わせではなく、C# 版だけの単体テストになる。
 */
describe('TryGet は Environment.Exit を貫通させない（レビュー #20）', () => {
	/*
	 * /api/version だけ 404 を返し、他のパスは正常な応答を返す偽サーバーを立てる。
	 *
	 * AnnounceEnv は TryGet 経由で /api/version を叩く。ここが 503 以外の
	 * エラー応答（404 など）を受けたとき、直しの前は SendOnce が
	 * Environment.Exit(1) を呼び、TryGet の catch を素通りして即終了していた
	 * （ポートを取り違えて別サーバーに繋いだときに起きる）。
	 *
	 * 直っていれば、AnnounceEnv は黙って諦め、本来のコマンド（who）が
	 * 続けて走る。誤ったポートでも本来のコマンドまでは辿り着くことを見る。
	 */
	let fakeServer;
	let fakeBase;

	before(async () => {
		fakeServer = createServer((req, res) => {
			if (req.url.startsWith('/api/version')) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: '無い道' }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ connectors: [] }));
		});
		await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
		fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;
	});

	after(() => new Promise((resolve) => fakeServer.close(resolve)));

	test('/api/version が 404 でも、本来のコマンドまで辿り着く', async (t) => {
		if (!built) return t.skip('aichat.exe が無い');

		// 直る前は who まで辿り着かず exit 1 になるため、execFile が reject する。
		// reject でも stdout/stderr は積まれているので、そこから中身を見る
		const { stdout, stderr } = await run(EXE, ['who', '-u', fakeBase]).catch((err) => err);
		assert.match(stdout ?? '', /まだ誰も参加していません/, `who まで辿り着いていない\n${stderr}`);
		// AnnounceEnv は諦めたときに何も出さない（node 版と同じ「黙って諦める」）
		assert.doesNotMatch(stderr ?? '', /エラー \(404\)/, 'AnnounceEnv の 404 が外に漏れている');
	});
});

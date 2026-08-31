import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { OPTIONS, COMMANDS, ADMIN_COMMANDS, REMOVED, WAIT_UNITS, DEFAULT_WAIT_SEC } from '../src/client/options.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

/*
 * usage() が実際に出す文字列と、オプションの定義が一致しているかを見る。
 *
 * 一覧を手で 2 か所に書いていた頃、--retry-count が usage() から抜けていた。
 * 定義を増やしても表示に出ない・表示にあるのに定義が無い、という
 * どちらのずれもここで落ちる。期待値を手で並べないのが要点で、
 * 同じ options.mjs を読んで突き合わせる。
 *
 * usage() は接続しないので、サーバーを立てる必要がない。
 */
const { stdout: HELP } = await run(process.execPath, [CLIENT], { env: { ...process.env } });

/** 表示に出ている長い形。--wait 480 のような値は拾わない */
const shownLongs = new Set([...HELP.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));

/** 表示に出ている短い形 */
const shownShorts = new Set([...HELP.matchAll(/(?:^|\s)-([a-z])(?=\s|$)/gm)].map((m) => m[1]));

describe('usage() とオプションの定義', () => {
	test('定義したオプションはすべて表示に出る', () => {
		for (const o of OPTIONS) {
			assert.ok(shownLongs.has(o.long), `--${o.long} が usage() に出ていない`);
		}
	});

	test('表示に出ている長い形はすべて定義にある', () => {
		// 説明文の中で触れているだけのものも拾うため、定義に無いものは列挙して示す
		const defined = new Set(OPTIONS.map((o) => o.long));
		const unknown = [...shownLongs].filter((name) => !defined.has(name));

		assert.deepEqual(unknown, [], `定義に無い名前が usage() に出ている: ${unknown.join(' ')}`);
	});

	test('定義した短い形はすべて表示に出る', () => {
		for (const o of OPTIONS.filter((x) => x.short)) {
			assert.ok(shownShorts.has(o.short), `-${o.short} が usage() に出ていない（--${o.long}）`);
		}
	});

	test('短い形は重複しない', () => {
		const shorts = OPTIONS.filter((o) => o.short).map((o) => o.short);
		assert.equal(new Set(shorts).size, shorts.length, `短い形が重複している: ${shorts.join(' ')}`);
	});

	test('コマンドはすべて表示に出る', () => {
		for (const c of [...COMMANDS, ...ADMIN_COMMANDS]) {
			assert.match(HELP, new RegExp(`^ {2}${c.name}(\\s|$)`, 'm'), `${c.name} が usage() に出ていない`);
		}
	});

	test('コマンドだけのオプションは、そのコマンドの下に出る', () => {
		const lines = HELP.split('\n');
		for (const o of OPTIONS.filter((x) => x.cmd)) {
			const cmdAt = lines.findIndex((l) => new RegExp(`^ {2}${o.cmd}(\\s|$)`).test(l));
			const optAt = lines.findIndex((l) => l.includes(`--${o.long}`) && /^ {4,}/.test(l));

			assert.ok(cmdAt >= 0, `${o.cmd} の行が見つからない`);
			assert.ok(optAt > cmdAt, `--${o.long} が ${o.cmd} の下に出ていない`);
		}
	});

	test('廃止したオプションは表示に出ない', () => {
		for (const name of REMOVED.keys()) {
			assert.ok(!shownLongs.has(name), `--${name} が usage() に残っている`);
		}
	});

	test('廃止した環境変数の案内が残っていない', () => {
		// AICHAT_ID と AICHAT_URL は引数に置き換えた。案内が残ると古い形を試させてしまう
		assert.doesNotMatch(HELP, /AICHAT_ID/);
		assert.doesNotMatch(HELP, /AICHAT_URL/);
	});

	test('待つ長さの単位はオプションとしても定義されている', () => {
		// WAIT_UNITS と OPTIONS が別々の表なので、片方だけ増やせるとずれる
		for (const u of WAIT_UNITS) {
			assert.ok(
				OPTIONS.some((o) => o.long === u.long),
				`${u.long} が OPTIONS に無い`
			);
		}
	});

	test('既定の待ち時間が表示に出る', () => {
		assert.match(HELP, new RegExp(`既定 ${DEFAULT_WAIT_SEC / 3600} 時間`));
	});

	test('コマンドを付けなくても使い方が出て、終了コードは 0', async () => {
		const { stdout } = await run(process.execPath, [CLIENT], { env: { ...process.env } });
		assert.match(stdout, /^ai-chat-lite クライアント/);
	});

	test('-h と --help で使い方が出る。コマンドを付けても出る', async () => {
		for (const args of [['-h'], ['--help'], ['wait', '-h'], ['say', '--help']]) {
			const { stdout } = await run(process.execPath, [CLIENT, ...args], { env: { ...process.env } });
			assert.match(stdout, /^ai-chat-lite クライアント/, `${args.join(' ')} で使い方が出ない`);
			assert.match(stdout, /どのコマンドにも付けられるもの/, `${args.join(' ')} の出力が途中で切れている`);
		}
	});

	test('-h は接続先や名乗る ID が無くても出る', async () => {
		// 使い方を見るために接続先を書かせるのは筋が通らない
		const { stdout } = await run(process.execPath, [CLIENT, 'wait', '-h'], { env: { ...process.env } });
		assert.match(stdout, /接続先: \(未指定\)/);
		assert.match(stdout, /名乗る ID: \(未指定\)/);
	});

	test('知らないコマンドは使い方を出して終了コード 1', async () => {
		try {
			await run(process.execPath, [CLIENT, 'そんなコマンドはない'], { env: { ...process.env } });
			assert.fail('エラーにならなかった');
		} catch (err) {
			assert.equal(err.code, 1);
			assert.match(err.stdout, /^ai-chat-lite クライアント/);
		}
	});

	test('説明の桁が揃っている', () => {
		/*
		 * 日本語は半角 2 つ分の幅で表示される。文字数で揃えると日本語を含む行だけ
		 * 右にずれる。表示幅で数えているかを、実際の出力で確かめる
		 */
		const widthOf = (s) => {
			let w = 0;
			for (const ch of s) w += /[ -~]/.test(ch) ? 1 : 2;
			return w;
		};

		const optionLines = HELP.split('\n').filter((l) => /^\s{2,}--/.test(l));
		assert.ok(optionLines.length >= OPTIONS.length, `オプションの行が拾えていない（${optionLines.length} 行）`);

		for (const line of optionLines) {
			const m = line.match(/^(.*?) {2,}(\S.*)$/);
			if (!m) continue;
			assert.ok(widthOf(m[1]) < 40, `桁からはみ出している（幅 ${widthOf(m[1])}）: ${line}`);
		}
	});
});

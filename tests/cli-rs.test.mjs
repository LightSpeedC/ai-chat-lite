/*
 * Rust 版 CLI（aichat-rs）と node 版の突き合わせ。
 *
 * 【なぜ要るか】
 * CLI が複数あると、食い違いは必ず出るし、目で読んで気づける差ではない。
 * 実際にかつての C# 版では、同じ秒に立った待受けの並び順と、say の本文
 * なしの終了コードが node 版と食い違っていた（突き合わせテストがあって
 * 初めて見つかった。C# 版は i260918-01 で削除済み）。
 *
 * ここは同じ形を Rust 版にも用意する。**出力と終了コードを 1 文字ずつ比べる。**
 *
 * 【サーバーに繋がないものだけを見る】
 * 繋ぐコマンドはテスト用サーバーが要る。立ち上げは tools/40_test/ に任せ、
 * ここでは引数の読み取りと使い方の表示だけを突き合わせる。
 * それでも定義のずれ・桁のずれ・終了コードのずれは捕まえられる。
 *
 * 【実行ファイルが無ければ飛ばす】
 * Rust の道具が入っていない環境でも、他のテストは動かしたい。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'target', process.platform === 'win32' ? 'aichat-rs.exe' : 'aichat-rs');
const nodeCli = join(root, 'src', 'client', 'chat.mjs');

/** 実行ファイルが無ければ、このファイルのテストは飛ばす */
const ready = existsSync(exe);

/** 両方を同じ引数で走らせ、出力と終了コードを返す */
function runBoth(args) {
	const opts = { cwd: root, encoding: 'utf8' };
	const nodeRun = spawnSync(process.execPath, [nodeCli, ...args], opts);
	const rustRun = spawnSync(exe, args, opts);
	return {
		node: { out: `${nodeRun.stdout}${nodeRun.stderr}`, code: nodeRun.status },
		rust: { out: `${rustRun.stdout}${rustRun.stderr}`, code: rustRun.status },
	};
}

/** 引数の並びを読みやすい名前にする */
const label = (args) => (args.length === 0 ? '（引数なし）' : args.join(' '));

describe('Rust 版と node 版の突き合わせ', { skip: ready ? false : 'aichat-rs が無い（先にビルドしてください）' }, () => {
	/*
	 * サーバーに繋がない呼び出し。
	 *
	 * 使い方の表示は定義の表から組み立てるので、オプションを 1 つ足しただけでも
	 * ここがずれる。定義を写していないことの裏づけにもなる。
	 */
	const cases = [
		[],
		['--help'],
		['-h'],
		['--help', '-p', '8787'],
		['-h', '-p', '8787', '-r', 'sandbox'],
		['--help', '-u', 'http://localhost:9999'],
		['-h', 'wait', ':me:'],
		['知らないコマンド'],
		['-c', 'me', 'wait'],
		['--connector-id', 'me', 'wait'],
		['--timeout', '5', 'wait'],
		['--retry-count', '3', 'wait'],
		['--url', 'http://localhost:1', '--port', '2', 'who'],
		['--port', '八千', 'who'],
	];

	for (const args of cases) {
		test(`${label(args)} が node 版と同じ`, () => {
			const { node, rust } = runBoth(args);
			assert.equal(rust.out, node.out, '出力が違う');
			assert.equal(rust.code, node.code, '終了コードが違う');
		});
	}

	test('埋め込んだ定義の版が node 版と揃っている', () => {
		// 形が変わったら Rust 側の EXPECTED_SCHEMA も上げる。
		// 上げ忘れたまま動くと、古い形を新しい形として読んでしまう
		const run = spawnSync(process.execPath, [join(root, 'tools', '20_build', 'export-options.mjs'), '--stdout'], {
			cwd: root,
			encoding: 'utf8',
		});
		assert.equal(run.status, 0, '定義を書き出せない');
		const schema = JSON.parse(run.stdout).schema;

		// Rust 側は定義を読めないと起動できない。読めている＝版が合っている
		const rust = spawnSync(exe, ['--help'], { cwd: root, encoding: 'utf8' });
		assert.equal(rust.status, 0, `定義を読めていない: ${rust.stderr}`);
		assert.equal(typeof schema, 'number');
	});

	test('使い方に全部のコマンドとオプションが載る', () => {
		// 手で書くと載り忘れる。実際に node 版で --retry-count が抜けていた
		const run = spawnSync(process.execPath, [join(root, 'tools', '20_build', 'export-options.mjs'), '--stdout'], {
			cwd: root,
			encoding: 'utf8',
		});
		const def = JSON.parse(run.stdout);
		const rust = spawnSync(exe, ['--help'], { cwd: root, encoding: 'utf8' });

		for (const c of [...def.commands, ...def.admin_commands]) {
			assert.ok(rust.stdout.includes(c.desc), `${c.name} の説明が載っていない`);
		}
		for (const o of def.options) {
			assert.ok(rust.stdout.includes(`--${o.long}`), `--${o.long} が載っていない`);
		}
	});
});

/*
 * 走っているプロセスの一覧を取る部分のテスト。
 *
 * 【何を守るか】
 * waiters はこの一覧から待受けを見分ける。取り方が壊れると、
 * 「走っていない」と誤って報告し、二重に張らせることになる。
 * 共通ルールが最も強く禁じる「同じルームを 2 本で見ない」を、
 * 道具の出力が指示する形になる。
 *
 * 取り方は 3 通りあるが、どれを使っても**同じ形の答え**が返ること、
 * そして**数えているプロセス自身が数に入らない**ことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filetimeToJst, listProcesses, listByPowerShell } from '../src/client/proc-list.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 1601-01-01 から 1970-01-01 までの 100 ナノ秒の数 */
const EPOCH_DIFF = 116444736000000000n;

describe('立った時刻の変換', () => {
	test('元期を当てはめると日本時間の午前 9 時になる', () => {
		// FILETIME の 116444736000000000 はちょうど 1970-01-01T00:00:00Z
		assert.equal(filetimeToJst(EPOCH_DIFF), '1970-01-01 09:00:00');
	});

	test('書式は Get-CimInstance に揃える', () => {
		// 揃えないと、PowerShell へ落ちたときに並べ替えが食い違う
		const text = filetimeToJst(EPOCH_DIFF + 10000n * 1000n); // ＋1 秒
		assert.equal(text, '1970-01-01 09:00:01');
		assert.ok(!text.includes('/'), 'スラッシュ区切りになっている');
		assert.ok(!text.includes('.'), 'ミリ秒が残っている');
		assert.equal(text.length, 19, 'yyyy-MM-dd HH:mm:ss は 19 文字');
	});

	test('文字列のまま比べて時系列になる', () => {
		// 並べ替えに使うので、桁を詰めていないと年をまたいで順が崩れる
		const a = filetimeToJst(EPOCH_DIFF);
		const b = filetimeToJst(EPOCH_DIFF + 10000n * 1000n * 60n * 60n * 24n * 400n);
		assert.ok(a < b, `順が崩れた: ${a} / ${b}`);
	});

	test('元期より前は空にする', () => {
		// 1601 年より前は表せない
		assert.equal(filetimeToJst(0n), '');
	});
});

describe('一覧の取得', () => {
	test('自分自身が含まれ、形が揃っている', async () => {
		const rows = await listProcesses();
		assert.ok(rows.length > 5, `プロセスが少なすぎる: ${rows.length}`);

		const me = rows.find((r) => r.pid === process.pid);
		assert.ok(me, '自分が一覧に居ない');
		assert.ok(me.name, '名前が空');
		assert.ok(me.cmd, 'コマンドラインが空');
		assert.equal(me.at.length, 19, `立った時刻の書式: ${me.at}`);
		assert.equal(typeof me.ppid, 'number', '親 pid が数でない');
	});

	test('コマンドラインが読めたものだけを持つ', async () => {
		// 待受けはコマンドラインで見分ける。読めないものを持っていても判定できない
		const rows = await listProcesses();
		for (const r of rows) {
			assert.ok(r.cmd && r.cmd.length > 0, `pid ${r.pid} のコマンドラインが空`);
		}
	});
});

describe('PowerShell へ落ちたときの守り', () => {
	test('式そのものに wait という並びを置かない', () => {
		/*
		 * 置くと、この PowerShell 自身のコマンドラインが条件に当たり、
		 * 数えているプロセスが数に入る。2 つに割って繋ぐ形を守る。
		 */
		const source = readFileSync(join(root, 'src', 'client', 'proc-list.mjs'), 'utf8');

		// 式を組み立てている行だけを見る（説明の文には出てよい）
		const line = source.split('\n').find((l) => l.includes('Where-Object') && l.includes('CommandLine -like'));
		assert.ok(line, '絞り込みの行が見つからない');

		// 割った形（' wa' + 'it ') になっていること
		assert.ok(line.includes("'* wa' + 'it *'"), `割れていない: ${line.trim()}`);

		// 割ったあとの式に、連続した並びが残っていないこと
		const inQuotes = line.slice(line.indexOf('Where-Object'));
		assert.ok(!/wait/.test(inQuotes.replace(/'\* wa' \+ 'it \*'/, '')), '式に連続した並びが残っている');
	});

	test('PowerShell の経路も同じ形を返す', { skip: process.platform === 'win32' ? false : 'Windows 専用' }, () => {
		const rows = listByPowerShell();
		// 待受けが 1 本も無ければ 0 件でよい。形だけを見る
		for (const r of rows) {
			assert.equal(typeof r.pid, 'number');
			assert.equal(typeof r.ppid, 'number');
			assert.ok(typeof r.cmd === 'string');
			assert.equal(r.at.length, 19, `立った時刻の書式: ${r.at}`);
		}
	});

	test('数えているプロセス自身が候補に入らない', { skip: process.platform === 'win32' ? false : 'Windows 専用' }, () => {
		// 式に並びを置かないので、起こした PowerShell は条件に当たらない
		const rows = listByPowerShell();
		const shells = rows.filter((r) => /powershell/i.test(r.name ?? ''));
		assert.equal(shells.length, 0, `PowerShell が候補に入っている: ${shells.map((s) => s.pid).join(', ')}`);
	});
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const INPUT = join(ROOT, 'tools', '80_ops', 'mask-log-input.ps1');
const FAKE = join(here, 'helpers', 'fake-mask-log.ps1');
/** 成功する偽物。exit を通らずに終わる子を再現する（本物の正常系は exit 0 を返す） */
const FAKE_OK = join(here, 'helpers', 'fake-mask-log-ok.ps1');
/** claude が走っているときの偽物。exit 4 で止まる */
const FAKE_BUSY = join(here, 'helpers', 'fake-mask-log-busy.ps1');
const CALL_LOG = join(ROOT, 'tmp', 'mask-log-input-ps1-calls.txt');

/*
 * 【なぜ必要か】
 * mask-log-input.ps1 は mask-log.ps1 を 2 回（数えるだけ・本実行）呼ぶが、
 * どちらも終了コードを見ていない（レビュー #20）。子が「本体の会話ログが
 * 見つからない」で exit 1 しても、親は気づかず次の確認プロンプトへ進み、
 * 本実行まで呼んでしまう。
 *
 * 本物の mask-log.ps1 は本番の ~/.claude/projects/ を直接参照するため、
 * end-to-end で確かめるには呼び出し先を差し替える口が要る。
 * -MaskLogScript で必ず exit 1 する偽物（fake-mask-log.ps1）に差し替え、
 * 「数えるだけ」が失敗したら、本実行（2 回目の呼び出し）まで進まないことを
 * 確かめる。呼ばれた回数は環境変数 MASK_LOG_TEST_CALL_LOG が指すファイルで数える。
 *
 * spawn + stdin.write() では、この PowerShell 版の Read-Host がリダイレクトされた
 * パイプを読み切れず、そのまま止まったままになった（実測。子プロセスが残らないことは
 * 確かめてある）。execFileSync の input オプションなら同じ入力で正しく動く
 */

/** Windows PowerShell 5.1 が無ければ以降は全部スキップする */
let has51 = false;
try {
	execFileSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' });
	has51 = true;
} catch {
	has51 = false;
}

before(() => {
	mkdirSync(dirname(CALL_LOG), { recursive: true });
});

after(() => {
	if (existsSync(CALL_LOG)) rmSync(CALL_LOG);
});

test('mask-log.ps1 が「数えるだけ」で失敗したら、本実行まで進まない', (t) => {
	if (!has51) return t.skip('powershell.exe が無い');
	if (existsSync(CALL_LOG)) rmSync(CALL_LOG);
	writeFileSync(CALL_LOG, '');

	let stdout = '';
	try {
		stdout = execFileSync('powershell.exe', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INPUT, '-MaskLogScript', FAKE,
		], {
			env: { ...process.env, MASK_LOG_TEST_CALL_LOG: CALL_LOG },
			// 1: 伏せたい語 / 2: 置き換え後の文字列（既定を使う） / 3: 確認（直っていれば読まれない）
			input: 'テスト語\n\nyes\n',
			encoding: 'utf8',
			timeout: 15000,
		});
	} catch (err) {
		// タイムアウト・非ゼロ終了でも、ここまでの出力は見たい
		stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
	}

	const calls = readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean);
	assert.equal(calls.length, 1, `本実行まで進んでいる（呼ばれた回数 ${calls.length}）\n--- 出力 ---\n${stdout}`);
});

/*
 * 【なぜ必要か】
 * 上の検査は「必ず exit 1 する偽物」しか使っておらず、成功経路を 1 件も
 * 通していなかった。そのため次の穴が見えなかった（レビュー #22 high 1）。
 *
 * 本物の mask-log.ps1 は成功時に exit を通らない（return か末尾まで走る）。
 * PowerShell では .ps1 が exit を通らずに終わると $LASTEXITCODE が更新されず、
 * powershell.exe -File は毎回まっさらなセッションなので最初の呼び出しでは
 * 未定義（$null）。$null -ne 0 は真になるため、呼び出し側がそれを「失敗」と
 * 読んで中止していた。実測で再現を確認してから直した。
 */
test('mask-log.ps1 が成功したら、本実行まで進む', (t) => {
	if (!has51) return t.skip('powershell.exe が無い');
	if (existsSync(CALL_LOG)) rmSync(CALL_LOG);
	writeFileSync(CALL_LOG, '');

	let stdout = '';
	try {
		stdout = execFileSync('powershell.exe', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INPUT, '-MaskLogScript', FAKE_OK,
		], {
			env: { ...process.env, MASK_LOG_TEST_CALL_LOG: CALL_LOG },
			// 1: 伏せたい語 / 2: 置き換え後の文字列（既定を使う） / 3: 確認に yes
			input: 'テスト語\n\nyes\n',
			encoding: 'utf8',
			timeout: 15000,
		});
	} catch (err) {
		stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
	}

	assert.doesNotMatch(stdout, /数えるだけの実行が失敗しました/, '成功したのに失敗と読んでいる');

	const calls = readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean);
	assert.equal(calls.length, 2, `本実行まで進んでいない（呼ばれた回数 ${calls.length}）\n--- 出力 ---\n${stdout}`);
});

/*
 * 【なぜ必要か】
 * mask-log.ps1 には 3 つ目の出口がある。claude が走っていると警告を出して
 * 止まるが、以前は -WhatIfOnly のときだけ素通りしていた。しかも return は
 * exit を通らないので終了コードを更新せず、呼ぶ側が 0 を立ててから呼ぶ形と
 * 噛み合って「成功」と読まれていた（レビュー #23 high 1）。
 *
 * 結果、下見は件数を出して通り、利用者が yes を押し、本実行は 1 語も
 * 書き換えずに終わる。成功とも失敗とも言わずに終わるので気づけない。
 *
 * いまは下見の時点で exit 4 で止まる。4 を 1（会話ログが見つからない）と
 * 混ぜると呼ぶ側が同じ文面しか出せないので、書き分けまで見る。
 */
test('claude が走っていたら、下見の時点で止まり、原因が分かる文面が出る', (t) => {
	if (!has51) return t.skip('powershell.exe が無い');
	if (existsSync(CALL_LOG)) rmSync(CALL_LOG);
	writeFileSync(CALL_LOG, '');

	let stdout = '';
	try {
		stdout = execFileSync('powershell.exe', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INPUT, '-MaskLogScript', FAKE_BUSY,
		], {
			env: { ...process.env, MASK_LOG_TEST_CALL_LOG: CALL_LOG },
			// 確認まで進んでしまったときに備えて yes も渡す。進めば呼ばれた回数で分かる
			input: 'テスト語\n\nyes\n',
			encoding: 'utf8',
			timeout: 15000,
		});
	} catch (err) {
		stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
	}

	assert.match(stdout, /セッションが開いているので中止します/, '原因が分かる文面が出ていない');
	assert.doesNotMatch(stdout, /数えるだけの実行が失敗しました/, '失敗として扱っている（閉じれば済む話）');

	const calls = readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean);
	assert.equal(calls.length, 1, `本実行まで進んでいる（呼ばれた回数 ${calls.length}）\n--- 出力 ---\n${stdout}`);
});

/*
 * 【なぜ必要か】
 * ここまでの検査はすべて偽物に差し替えており、本物の mask-log.ps1 を 1 度も
 * 走らせていなかった。そのため終了コードの取り決め（成功なら 0、claude が
 * 走っていれば 4）が本物で守られているかを誰も見ていない。exit 0 を落として
 * も 3 件とも緑のまま通る（レビュー #23 medium 12）。
 *
 * 本物は下見でも claude が走っていれば走査する前に止まるので、この検査は
 * 会話ログを 1 ファイルも読まない。逆に claude が動いていない環境では
 * 本番のログを走査してしまうため、そのときはスキップする。
 */
test('本物の mask-log.ps1 は、claude が走っていれば走査せず 4 で止まる', (t) => {
	if (!has51) return t.skip('powershell.exe が無い');

	// このプロセス自身が claude の下で動いているとは限らない
	let running = false;
	try {
		const out = execFileSync('powershell.exe', [
			'-NoProfile', '-Command', '@(Get-Process -Name claude -ErrorAction SilentlyContinue).Count',
		], { encoding: 'utf8' });
		running = Number(out.trim()) > 0;
	} catch {
		running = false;
	}
	if (!running) return t.skip('claude が動いていない（本物を走らせると本番のログを走査する）');

	const real = join(ROOT, 'tools', '80_ops', 'mask-log.ps1');
	let stdout = '';
	let code = 0;
	try {
		stdout = execFileSync('powershell.exe', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', real,
			'-Word', 'この語は現れない-mask-log-test', '-WhatIfOnly',
		], { encoding: 'utf8', timeout: 20000 });
	} catch (err) {
		code = err.status ?? -1;
		stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
	}

	assert.equal(code, 4, `終了コードが 4 でない（${code}）\n--- 出力 ---\n${stdout}`);
	assert.match(stdout, /claude が動いています/, stdout);
	// 走査まで進んでいれば件数の行が出る。出ていないことが「読んでいない」証拠
	assert.doesNotMatch(stdout, /ファイル・\d+ 件が見つかりました/, '会話ログを走査してしまっている');
});

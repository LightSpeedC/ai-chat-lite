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

/*
 * 試験を一括で流すランチャ (tools/40_test/run-tests.ps1) の時間の上限と後始末。
 *
 * 共通ルール「試験には時間の上限を付ける」に従う。1 本が止まると一括実行の全体が止まり、
 * 試験が残したプロセスは次の試験と取り違えられる。材料の試験を tmp/ に作って、ランチャに流させる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
// 残ったプロセスをコマンド行で探すための目印。探す式に同じ語がそのまま出ないよう割って繋ぐ
const MARK = 'runtests-' + 'leftover-' + process.pid;

function prepare() {
	const dir = join(root, 'tmp', `run-tests-ps1-${process.pid}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'pass.test.mjs'), "import { test } from 'node:test';\ntest('通る', () => {});\n");
	writeFileSync(join(dir, 'hang.test.mjs'), "import { test } from 'node:test';\ntest('終わらない', () => new Promise(() => setInterval(() => {}, 1000)));\n");
	// 子を切り離して残し、自分は通って終わる
	writeFileSync(
		join(dir, 'leave.test.mjs'),
		"import { test } from 'node:test';\nimport { spawn } from 'node:child_process';\n" +
			`test('子を残す', () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', '${MARK}'], { detached: true, stdio: 'ignore' }).unref(); });\n`,
	);
	return dir;
}

// Windows PowerShell 5.1 は窓のコードページで出す。psh の下では UTF-8、窓から流せば CP932 になる
function sjis(buf) {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		return new TextDecoder('shift_jis').decode(buf);
	}
}

// この試験自体が node --test の子として走っている。NODE_TEST_CONTEXT を引き継ぐと、
// ランチャの中の node --test も子として振る舞い、止まる試験が 1 秒で「合格」になる (実際に起きた)
function launcherEnv() {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	return env;
}

function leftovers() {
	const out = execFileSync('powershell', ['-NoProfile', '-Command',
		`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${MARK}*' -and $_.Name -eq 'node.exe' }).Count`,
	], { encoding: 'utf8' });
	return Number(out.trim());
}

test('時間を超えた試験は止めて時間切れとし、残したプロセスも止める', { skip: win ? false : 'Windows 専用', timeout: 120000 }, () => {
	const dir = prepare();
	try {
		const started = Date.now();
		const run = spawnSync('powershell', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', '40_test', 'run-tests.ps1'),
			'-Path', dir, '-TimeoutSec', '5',
		], { timeout: 100000, env: launcherEnv() });
		// CP932 では絵文字が ? に化けるので、語で照合する
		const out = sjis(run.stdout) + sjis(run.stderr);

		assert.ok(Date.now() - started < 60000, `上限で止まっていない: ${out}`);
		assert.match(out, /合格 pass\.test\.mjs/, `通った試験が合格になっていない: ${out}`);
		assert.match(out, /時間切れ hang\.test\.mjs/, `止まった試験が時間切れになっていない: ${out}`);
		assert.match(out, /合格 leave\.test\.mjs/, `子を残した試験が合格になっていない: ${out}`);
		assert.notEqual(run.status, 0, '時間切れがあったのに終了コードが 0');
		assert.equal(leftovers(), 0, '試験が残したプロセスが止められていない');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('すべて通れば終了コードは 0', { skip: win ? false : 'Windows 専用', timeout: 60000 }, () => {
	const dir = prepare();
	try {
		rmSync(join(dir, 'hang.test.mjs'));
		rmSync(join(dir, 'leave.test.mjs'));
		const run = spawnSync('powershell', [
			'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', '40_test', 'run-tests.ps1'),
			'-Path', dir, '-TimeoutSec', '30',
		], { timeout: 50000, env: launcherEnv() });
		assert.equal(run.status, 0, sjis(run.stdout) + sjis(run.stderr));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/*
 * CLI の待受けと waiters を測る。
 *
 * 【なぜこの 2 つか】
 * 待受けは 1 プロジェクトにつき 1 本、12 時間張りっぱなしになる。常駐するので
 * メモリがそのまま効く。waiters は待受けを張る前に毎回叩くので、遅いと
 * 張り直しのたびに待たされる。
 *
 * 【なぜ node で書くか】
 * benchmark-cli.ps1 は PowerShell で、Mac ・ Linux で動かない。Rust 版を作る
 * 動機がクロスプラットフォームなのに、測る道具が Windows 専用では筋が通らない。
 * 確保量（Private Bytes）だけは OS ごとに聞き方が違うので、取れる環境でだけ取る。
 *
 *   node tools/40_test/benchmark-waiters.mjs
 *
 * 結果は tmp/benchmark-waiters.json に書く。テスト用サーバーが立っていること。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 測る相手。動かせるものだけを並べる */
function implementations() {
	const exe = (name) => join(root, 'dist', process.platform === 'win32' ? `${name}.exe` : name);
	const client = join(root, 'src', 'client', 'chat.mjs');

	return [
		{ label: 'Rust 版', file: exe('aichat-rs'), args: [], needs: exe('aichat-rs') },
		{ label: 'node 版', file: 'node', args: [client], needs: client },
		{ label: 'bun 版', file: 'bun', args: ['run', client], needs: client },
	].filter((impl) => existsSync(impl.needs));
}

/** 待受けを何秒張って測るか */
const HOLD_SEC = 60;

/** 落ち着くのを待つ長さ */
const SETTLE_MS = 3000;

/** メモリを何回測るか */
const SAMPLES = 5;

/** waiters を測る回数 */
const CALLS = 10;

/** 捨てる回数 */
const WARMUP = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 立っているテスト用サーバーの接続先を読む */
function testServer() {
	const info = join(process.env.AICHAT_DATA ?? join(root, 'tmp', '_data'), 'server.json');
	if (!existsSync(info)) return null;
	const { port, access_token } = JSON.parse(readFileSync(info, 'utf8'));
	return { port: String(port), token: access_token ?? '' };
}

/**
 * プロセスのメモリを測る。
 *
 * 実メモリは OS を問わず取れるが、確保量は聞き方が違う。Windows だけで取る。
 * 子プロセスも合算する（node 版が中で別のプロセスを起こすことがあるため）。
 */
function memoryOf(pid) {
	if (process.platform === 'win32') {
		/*
		 * 区切りはカンマにする。PowerShell のタブはバッククォートで書くが、
		 * JavaScript のテンプレートリテラルでもバッククォートが特別な意味を持つ。
		 */
		const script =
			`$ids = @(${pid}); ` +
			// 子まで辿る。1 段で足りるが、連なっても数えられるようにしておく
			`$all = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $ids -or $_.ParentProcessId -in $ids }; ` +
			`$ws = ($all | Measure-Object WorkingSetSize -Sum).Sum; ` +
			`$pm = ($all | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 } | Measure-Object -Sum).Sum; ` +
			`"$ws,$pm,$($all.Count)"`;
		const run = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
		const [ws, pm, count] = (run.stdout ?? '').trim().split(',');
		return { rss: Number(ws) || 0, private: Number(pm) || 0, processes: Number(count) || 0 };
	}

	// Mac ・ Linux。rss は KB で返る
	const run = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
	const kb = Number((run.stdout ?? '').trim()) || 0;
	return { rss: kb * 1024, private: 0, processes: 1 };
}

/** 並びから中央値などを出す */
function summarize(values) {
	const s = [...values].sort((a, b) => a - b);
	const r2 = (n) => Math.round(n * 100) / 100;
	return {
		n: s.length,
		avg: r2(s.reduce((a, b) => a + b, 0) / s.length),
		median: r2(s[Math.floor(s.length / 2)]),
		min: r2(s[0]),
		max: r2(s[s.length - 1]),
	};
}

const toMB = (bytes) => bytes / 1024 / 1024;

/** 待受けを 1 本張って、落ち着いてからメモリを測る */
async function measureWait(impl, server) {
	const args = [
		...impl.args,
		'wait',
		':bench-mem:',
		'-p',
		server.port,
		'-a',
		server.token,
		'--wait-sec',
		String(HOLD_SEC),
	];

	/*
	 * 初めての接続は案内を出して終わる仕様（i260909-01）。
	 * 先に 1 回走らせてカーソルを立てないと、測る前に消える。
	 */
	spawnSync(impl.file, [...impl.args, 'wait', ':bench-mem:', '-p', server.port, '-a', server.token, '--wait-sec', '1'], {
		cwd: root,
		encoding: 'utf8',
	});

	const child = spawn(impl.file, args, { cwd: root, stdio: 'ignore' });
	await sleep(SETTLE_MS);

	const rss = [];
	const priv = [];
	let processes = 0;
	for (let i = 0; i < SAMPLES; i++) {
		const m = memoryOf(child.pid);
		if (m.rss > 0) {
			rss.push(toMB(m.rss));
			priv.push(toMB(m.private));
			processes = Math.max(processes, m.processes);
		}
		await sleep(500);
	}

	child.kill();
	await sleep(300);

	return {
		rss: rss.length > 0 ? summarize(rss) : null,
		private: priv.length > 0 && priv.some((v) => v > 0) ? summarize(priv) : null,
		processes,
	};
}

/** waiters を何度か叩いて、1 回あたりの時間を測る */
function measureWaiters(impl, server) {
	const args = [...impl.args, 'waiters', ':bench-mem:', '-p', server.port, '-a', server.token];

	for (let i = 0; i < WARMUP; i++) spawnSync(impl.file, args, { cwd: root, stdio: 'ignore' });

	const times = [];
	for (let i = 0; i < CALLS; i++) {
		const t = performance.now();
		const run = spawnSync(impl.file, args, { cwd: root, stdio: 'ignore' });
		if (run.status !== 0 && run.status !== null) {
			return { error: `終了コード ${run.status}` };
		}
		times.push(performance.now() - t);
	}
	return summarize(times);
}

// --- 本体 ---

const server = testServer();
if (!server) {
	console.error('テスト用サーバーが立っていません。先に node tools/40_test/start-test-server.mjs を走らせてください。');
	process.exit(1);
}

const impls = implementations();
console.log(`測る相手: ${impls.map((i) => i.label).join(' / ')}\n`);

const out = {
	measuredAt: new Date().toISOString(),
	platform: process.platform,
	settings: { holdSec: HOLD_SEC, settleMs: SETTLE_MS, samples: SAMPLES, calls: CALLS, warmup: WARMUP },
	results: [],
};

for (const impl of impls) {
	process.stdout.write(`=== ${impl.label} ===\n`);

	const mem = await measureWait(impl, server);
	const rssText = mem.rss ? `${mem.rss.avg.toFixed(2)} MB（${mem.rss.min.toFixed(2)} 〜 ${mem.rss.max.toFixed(2)}）` : '測れず';
	const privText = mem.private ? ` / 確保 ${mem.private.avg.toFixed(2)} MB` : '';
	process.stdout.write(`  待受け中の実メモリ  ${rssText}${privText}\n`);

	const waiters = measureWaiters(impl, server);
	if (waiters.error) {
		process.stdout.write(`  waiters             ${waiters.error}\n`);
	} else {
		process.stdout.write(`  waiters             中央値 ${waiters.median.toFixed(1)} ms（${waiters.min.toFixed(1)} 〜 ${waiters.max.toFixed(1)}）\n`);
	}

	out.results.push({ label: impl.label, memory: mem, waiters });
}

const dest = join(root, 'tmp', 'benchmark-waiters.json');
writeFileSync(dest, JSON.stringify(out, null, '\t') + '\n');
console.log(`\n結果を tmp/benchmark-waiters.json に書きました。`);

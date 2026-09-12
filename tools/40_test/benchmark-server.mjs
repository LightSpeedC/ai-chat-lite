/*
 * サーバーを node と bun で並べて測る。
 *
 * 測るのは 4 つ。CLI のときと同じ観点に、サーバーならではの 2 つを足した。
 *
 *   1. 起動          プロセスを作ってから待ち受けが始まるまで
 *   2. メモリ        待受けを 0 / 1 / 5 / 10 本ぶら下げたときの実メモリ
 *   3. say ・ recent 1 回あたりの往復
 *   4. 配信の遅れ    say を打ってから、ぶら下がっている全員が返るまで
 *
 * 待受けの相手として常駐するものなので、2 がいちばん効く。4 は体感に出る。
 *
 * テスト用の置き場（tmp 配下）に立てる。本番の DB には触らない。ポートは OS に
 * 空きを割り当てさせるので、番号をソースに書かない（本番へ飛ぶ事故も起きない）。
 *
 *   node tools/40_test/benchmark-server.mjs
 *
 * 結果は tmp/benchmark-server.json に書く。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest, Agent } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const probe = join(here, 'server-probe.mjs');

/** 測る相手 */
const RUNTIMES = ['node', 'bun'];

/** 待受けの本数。0 は誰もぶら下がっていない状態 */
const WAITER_COUNTS = [0, 1, 5, 10];

/** メモリを 1 条件につき何ミリ秒ぶん貯めるか（probe が 250ms ごとに報告する） */
const MEM_WINDOW_MS = 3000;

/** メモリを測る前に落ち着くのを待つ長さ */
const SETTLE_MS = 2000;

/** say ・ recent を測る回数 */
const CALLS = 200;

/** 測る前に捨てる回数 */
const WARMUP = 20;

/** recent を測るために積んでおく発言の数 */
const SEED_TOTAL = 600;

/** 配信の遅れを測る回数 */
const FANOUT_ROUNDS = 10;

/** ベンチマークで使うルーム */
const ROOM = 'bench';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OS に空きポートを 1 つ割り当ててもらう */
function freePort() {
	return new Promise((ok, ng) => {
		const s = createServer();
		s.once('error', ng);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => ok(port));
		});
	});
}

/** 昇順に並べた配列から百分位を取る */
function pct(sorted, p) {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[i];
}

/** 計測値の並びを、平均・中央値・p95・最小・最大にまとめる */
function summarize(values) {
	const s = [...values].sort((a, b) => a - b);
	const sum = s.reduce((a, b) => a + b, 0);
	const r2 = (n) => Math.round(n * 100) / 100;
	return {
		n: s.length,
		avg: r2(sum / s.length),
		median: r2(pct(s, 0.5)),
		p95: r2(pct(s, 0.95)),
		min: r2(s[0]),
		max: r2(s[s.length - 1]),
	};
}

/**
 * サーバーを 1 つ立てる。
 *
 * probe が標準出力に出す印つきの行を読んで、準備できた時刻・アクセストークン・
 * メモリの報告を受け取る。サーバー自身のログも同じ出力に混ざるので、印で選り分ける。
 */
async function startServer(runtime) {
	const dataDir = join(root, 'tmp', 'bench-server', runtime, '_data');
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });

	const port = await freePort();

	const state = { rss: 0, samples: [], collecting: false, token: '', ready: false, fatal: '' };

	const t0 = performance.now();
	const child = spawn(runtime, [probe], {
		cwd: root,
		env: { ...process.env, AICHAT_PORT: String(port), AICHAT_DATA: dataDir },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let readyAt = 0;
	const readyPromise = new Promise((ok, ng) => {
		child.once('error', ng);
		child.once('exit', (code) => {
			if (!state.ready) ng(new Error(`${runtime} が立ち上がる前に終わりました（code ${code}）${state.fatal}`));
		});

		const rl = createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			if (line.startsWith('__MEM__ ')) {
				const [, rss] = line.split(' ');
				state.rss = Number(rss);
				if (state.collecting) state.samples.push(state.rss);
				return;
			}
			if (line.startsWith('__TOKEN__ ')) {
				state.token = line.slice('__TOKEN__ '.length).trim();
				return;
			}
			if (line.startsWith('__FATAL__ ')) {
				state.fatal = line.slice('__FATAL__ '.length).trim();
				return;
			}
			if (line.startsWith('__READY__')) {
				readyAt = performance.now();
				state.ready = true;
				ok();
			}
		});
	});

	// 立ち上がらないまま待ち続けないように上限を置く
	const timeout = sleep(30000).then(() => {
		throw new Error(`${runtime} が 30 秒で立ち上がりませんでした${state.fatal ? `: ${state.fatal}` : ''}`);
	});
	await Promise.race([readyPromise, timeout]);

	return {
		runtime,
		child,
		dataDir,
		state,
		base: `http://127.0.0.1:${port}`,
		startupMs: Math.round((readyAt - t0) * 100) / 100,
	};
}

/** 立てたサーバーを止め、置き場ごと捨てる */
async function stopServer(srv) {
	srv.child.kill();
	for (let i = 0; i < 40 && srv.child.exitCode === null && !srv.child.killed; i++) await sleep(100);
	await sleep(500);
	for (let i = 0; i < 10; i++) {
		try {
			rmSync(srv.dataDir, { recursive: true, force: true });
			return;
		} catch {
			await sleep(200);
		}
	}
}

/**
 * 確保量（Private Bytes）を測る。Windows でだけ動く。
 *
 * 【なぜ probe 側で測らないか】
 * process.memoryUsage() は実メモリ（rss）までしか返さない。確保量は OS に
 * 聞くしかなく、聞き方が OS ごとに違う（Windows は Get-Process、Linux は
 * /proc/<pid>/status、Mac は ps や vmmap）。
 *
 * 実メモリだけを見ると読み違える。CLI を測ったとき、bun は実メモリが小さいのに
 * 確保量は 5 実装のうち最大だった。だから取れる環境では取っておく。
 *
 * PowerShell は 1 回だけ起こす。250 ms ごとに起こすと、起動（185 ms）のほうが
 * 測る間隔より長くなる。まとめて何回ぶんか取らせて、結果だけ受け取る。
 *
 * @returns {{n: number, avg: number, median: number, p95: number, min: number, max: number} | null}
 */
function samplePrivateBytes(pid, samples, intervalMs) {
	if (process.platform !== 'win32') return null;

	// 引数は配列で渡す。シェルを通さないので、入れ子のクォートが要らない
	const script =
		`1..${samples} | ForEach-Object { ` +
		`try { (Get-Process -Id ${pid} -ErrorAction Stop).PrivateMemorySize64 } catch { 0 }; ` +
		`Start-Sleep -Milliseconds ${intervalMs} }`;

	const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
		encoding: 'utf8',
	});
	if (run.status !== 0) return null;

	const mb = (run.stdout ?? '')
		.split(/\r?\n/)
		.map((line) => Number(line.trim()))
		.filter((n) => Number.isFinite(n) && n > 0)
		.map((b) => b / 1024 / 1024);

	return mb.length > 0 ? summarize(mb) : null;
}

/** 指定した長さのあいだメモリを貯めて、まとめを返す（MB） */
async function sampleMemory(srv, ms) {
	srv.state.samples = [];
	srv.state.collecting = true;
	await sleep(ms);
	srv.state.collecting = false;
	const mb = srv.state.samples.map((b) => b / 1024 / 1024);
	if (mb.length === 0) return { n: 0, avg: 0, median: 0, p95: 0, min: 0, max: 0 };
	return summarize(mb);
}

/*
 * 待受けを 10 本ぶら下げたまま say も打つので、ソケットは多めに持たせる。
 * 足りないと後から出した要求が順番待ちになり、待ち時間として数えてしまう。
 */
const agent = new Agent({ keepAlive: true, maxSockets: 64 });

/**
 * API を叩く。アクセストークンはヘッダで渡す。
 *
 * 【なぜ fetch を使わないか】
 * node の fetch は Windows で 1 往復ごとに 15 ms ほど待たされる（i260912-02）。
 * それを載せたまま測ると、say も recent も件数によらず一律 15 ms になり、
 * サーバーの差がまるごと隠れる。実際に一度それで測り直しになった。
 * node:http の http.request なら node ・ bun のどちらで走らせても 0.2 ms で返る。
 */
function call(srv, path, { method = 'GET', body = null, signal = null } = {}) {
	return new Promise((ok, ng) => {
		const req = httpRequest(
			`${srv.base}${path}`,
			{
				method,
				agent,
				headers: {
					'x-aichat-access-token': srv.state.token,
					...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
				},
			},
			(res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks) }));
			}
		);
		req.on('error', ng);
		if (signal) {
			if (signal.aborted) {
				req.destroy(new Error('aborted'));
			} else {
				signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
			}
		}
		if (body) req.write(body);
		req.end();
	});
}

function say(srv, from, body, room = ROOM) {
	return call(srv, '/api/say', {
		method: 'POST',
		body: JSON.stringify({ from_connector_id: from, room_id: room, msg_body: body }),
	});
}

/*
 * 待受けを 1 本張る。
 *
 * 初めて繋ぐ相手には読んだ位置が無く、そのままだと最初の poll が全件を返して
 * すぐ戻ってしまう。先に wait=0 で 1 回叩いて位置を立ててからぶら下げる。
 */
async function openWaiter(srv, id, signal) {
	const q = `connector_id=${id}&room_id=${ROOM}&exclude=join,leave`;
	await call(srv, `/api/poll?${q}&wait=0`);
	return call(srv, `/api/poll?${q}&wait=240`, { signal });
}

/** 待受けを n 本ぶら下げる。戻り値の stop() で全部外す */
async function openWaiters(srv, n) {
	const ctrl = new AbortController();
	const pending = [];
	for (let i = 0; i < n; i++) {
		pending.push(openWaiter(srv, `bench-w${i}`, ctrl.signal).catch(() => {}));
	}
	await sleep(500); // 全部ぶら下がるのを待つ
	return {
		pending,
		async stop() {
			ctrl.abort();
			await Promise.allSettled(pending);
			await sleep(300);
		},
	};
}

/** 1 つのランタイムについて全部測る */
async function run(runtime) {
	process.stdout.write(`\n=== ${runtime} ===\n`);
	const srv = await startServer(runtime);
	process.stdout.write(`  立ち上がり ${srv.startupMs} ms（${srv.base}）\n`);

	const result = { runtime, startupMs: srv.startupMs, memory: [], say: null, sayBusy: null, recent: {}, fanout: [] };

	try {
		// --- メモリ: 待受けの本数を変えながら ---
		for (const n of WAITER_COUNTS) {
			const waiters = n > 0 ? await openWaiters(srv, n) : null;
			await sleep(SETTLE_MS);
			const mem = await sampleMemory(srv, MEM_WINDOW_MS);
			// 確保量は OS に聞く。取れない環境（Windows 以外）では null が返る
			const priv = samplePrivateBytes(srv.child.pid, 5, 250);
			result.memory.push({ waiters: n, ...mem, private: priv });
			const privText = priv ? ` / 確保 ${priv.avg.toFixed(2)} MB` : '';
			process.stdout.write(
				`  メモリ 待受け ${String(n).padStart(2)} 本  実 ${mem.avg.toFixed(2)} MB（${mem.min.toFixed(2)} 〜 ${mem.max.toFixed(2)}）${privText}\n`
			);
			if (waiters) await waiters.stop();
		}

		// --- say の往復（誰もぶら下がっていない状態） ---
		for (let i = 0; i < WARMUP; i++) await say(srv, 'bench-say', 'ウォームアップ');
		const sayLat = [];
		for (let i = 0; i < CALLS; i++) {
			const t = performance.now();
			const res = await say(srv, 'bench-say', `ベンチマークの発言 ${i}`);
			if (res.status !== 200) throw new Error(`say が ${res.status} を返しました`);
			sayLat.push(performance.now() - t);
		}
		result.say = summarize(sayLat);
		process.stdout.write(`  say        中央値 ${result.say.median} ms / p95 ${result.say.p95} ms\n`);

		// --- recent（/api/history）の往復 ---
		// 件数で変わるかを見たいので、先に規定数まで積む
		let have = WARMUP + CALLS;
		while (have < SEED_TOTAL) {
			await say(srv, 'bench-seed', `埋め草 ${have}`);
			have++;
		}
		for (const limit of [50, 500]) {
			for (let i = 0; i < WARMUP; i++) await call(srv, `/api/history?room_id=${ROOM}&limit=${limit}`);
			const lat = [];
			for (let i = 0; i < CALLS; i++) {
				const t = performance.now();
				const res = await call(srv, `/api/history?room_id=${ROOM}&limit=${limit}`);
				if (res.status !== 200) throw new Error(`history が ${res.status} を返しました`);
				lat.push(performance.now() - t);
			}
			result.recent[limit] = summarize(lat);
			process.stdout.write(`  recent ${String(limit).padStart(3)} 件  中央値 ${result.recent[limit].median} ms / p95 ${result.recent[limit].p95} ms\n`);
		}

		// --- 待受けが 10 本ぶら下がっている状態での say ---
		// 同じルームだと打つたびに起こしてしまうので、別のルームへ打って
		// 「ぶら下がりを抱えたまま捌けるか」だけを見る
		{
			const waiters = await openWaiters(srv, 10);
			const lat = [];
			for (let i = 0; i < WARMUP; i++) await say(srv, 'bench-say', 'ウォームアップ', 'bench-other');
			for (let i = 0; i < CALLS; i++) {
				const t = performance.now();
				const res = await say(srv, 'bench-say', `裏で ${i}`, 'bench-other');
				if (res.status !== 200) throw new Error(`say（待受けあり）が ${res.status} を返しました`);
				lat.push(performance.now() - t);
			}
			result.sayBusy = summarize(lat);
			process.stdout.write(`  say(10本待受け中) 中央値 ${result.sayBusy.median} ms / p95 ${result.sayBusy.p95} ms\n`);
			await waiters.stop();
		}

		// --- 配信の遅れ: say から、ぶら下がっている全員が返るまで ---
		for (const n of [1, 5, 10]) {
			const lat = [];
			for (let r = 0; r < FANOUT_ROUNDS; r++) {
				const ctrl = new AbortController();
				const polls = [];
				for (let i = 0; i < n; i++) polls.push(openWaiter(srv, `bench-f${i}`, ctrl.signal));
				await sleep(400);
				const t = performance.now();
				await say(srv, 'bench-say', `配信 ${r}`);
				await Promise.all(polls);
				lat.push(performance.now() - t);
				ctrl.abort();
			}
			const s = summarize(lat);
			result.fanout.push({ waiters: n, ...s });
			process.stdout.write(`  配信 ${String(n).padStart(2)} 本へ  中央値 ${s.median} ms / p95 ${s.p95} ms\n`);
		}
	} finally {
		await stopServer(srv);
	}

	return result;
}

// --- 本体 ---

const out = {
	measuredAt: new Date().toISOString(),
	settings: { waiterCounts: WAITER_COUNTS, calls: CALLS, warmup: WARMUP, seedTotal: SEED_TOTAL, fanoutRounds: FANOUT_ROUNDS },
	versions: {},
	results: [],
};

for (const runtime of RUNTIMES) {
	out.results.push(await run(runtime));
}

const dest = join(root, 'tmp', 'benchmark-server.json');
writeFileSync(dest, JSON.stringify(out, null, '\t') + '\n');
process.stdout.write(`\n結果を tmp/benchmark-server.json に書きました。\n`);

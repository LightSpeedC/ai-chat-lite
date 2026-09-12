/*
 * ローカルの HTTP を、クライアントの作りを変えて測る。
 *
 * 【なぜ要るか】
 * node の fetch は Windows で 1 往復ごとに 15 ms ほど待たされる（課題 i260912-02）。
 * 最小は 0.36 ms まで下がるので、返せないのではなく待たされている。Windows の
 * 既定のタイマー解像度 15.6 ms と一致する。
 *
 * これを踏むと、サーバーを測っているつもりでクライアントを測ることになる。
 * 実際にサーバーのベンチマークが一度それで無効になり、測り直した。
 *
 * 【何を守るか】
 * 速さの下限は決めていない。閾値を置くと Mac ・ Linux やマシンの都合で落ち、
 * 落ちた意味が読めなくなる。ここで落とすのは「手段によって結果が変わる」ときだけで、
 * 往復の時間は数字として毎回出す。課題が直ったかはその数字で見る。
 *
 * 課題 i260912-02 が片付いたら、CLI が使う手段を測る形に書き換える。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, Agent } from 'node:http';

/** 測る回数。多すぎると一括実行が重くなる */
const CALLS = 60;

/** 捨てる回数 */
const WARMUP = 10;

/**
 * 1 往復が異常に遅いと見なす境目（ミリ秒）。
 *
 * 速さを守るための値ではない。ローカルの往復が 1 秒かかるなら、測り方か環境が
 * 壊れている。その場合だけ落とす。
 */
const ABSURD_MS = 1000;

/** 返す中身。本文の長さで差が出ないよう、両方の手段で同じものを返す */
const PAYLOAD = JSON.stringify({ ok: true, filler: 'x'.repeat(2000) });

/** 昇順に並べた配列の中央値 */
function median(values) {
	const s = [...values].sort((a, b) => a - b);
	return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
}

test('ローカルの HTTP は、fetch でも http.request でも同じ応答が返る', async (t) => {
	const srv = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(PAYLOAD);
	});
	await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const agent = new Agent({ keepAlive: true });

	/** fetch で 1 往復 */
	const byFetch = async () => {
		const res = await fetch(base);
		return { status: res.status, body: await res.text() };
	};

	/** node:http の http.request で 1 往復（keepAlive つき） */
	const byRequest = () =>
		new Promise((ok, ng) => {
			const req = httpRequest(base, { agent }, (res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
			});
			req.on('error', ng);
			req.end();
		});

	try {
		// --- 守るところ: 手段が違っても中身は同じ ---
		const a = await byFetch();
		const b = await byRequest();
		assert.equal(a.status, 200, 'fetch が 200 を返さなかった');
		assert.equal(b.status, 200, 'http.request が 200 を返さなかった');
		assert.equal(a.body, b.body, '手段によって本文が変わった');
		assert.equal(a.body, PAYLOAD, '本文が送ったものと違う');

		// --- 記録するところ: 往復の時間 ---
		const results = {};
		for (const [name, fn] of [
			['fetch', byFetch],
			['http.request', byRequest],
		]) {
			for (let i = 0; i < WARMUP; i++) await fn();
			const lat = [];
			for (let i = 0; i < CALLS; i++) {
				const t = performance.now();
				await fn();
				lat.push(performance.now() - t);
			}
			results[name] = { median: median(lat), min: Math.round(Math.min(...lat) * 100) / 100 };
		}

		const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
		t.diagnostic(
			`${runtime} / ${process.platform}: ` +
				`fetch 中央値 ${results['fetch'].median} ms（最小 ${results['fetch'].min}）、` +
				`http.request 中央値 ${results['http.request'].median} ms（最小 ${results['http.request'].min}）`
		);

		/*
		 * 遅い方が速い方の何倍かも出す。Windows の node では 80 倍前後になる。
		 * 課題 i260912-02 が直れば 1 倍に近づく。
		 */
		const ratio = Math.round((results['fetch'].median / results['http.request'].median) * 10) / 10;
		t.diagnostic(`fetch は http.request の ${ratio} 倍（1 に近いほど差が無い）`);

		for (const [name, r] of Object.entries(results)) {
			assert.ok(
				r.median < ABSURD_MS,
				`${name} の 1 往復が ${r.median} ms かかった。ローカルの往復としてあり得ない値で、測り方か環境を疑う`
			);
		}
	} finally {
		agent.destroy();
		await new Promise((ok) => srv.close(ok));
	}
});

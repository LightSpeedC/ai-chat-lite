/*
 * ベンチマーク用に、サーバーを「同じプロセスの中で」立てる。
 *
 * 【なぜ外から測らないか】
 * 別プロセスのメモリを測る方法は OS ごとに違う（Windows は tasklist ・ WMI、
 * Mac ・ Linux は ps）。Mac ・ Linux にも展開する以上、測り方が OS で分かれる形は
 * 持ちたくない。同じプロセスの中から process.memoryUsage() を呼べば、
 * node でも bun でも、どの OS でも同じ 1 本のコードで済む。
 *
 * rss が OS から見た実メモリ（Windows の Working Set に当たる）。
 *
 * 親（benchmark-server.mjs）とは標準出力の印つきの行でやり取りする。
 * サーバー自身のログも同じ出力に混ざるので、印で見分ける。
 *
 *   node tools/40_test/server-probe.mjs
 *   bun  tools/40_test/server-probe.mjs
 *
 * 環境変数 AICHAT_PORT ・ AICHAT_DATA は親が渡す。置き場が既定でなければ
 * テスト用として立つ（config.mjs の IS_TEST）。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/** メモリを報告する間隔（ミリ秒） */
const REPORT_MS = 250;

// 入口は main.mjs。ここが返った時点で待ち受けまで済んでいる
await import(pathToFileURL(join(root, 'src', 'server', 'main.mjs')).href);

const { TEST_ACCESS_TOKEN, IS_TEST } = await import(
	pathToFileURL(join(root, 'src', 'server', 'config.mjs')).href
);

/*
 * 本番の置き場で立ってしまったら、測る前に止める。
 *
 * 親は空きポートを探して渡すが、AICHAT_DATA を渡し損ねると本番の DB を掴む。
 * ベンチマークは say を何百回も打つので、気づかずに流すと本番に残る。
 */
if (!IS_TEST) {
	process.stdout.write('__FATAL__ 本番の置き場で立ちました。AICHAT_DATA が渡っていません\n');
	process.exit(3);
}

process.stdout.write(`__TOKEN__ ${TEST_ACCESS_TOKEN}\n`);
process.stdout.write('__READY__\n');

setInterval(() => {
	const m = process.memoryUsage();
	process.stdout.write(`__MEM__ ${m.rss} ${m.heapUsed} ${m.heapTotal} ${m.external ?? 0}\n`);
}, REPORT_MS);

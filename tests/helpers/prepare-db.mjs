/*
 * テスト用の DB を用意する。
 *
 * store.mjs は形を作らない（版の SQL だけが形の出どころ）。読み込む前に
 * 版を当てておかないと「DB の形が揃っていません」で止まる。
 *
 * サーバーを起動するときは main.mjs が当てるが、テストは store.mjs や
 * server.mjs を直に読み込むため、その経路を通らない。
 *
 * 使い方は、置き場を決める前に呼ぶこと。
 *
 *   const TEST_DATA = join(here, '..', 'tmp', '_data', 'unit-xxx');
 *   await prepareTestDb(TEST_DATA);
 *   const store = await import('../src/server/store.mjs');
 *
 * 何度実行しても同じ結果になるよう、置き場ごと消してから作り直す。
 */
import { rmSync } from 'node:fs';

/**
 * 置き場を作り直し、版を当てる。
 *
 * @param {string} dataDir テスト用の置き場。tmp/_data/unit-xxx
 */
export async function prepareTestDb(dataDir) {
	/*
	 * 環境変数は import より先に立てる。
	 *
	 * config.mjs は読み込まれた時点で置き場を確定する。あとから立てても遅い。
	 */
	process.env.AICHAT_DATA = dataDir;
	rmSync(dataDir, { recursive: true, force: true });

	const { migrate } = await import('../../src/server/migrate.mjs');
	return migrate();
}

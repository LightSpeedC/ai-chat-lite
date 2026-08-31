import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { describeEnv, describeListen, VERSION, DB_PATH, IS_TEST, TEST_ACCESS_TOKEN } from './config.mjs';
import { log } from './log.mjs';
import { waitUntilCleared } from './maintenance.mjs';

/**
 * サーバーの起動口。
 *
 * ここを分けているのは、DB を開く前にメンテナンスの印を確かめたいため。
 * store.mjs は読み込んだ時点で DB を開くので、server.mjs をそのまま
 * import すると印を見る前にファイルを掴んでしまう。印が消えるのを待ってから、
 * 動的 import で読み込む。
 */

log.info(`ai-chat-lite サーバーを起動しました（版 ${VERSION}）`);
for (const line of describeEnv()) log.info(line);
log.info(describeListen());

/*
 * テスト用として立ったとき、アクセストークンをログに残す。
 *
 * API では返さない（誰でも読めてしまう）。起動した本人だけが受け取れる経路として
 * ログを使う。立てたスクリプトがここから取り出し、接続情報に書く。
 */
if (IS_TEST) log.info(`アクセストークン: ${TEST_ACCESS_TOKEN}`);

// 印を置く場所（_data）が無いと存在確認もできないので、先に作っておく
mkdirSync(dirname(DB_PATH), { recursive: true });

await waitUntilCleared();

// ここで初めて DB が開かれる
const { startServers, stopServers } = await import('./server.mjs');

const servers = await startServers();
log.info(`待ち受けを開始しました（${servers.length} 個のアドレス）`);

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		log.info(`${signal} を受け取りました。終了します`);
		await stopServers(servers);
		process.exit(0);
	});
}

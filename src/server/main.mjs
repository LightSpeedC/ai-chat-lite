import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { describeEnv, describeListen, VERSION, DB_PATH } from './config.mjs';
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

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { describeEnv, describeListen, VERSION, DB_PATH, IS_TEST, TEST_ACCESS_TOKEN } from './config.mjs';
import { log } from './log.mjs';
import { waitUntilCleared, isUnderMaintenance, readMaintenanceInfo } from './maintenance.mjs';
import { startListening, setHandler } from './listen.mjs';
import { createMaintenanceHandler } from './maintenance-handler.mjs';
import { migrate } from './migrate.mjs';

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

/*
 * 印があっても待ち受けは先に始める。
 *
 * 待ってから始めると、その間ポートが開かない。繋ごうとした側は
 * ECONNREFUSED を受け、メンテナンス中なのか、サービスが死んだのか、
 * ポートを間違えたのかが区別できない。
 *
 * 先に待ち受けておけば「繋がるが断られる」状態を作れる。印が消えたら
 * 同じ http.Server のまま受け口を差し替えるので、ポートが空く瞬間もない。
 */
const info = readMaintenanceInfo();
const underMaintenance = isUnderMaintenance();

const servers = await startListening(
	createMaintenanceHandler({
		reason: info.reason,
		retryAfterSec: info.minutes ? info.minutes * 60 : undefined,
		since: info.since ? info.since.toISOString() : '',
	})
);
log.info(`待ち受けを開始しました（${servers.length} 個のアドレス）`);
if (underMaintenance) log.warn('メンテナンス中として応答します（API は 503）');

const waited = await waitUntilCleared();

/*
 * 版を上げる。上げている間も 503 のままにしておく。
 *
 * 印を待ってから行うのは、印がある間は人が DB を触っているため。
 * store.mjs より先に済ませる。store.mjs は読み込んだ時点で DB を開くので、
 * 形を変える前に import すると古い形のまま掴んでしまう。
 */
setHandler(servers, createMaintenanceHandler({ reason: 'DB の形を更新しています' }));
const upgraded = migrate();
if (upgraded.applied.length > 0) {
	log.info(`DB の版を ${upgraded.from} から ${upgraded.to} へ上げました`);
}

// ここで初めて DB が開かれる
const { takeOver, stopServers, announceResumed } = await import('./server.mjs');

takeOver(servers);
log.info('通常の応答に切り替えました');

// 止まっていたことは、書かないと誰にも分からない。読んだ位置は保たれるので取りこぼしは無い
if (waited) announceResumed(info.since);

/*
 * DB を閉じるのはここ。stopServers には入れない。
 *
 * 閉じないと WAL の内容が本体に統合されず、chat.db-wal と chat.db-shm が
 * 残る。しかも発言の大半はその -wal 側にあるため、chat.db だけを持ち出すと
 * 中身が欠ける（/api/admin/exit の経路には同じ理由で入れてある）。
 *
 * stopServers ではなくこちらに置くのは、テスト 7 本が同じプロセスで
 * startServers / stopServers を繰り返すためである。stopServers で閉じると
 * store の接続が閉じたままになり、次のテストが触った時点で落ちる。
 */
const { closeDb } = await import('./store.mjs');

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		log.info(`${signal} を受け取りました。終了します`);
		await stopServers(servers);
		try {
			closeDb();
		} catch (err) {
			// 閉じられなくても終了は続ける。次の起動で SQLite が復旧する
			log.error(`DB を閉じられませんでした: ${err?.message ?? err}`);
		}
		process.exit(0);
	});
}

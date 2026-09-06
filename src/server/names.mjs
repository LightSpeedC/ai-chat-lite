/*
 * 繋いでくる名前のうち、本番で受けないものを決める。
 *
 * テスト用の ID を名乗れば隔離される、と思い込んで本番へ繋いだ事故が 3 度あった。
 * 隔離しているのは AICHAT_DATA とポートで、ID は何も分けていない。ルーム名も
 * 本番とテストで同じ public なので手がかりにならない。
 *
 * server.mjs から切り出してあるのは、テストから読めるようにするため。server.mjs は
 * 読み込んだ時点で DB を開くので、単体テストから読み込めない（tables.mjs を分けた
 * のと同じ理由）。判定に本番かどうかを引数で渡すのも、サーバーを立てずに両方の
 * 場合を確かめられるようにするためである。
 *
 * 断るのは繋いでくる側の名前だけにする。片付け（archive / restore）の対象は通す。
 * 通さないと、過去に入ってしまった test- の分を消せなくなる。
 */

/** 本番で受けない ID の頭 */
export const TEST_CONNECTOR_PREFIX = 'test-';

/** 本番で受けないルームの頭 */
export const SANDBOX_ROOM_PREFIX = 'sandbox-';

const HINT =
	'（この名前はテスト用に予約されています。チャットへ投稿するテストが要るときは' +
	' ai-chat-lite に相談してください）';

/**
 * 本番で使えない名前なら、断る理由を返す。使えるなら null。
 *
 * 例外にせず理由を返すのは、投げる型（BadRequest）が server.mjs 側にあるため。
 * ここは判定だけを持ち、HTTP の都合を知らない。
 *
 * @param {string|null} connectorId 名乗ってきた ID
 * @param {string|null} roomId 行き先のルーム
 * @param {boolean} isTest テスト環境として動いているか
 * @returns {string|null}
 */
export function rejectionReason(connectorId, roomId, isTest) {
	if (isTest) return null;

	// 大小は区別しない。Test- でも TEST- でも同じものとして断る
	if (connectorId && connectorId.toLowerCase().startsWith(TEST_CONNECTOR_PREFIX)) {
		return `本番では ${TEST_CONNECTOR_PREFIX} で始まる ID は使えません: ${connectorId}${HINT}`;
	}
	if (roomId && roomId.toLowerCase().startsWith(SANDBOX_ROOM_PREFIX)) {
		return `本番では ${SANDBOX_ROOM_PREFIX} で始まるルームは使えません: ${roomId}${HINT}`;
	}
	return null;
}

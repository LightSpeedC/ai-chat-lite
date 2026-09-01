import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DB_PATH, MAX_HISTORY_LIMIT, DEFAULT_ROOM } from './config.mjs';
import { nowJst } from './time.mjs';
import { log } from './log.mjs';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL は読み手と書き手が同時に動けるようにする。long-poll が常時読んでいる
// 状態に投稿の書き込みが割り込むため、既定のままだと読み手が待たされる。
// この PRAGMA は失敗しても例外を投げず、切り替え後のモード名を返すだけ。
const journalMode = db.prepare('PRAGMA journal_mode = WAL').get();
if (journalMode.journal_mode !== 'wal') {
	log.warn(`WAL に切り替わりませんでした（現在: ${journalMode.journal_mode}）`);
}

/*
 * 古い名前のままの DB を見つけたら、そこで止める。
 *
 * CREATE TABLE IF NOT EXISTS は既にあるテーブルを作り替えない。改名の前の DB を
 * そのまま開くと、テーブルはあるのに列が無い状態で動き出し、最初の読み書きで
 * 「no such column」になる。何が起きたか分かりにくいので、開いた時点で止める。
 *
 * 移すには tools\80_ops\migrate-connector.ps1 を使う。
 */
const oldTable = db
	.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
	.get();
if (oldTable) {
	throw new Error(
		'この DB は改名前の形です（users テーブルがあります）。' +
			'tools\\80_ops\\migrate-connector.ps1 を実行して connector_id へ移してください。'
	);
}

/*
 * archived_seq は「片付けた操作の番号」を指す。NULL なら生きている。
 *
 * 消すのではなく archive する形にしてある。1 回の操作を 1 件として記録し、
 * まとめて戻せるようにするため。操作を記録する archives テーブルと、
 * 実際に片付ける処理はまだ作っていない（notes/10_plan/p260830-02-アーカイブ機能.html）。
 *
 * 列だけ先に置くのは、後から足すと messages を作り直すことになるため。
 * SQLite の ALTER TABLE は列の追加と改名しかできず、CHECK の変更もできない。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  msg_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT    NOT NULL DEFAULT 'public'
                 CHECK (length(room_id) BETWEEN 1 AND 64),
  sent_at      TEXT    NOT NULL
                 CHECK (length(sent_at) = 23),
  from_connector_id TEXT    NOT NULL
                 CHECK (length(from_connector_id) BETWEEN 1 AND 64),
  msg_kind     TEXT    NOT NULL
                 CHECK (msg_kind IN ('say','join','leave','archive','notice')),
  to_connector_id   TEXT
                 CHECK (to_connector_id IS NULL
                        OR length(to_connector_id) BETWEEN 1 AND 64),
  msg_body     TEXT    NOT NULL
                 CHECK (length(msg_body) BETWEEN 1 AND 32000),
  archived_seq INTEGER
);

CREATE INDEX IF NOT EXISTS messages_ix_room_id_msg_seq ON messages(room_id, msg_seq);

-- どこまで読んだか。参加者とルームの組ごとに 1 行。
-- クライアント側のファイルに置くと、実行した場所に縛られて位置を見失う。
-- サーバーが覚えておけば、どこから繋いでも続きから受け取れる。
CREATE TABLE IF NOT EXISTS cursors (
  connector_id      TEXT    NOT NULL
                 CHECK (length(connector_id) BETWEEN 1 AND 64),
  room_id      TEXT    NOT NULL
                 CHECK (length(room_id) BETWEEN 1 AND 64),
  msg_seq      INTEGER NOT NULL
                 CHECK (msg_seq >= 0),
  updated_at   TEXT    NOT NULL
                 CHECK (length(updated_at) = 23),
  archived_seq INTEGER,
  PRIMARY KEY (connector_id, room_id)
);

CREATE TABLE IF NOT EXISTS connectors (
  connector_id                 TEXT    PRIMARY KEY
                            CHECK (length(connector_id) BETWEEN 1 AND 64),
  connector_role               TEXT    NOT NULL
                            CHECK (connector_role IN ('ai','human')),
  first_joined_at         TEXT    NOT NULL
                            CHECK (length(first_joined_at) = 23),
  last_active_at          TEXT    NOT NULL
                            CHECK (length(last_active_at) = 23),
  active_connection_count INTEGER NOT NULL DEFAULT 0
                            CHECK (active_connection_count >= 0),
  archived_seq            INTEGER
);
`);

// 接続数は起動した瞬間に実態と合わなくなるため 0 に戻す。
// 履歴と最終在席時刻は残す。
db.exec('UPDATE connectors SET active_connection_count = 0');

const stmt = {
	insertMessage: db.prepare(`
		INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, to_connector_id, msg_body)
		VALUES (?, ?, ?, ?, ?, ?)
	`),
	selectSince: db.prepare(`
		SELECT * FROM messages
		WHERE room_id = ? AND msg_seq > ?
		ORDER BY msg_seq ASC
		LIMIT ?
	`),
	selectLatest: db.prepare(`
		SELECT * FROM messages
		WHERE room_id = ?
		ORDER BY msg_seq DESC
		LIMIT ?
	`),
	selectBefore: db.prepare(`
		SELECT * FROM messages
		WHERE room_id = ? AND msg_seq < ?
		ORDER BY msg_seq DESC
		LIMIT ?
	`),
	selectAll: db.prepare('SELECT * FROM messages ORDER BY msg_seq ASC'),
	selectRooms: db.prepare(`
		SELECT room_id, COUNT(*) AS msg_count, MAX(msg_seq) AS last_msg_seq
		FROM messages
		GROUP BY room_id
		ORDER BY room_id
	`),
	maxSeq: db.prepare('SELECT COALESCE(MAX(msg_seq), 0) AS max_seq FROM messages WHERE room_id = ?'),
	upsertConnector: db.prepare(`
		INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(connector_id) DO UPDATE SET
			connector_role      = excluded.connector_role,
			last_active_at = excluded.last_active_at
	`),
	touchConnector: db.prepare(`
		INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(connector_id) DO UPDATE SET last_active_at = excluded.last_active_at
	`),
	addConnection: db.prepare(`
		UPDATE connectors
		SET active_connection_count = active_connection_count + 1, last_active_at = ?
		WHERE connector_id = ?
	`),
	removeConnection: db.prepare(`
		UPDATE connectors
		SET active_connection_count = MAX(0, active_connection_count - 1), last_active_at = ?
		WHERE connector_id = ?
	`),
	selectConnectors: db.prepare('SELECT * FROM connectors ORDER BY last_active_at DESC'),
	selectConnector: db.prepare('SELECT * FROM connectors WHERE connector_id = ?'),
	setLastActiveAt: db.prepare('UPDATE connectors SET last_active_at = ? WHERE connector_id = ?'),
	selectCursor: db.prepare('SELECT msg_seq FROM cursors WHERE connector_id = ? AND room_id = ?'),
	upsertCursor: db.prepare(`
		INSERT INTO cursors (connector_id, room_id, msg_seq, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(connector_id, room_id) DO UPDATE SET
			msg_seq    = excluded.msg_seq,
			updated_at = excluded.updated_at
	`),
	selectCursorsOf: db.prepare('SELECT * FROM cursors WHERE connector_id = ? ORDER BY room_id'),
};

/** 取得件数を 1〜上限に収める */
function clampLimit(limit, fallback) {
	const n = Number(limit ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), 1), MAX_HISTORY_LIMIT);
}

/**
 * メッセージを 1 件積む。積んだ行をそのまま返す。
 * @returns {object} 採番された msg_seq を含む行
 */
export function addMessage({ roomId, fromConnectorId, kind = 'say', toConnectorId = null, body }) {
	const sentAt = nowJst();
	const result = stmt.insertMessage.run(roomId, sentAt, fromConnectorId, kind, toConnectorId, body);
	return {
		msg_seq: Number(result.lastInsertRowid),
		room_id: roomId,
		sent_at: sentAt,
		from_connector_id: fromConnectorId,
		msg_kind: kind,
		to_connector_id: toConnectorId,
		msg_body: body,
	};
}

/** since より新しいメッセージを古い順で返す */
export function getSince(roomId, since, limit) {
	return stmt.selectSince.all(roomId, Number(since) || 0, clampLimit(limit, MAX_HISTORY_LIMIT));
}

/** 直近 limit 件を古い順で返す（画面の初期表示に使う） */
export function getLatest(roomId, limit) {
	return stmt.selectLatest.all(roomId, clampLimit(limit, 50)).reverse();
}

/** before より古いメッセージを古い順で返す（遡りに使う） */
export function getBefore(roomId, before, limit) {
	return stmt.selectBefore.all(roomId, Number(before), clampLimit(limit, 50)).reverse();
}

/** 全メッセージ。dump 用 */
export function getAllMessages() {
	return stmt.selectAll.all();
}

/** そのルームの現在位置。1 件も無ければ 0 */
export function getMaxSeq(roomId) {
	return stmt.maxSeq.get(roomId).max_seq;
}

/**
 * ルームの一覧。件数の多寡によらず、既定のルームは必ず含める。
 * ルームを表すテーブルは持たず、メッセージに現れた room_id を数え上げる。
 */
export function listRooms() {
	const rooms = stmt.selectRooms.all();
	if (!rooms.some((r) => r.room_id === DEFAULT_ROOM)) {
		rooms.unshift({ room_id: DEFAULT_ROOM, msg_count: 0, last_msg_seq: 0 });
	}
	return rooms;
}

/** 参加登録。role も更新する */
export function joinConnector(connectorId, role) {
	const at = nowJst();
	stmt.upsertConnector.run(connectorId, role, at, at);
	return stmt.selectConnector.get(connectorId);
}

/**
 * 最終アクセス時刻を更新する。行が無ければ作る。
 * join を経ずに投稿された場合に備えるため、そのときの role は fallbackRole を使う。
 */
export function touchConnector(connectorId, fallbackRole = 'ai') {
	const at = nowJst();
	stmt.touchConnector.run(connectorId, fallbackRole, at, at);
}

/** 接続を 1 本増やす（long-poll / SSE の開始時） */
export function addConnection(connectorId) {
	stmt.addConnection.run(nowJst(), connectorId);
}

/** 接続を 1 本減らす（long-poll / SSE の終了時） */
export function removeConnection(connectorId) {
	stmt.removeConnection.run(nowJst(), connectorId);
}

/** 参加者を最終アクセスの新しい順で返す */
export function listConnectors() {
	return stmt.selectConnectors.all();
}

// --- どこまで読んだか ---

/**
 * 記録されている位置。まだ一度も読んでいなければ null。
 * 呼び出し側は null のときの既定（多くは「参加した時点」）を自分で決める。
 */
export function getCursor(connectorId, roomId) {
	const row = stmt.selectCursor.get(connectorId, roomId);
	return row ? row.msg_seq : null;
}

/** 読んだ位置を記録する */
export function setCursor(connectorId, roomId, msgSeq) {
	stmt.upsertCursor.run(connectorId, roomId, msgSeq, nowJst());
}

/** その参加者の全ルーム分の位置。診断用 */
export function listCursors(connectorId) {
	return stmt.selectCursorsOf.all(connectorId);
}

/** 参加者を 1 人取得する */
export function getConnector(connectorId) {
	return stmt.selectConnector.get(connectorId);
}

export function closeDb() {
	db.close();
}

// --- 診断用。設定や状態が意図どおりかを外から確かめる ---

/**
 * 最終アクセス時刻を明示的に書き換える。
 * オンライン判定が猶予をまたぐ様子を、時間を待たずに確かめるために使う。
 */
export function setLastActiveAt(connectorId, at) {
	stmt.setLastActiveAt.run(at, connectorId);
}

/** 現在のジャーナルモード。WAL に切り替わっていることの確認に使う */
export function getJournalMode() {
	return db.prepare('PRAGMA journal_mode').get().journal_mode;
}

/** since 検索の実行計画。インデックスが使われていることの確認に使う */
export function explainSince() {
	return db
		.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE room_id = ? AND msg_seq > ?')
		.all('public', 0)
		.map((r) => r.detail)
		.join(' / ');
}

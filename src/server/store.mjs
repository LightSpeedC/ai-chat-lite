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
 * archived_seq は「片付けた操作の番号」を指す。NULL なら生きている。
 *
 * 消すのではなく archive する形にしてある。1 回の操作を 1 件として記録し、
 * まとめて戻せるようにするため。操作を記録する archives テーブルと、
 * 実際に片付ける処理はまだ作っていない（notes/10_plan/20260830-02-アーカイブ機能.html）。
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
  from_user_id TEXT    NOT NULL
                 CHECK (length(from_user_id) BETWEEN 1 AND 64),
  msg_kind     TEXT    NOT NULL
                 CHECK (msg_kind IN ('say','join','leave','archive')),
  to_user_id   TEXT
                 CHECK (to_user_id IS NULL
                        OR length(to_user_id) BETWEEN 1 AND 64),
  msg_body     TEXT    NOT NULL
                 CHECK (length(msg_body) BETWEEN 1 AND 32000),
  archived_seq INTEGER
);

CREATE INDEX IF NOT EXISTS messages_ix_room_id_msg_seq ON messages(room_id, msg_seq);

-- どこまで読んだか。参加者とルームの組ごとに 1 行。
-- クライアント側のファイルに置くと、実行した場所に縛られて位置を見失う。
-- サーバーが覚えておけば、どこから繋いでも続きから受け取れる。
CREATE TABLE IF NOT EXISTS cursors (
  user_id      TEXT    NOT NULL
                 CHECK (length(user_id) BETWEEN 1 AND 64),
  room_id      TEXT    NOT NULL
                 CHECK (length(room_id) BETWEEN 1 AND 64),
  msg_seq      INTEGER NOT NULL
                 CHECK (msg_seq >= 0),
  updated_at   TEXT    NOT NULL
                 CHECK (length(updated_at) = 23),
  archived_seq INTEGER,
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id                 TEXT    PRIMARY KEY
                            CHECK (length(user_id) BETWEEN 1 AND 64),
  user_role               TEXT    NOT NULL
                            CHECK (user_role IN ('ai','human')),
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
db.exec('UPDATE users SET active_connection_count = 0');

const stmt = {
	insertMessage: db.prepare(`
		INSERT INTO messages (room_id, sent_at, from_user_id, msg_kind, to_user_id, msg_body)
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
	upsertUser: db.prepare(`
		INSERT INTO users (user_id, user_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(user_id) DO UPDATE SET
			user_role      = excluded.user_role,
			last_active_at = excluded.last_active_at
	`),
	touchUser: db.prepare(`
		INSERT INTO users (user_id, user_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(user_id) DO UPDATE SET last_active_at = excluded.last_active_at
	`),
	addConnection: db.prepare(`
		UPDATE users
		SET active_connection_count = active_connection_count + 1, last_active_at = ?
		WHERE user_id = ?
	`),
	removeConnection: db.prepare(`
		UPDATE users
		SET active_connection_count = MAX(0, active_connection_count - 1), last_active_at = ?
		WHERE user_id = ?
	`),
	selectUsers: db.prepare('SELECT * FROM users ORDER BY last_active_at DESC'),
	selectUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
	setLastActiveAt: db.prepare('UPDATE users SET last_active_at = ? WHERE user_id = ?'),
	selectCursor: db.prepare('SELECT msg_seq FROM cursors WHERE user_id = ? AND room_id = ?'),
	upsertCursor: db.prepare(`
		INSERT INTO cursors (user_id, room_id, msg_seq, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, room_id) DO UPDATE SET
			msg_seq    = excluded.msg_seq,
			updated_at = excluded.updated_at
	`),
	selectCursorsOf: db.prepare('SELECT * FROM cursors WHERE user_id = ? ORDER BY room_id'),
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
export function addMessage({ roomId, fromUserId, kind = 'say', toUserId = null, body }) {
	const sentAt = nowJst();
	const result = stmt.insertMessage.run(roomId, sentAt, fromUserId, kind, toUserId, body);
	return {
		msg_seq: Number(result.lastInsertRowid),
		room_id: roomId,
		sent_at: sentAt,
		from_user_id: fromUserId,
		msg_kind: kind,
		to_user_id: toUserId,
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
export function joinUser(userId, role) {
	const at = nowJst();
	stmt.upsertUser.run(userId, role, at, at);
	return stmt.selectUser.get(userId);
}

/**
 * 最終アクセス時刻を更新する。行が無ければ作る。
 * join を経ずに投稿された場合に備えるため、そのときの role は fallbackRole を使う。
 */
export function touchUser(userId, fallbackRole = 'ai') {
	const at = nowJst();
	stmt.touchUser.run(userId, fallbackRole, at, at);
}

/** 接続を 1 本増やす（long-poll / SSE の開始時） */
export function addConnection(userId) {
	stmt.addConnection.run(nowJst(), userId);
}

/** 接続を 1 本減らす（long-poll / SSE の終了時） */
export function removeConnection(userId) {
	stmt.removeConnection.run(nowJst(), userId);
}

/** 参加者を最終アクセスの新しい順で返す */
export function listUsers() {
	return stmt.selectUsers.all();
}

// --- どこまで読んだか ---

/**
 * 記録されている位置。まだ一度も読んでいなければ null。
 * 呼び出し側は null のときの既定（多くは「参加した時点」）を自分で決める。
 */
export function getCursor(userId, roomId) {
	const row = stmt.selectCursor.get(userId, roomId);
	return row ? row.msg_seq : null;
}

/** 読んだ位置を記録する */
export function setCursor(userId, roomId, msgSeq) {
	stmt.upsertCursor.run(userId, roomId, msgSeq, nowJst());
}

/** その参加者の全ルーム分の位置。診断用 */
export function listCursors(userId) {
	return stmt.selectCursorsOf.all(userId);
}

/** 参加者を 1 人取得する */
export function getUser(userId) {
	return stmt.selectUser.get(userId);
}

export function closeDb() {
	db.close();
}

// --- 診断用。設定や状態が意図どおりかを外から確かめる ---

/**
 * 最終アクセス時刻を明示的に書き換える。
 * オンライン判定が猶予をまたぐ様子を、時間を待たずに確かめるために使う。
 */
export function setLastActiveAt(userId, at) {
	stmt.setLastActiveAt.run(at, userId);
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

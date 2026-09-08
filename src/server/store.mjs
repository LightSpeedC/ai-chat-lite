import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DB_PATH, MAX_HISTORY_LIMIT, DEFAULT_ROOM } from './config.mjs';
import { REQUIRED_TABLES } from './tables.mjs';
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
 * 形は作らない。版の SQL（src/scripts/20_migrate/）だけが形の出どころである。
 *
 * かつてはここに CREATE TABLE IF NOT EXISTS を並べていたが、2 つの困りごとが
 * あったのでやめた。
 *
 *   1. 定義が 2 か所になる。ここと版の SQL が食い違っても静かに動き、
 *      「空の DB から起動したときだけ形が違う」ことになる
 *   2. 読み込むだけで本番の DB にテーブルが作られる。AICHAT_DATA を立てずに
 *      import すると、版が当たっていない DB に版 3 の形だけが先にできて、
 *      次の起動で「already exists」になり、サーバーが起動しなくなった
 *
 * 版を当てるのは main.mjs の migrate()。この store.mjs が読まれるより前に走る。
 * ここでは「揃っているか」を確かめるだけにする。一覧は tables.mjs にある。
 *
 * 名前で絞らずに全テーブルを引く。かつては IN で絞っていたが、確かめたい名前が
 * REQUIRED_TABLES と SQL の 2 か所に並ぶことになり、上の 1 と同じ困りごとを
 * 抱えていた。sqlite_master の行は 6 件しかないため、全件引く代償は無い。
 */
const found = new Set(
	db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
);

/*
 * 古い名前のままの DB を見つけたら、そこで止める。
 *
 * 改名の前の DB をそのまま開くと、テーブルはあるのに列が無い状態で動き出し、
 * 最初の読み書きで「no such column」になる。何が起きたか分かりにくい。
 */
if (found.has('users')) {
	throw new Error(
		'この DB は改名前の形です（users テーブルがあります）。' +
			'サーバーを起動し直すと版が当たります（src/server/migrate.mjs）。'
	);
}

const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
if (missing.length > 0) {
	throw new Error(
		`DB の形が揃っていません（足りないテーブル: ${missing.join(' ')}）。` +
			'版を当ててから開いてください。サーバーは main.mjs が起動時に当てます。' +
			'テストから使うときは store.mjs を読み込む前に migrate() を呼んでください。'
	);
}

// 接続数は起動した瞬間に実態と合わなくなるため 0 に戻す。
// 履歴と最終在席時刻は残す。
db.exec('UPDATE connectors SET active_connection_count = 0');

const stmt = {
	insertMessage: db.prepare(`
		INSERT INTO messages (room_id, sent_at, from_connector_id, msg_kind, to_connector_id, msg_body, ref_archived_seq, reply_to_msg_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`),
	selectSince: db.prepare(`
		SELECT * FROM messages
		WHERE archived_seq IS NULL AND room_id = ? AND msg_seq > ?
		ORDER BY msg_seq ASC
		LIMIT ?
	`),
	selectLatest: db.prepare(`
		SELECT * FROM messages
		WHERE archived_seq IS NULL AND room_id = ?
		ORDER BY msg_seq DESC
		LIMIT ?
	`),
	selectBefore: db.prepare(`
		SELECT * FROM messages
		WHERE archived_seq IS NULL AND room_id = ? AND msg_seq < ?
		ORDER BY msg_seq DESC
		LIMIT ?
	`),
	selectAll: db.prepare('SELECT * FROM messages ORDER BY msg_seq ASC'),
	selectRooms: db.prepare(`
		SELECT room_id, COUNT(*) AS msg_count, MAX(msg_seq) AS last_msg_seq
		FROM messages
		WHERE archived_seq IS NULL
		GROUP BY room_id
		ORDER BY room_id
	`),
	maxSeq: db.prepare(
		'SELECT COALESCE(MAX(msg_seq), 0) AS max_seq FROM messages WHERE archived_seq IS NULL AND room_id = ?'
	),
	/*
	 * 片付けた行は主キーの枠を占め続ける（connector_id が主キー）。INSERT は必ず
	 * DO UPDATE に落ちるので、archived_seq = NULL に戻さないと、読み出し側の
	 * archived_seq IS NULL に弾かれて「書けるのに読めない行」になる。
	 *
	 * 繋ぎ直したら復活させるのが筋である。片付けは過去のものを隠すためで、
	 * その ID が二度と使えなくなることではない。
	 */
	upsertConnector: db.prepare(`
		INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(connector_id) DO UPDATE SET
			connector_role      = excluded.connector_role,
			last_active_at = excluded.last_active_at,
			archived_seq   = NULL
	`),
	touchConnector: db.prepare(`
		INSERT INTO connectors (connector_id, connector_role, first_joined_at, last_active_at, active_connection_count)
		VALUES (?, ?, ?, ?, 0)
		ON CONFLICT(connector_id) DO UPDATE SET
			last_active_at = excluded.last_active_at,
			archived_seq   = NULL
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
	selectConnectors: db.prepare('SELECT * FROM connectors WHERE archived_seq IS NULL ORDER BY last_active_at DESC'),
	selectConnector: db.prepare('SELECT * FROM connectors WHERE archived_seq IS NULL AND connector_id = ?'),
	setLastActiveAt: db.prepare('UPDATE connectors SET last_active_at = ? WHERE connector_id = ?'),
	selectCursor: db.prepare('SELECT msg_seq FROM cursors WHERE archived_seq IS NULL AND connector_id = ? AND room_id = ?'),
	/*
	 * cursors も同じ。主キーは (connector_id, room_id) で、片付けた行が枠を占める。
	 *
	 * 戻さないと getCursor が毎回 null を返し、server.mjs の
	 * getCursor(...) ?? getMaxSeq(...) が「いまの最大値」を起点にする。
	 * 待受けを張っていない間の発言を黙って飛ばすことになる。
	 */
	upsertCursor: db.prepare(`
		INSERT INTO cursors (connector_id, room_id, msg_seq, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(connector_id, room_id) DO UPDATE SET
			msg_seq      = excluded.msg_seq,
			updated_at   = excluded.updated_at,
			archived_seq = NULL
	`),
	selectCursorsOf: db.prepare('SELECT * FROM cursors WHERE archived_seq IS NULL AND connector_id = ? ORDER BY room_id'),
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
export function addMessage({ roomId, fromConnectorId, kind = 'say', toConnectorId = null, body, refArchivedSeq = null, replyToMsgSeq = null }) {
	const sentAt = nowJst();
	const result = stmt.insertMessage.run(roomId, sentAt, fromConnectorId, kind, toConnectorId, body, refArchivedSeq, replyToMsgSeq);
	return {
		msg_seq: Number(result.lastInsertRowid),
		room_id: roomId,
		sent_at: sentAt,
		from_connector_id: fromConnectorId,
		msg_kind: kind,
		to_connector_id: toConnectorId,
		msg_body: body,
		archived_seq: null,
		ref_archived_seq: refArchivedSeq,
		reply_to_msg_seq: replyToMsgSeq,
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

// --- 片付ける（archive） ---

/**
 * 片付ける前に、何がどれだけ消えるかを数える。
 *
 * 先に見せてから確かめさせるため。件数が思っていたより多ければ、そこで気づける。
 *
 * @param {'message'|'connector'|'room'} kind
 * @param {string} id 対象。message なら msg_seq、connector なら ID、room ならルーム名
 * @param {boolean} withMessages connector のとき、その参加者の発言も含めるか
 */
export function previewArchive(kind, id, withMessages = false) {
	if (kind === 'message') {
		const row = db
			.prepare('SELECT * FROM messages WHERE archived_seq IS NULL AND msg_seq = ?')
			.get(Number(id));
		return { messages: row ? 1 : 0, cursors: 0, connectors: 0, first: row?.sent_at ?? null, last: row?.sent_at ?? null };
	}

	if (kind === 'room') {
		const m = db
			.prepare(
				'SELECT COUNT(*) AS n, MIN(sent_at) AS first, MAX(sent_at) AS last FROM messages WHERE archived_seq IS NULL AND room_id = ?'
			)
			.get(id);
		const c = db
			.prepare('SELECT COUNT(*) AS n FROM cursors WHERE archived_seq IS NULL AND room_id = ?')
			.get(id);
		return { messages: Number(m.n), cursors: Number(c.n), connectors: 0, first: m.first, last: m.last };
	}

	// connector
	const c = db
		.prepare('SELECT COUNT(*) AS n FROM connectors WHERE archived_seq IS NULL AND connector_id = ?')
		.get(id);
	const cur = db
		.prepare('SELECT COUNT(*) AS n FROM cursors WHERE archived_seq IS NULL AND connector_id = ?')
		.get(id);
	const m = withMessages
		? db
				.prepare(
					'SELECT COUNT(*) AS n, MIN(sent_at) AS first, MAX(sent_at) AS last FROM messages WHERE archived_seq IS NULL AND from_connector_id = ?'
				)
				.get(id)
		: { n: 0, first: null, last: null };

	return {
		messages: Number(m.n),
		cursors: Number(cur.n),
		connectors: Number(c.n),
		first: m.first,
		last: m.last,
	};
}

/**
 * 片付ける。archives に 1 行足し、対象の archived_seq にその番号を入れる。
 *
 * 1 回の操作を 1 つの番号で束ねる。戻すときはその番号を指定すれば済む。
 * すべて 1 つのトランザクションで行う。途中で失敗したら何も片付かない。
 *
 * @returns {{archived_seq: number, counts: object, description: string}}
 */
export function archive({ kind, id, withMessages = false, byConnectorId, description }) {
	const counts = previewArchive(kind, id, withMessages);
	const at = nowJst();

	db.exec('BEGIN IMMEDIATE');
	try {
		const inserted = db
			.prepare(
				`INSERT INTO archives (archived_at, archived_connector_id, archive_kind, archive_id, description)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run(at, byConnectorId, kind, String(id), description);
		const seq = Number(inserted.lastInsertRowid);

		if (kind === 'message') {
			db.prepare('UPDATE messages SET archived_seq = ? WHERE archived_seq IS NULL AND msg_seq = ?').run(
				seq,
				Number(id)
			);
		} else if (kind === 'room') {
			db.prepare('UPDATE messages SET archived_seq = ? WHERE archived_seq IS NULL AND room_id = ?').run(seq, id);
			db.prepare('UPDATE cursors SET archived_seq = ? WHERE archived_seq IS NULL AND room_id = ?').run(seq, id);
		} else {
			db.prepare('UPDATE connectors SET archived_seq = ? WHERE archived_seq IS NULL AND connector_id = ?').run(
				seq,
				id
			);
			db.prepare('UPDATE cursors SET archived_seq = ? WHERE archived_seq IS NULL AND connector_id = ?').run(seq, id);
			if (withMessages) {
				db.prepare(
					'UPDATE messages SET archived_seq = ? WHERE archived_seq IS NULL AND from_connector_id = ?'
				).run(seq, id);
			}
		}

		db.exec('COMMIT');
		return { archived_seq: seq, counts, description, archived_at: at };
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/**
 * 戻す。その番号で片付けたものを、まとめて生かし直す。
 *
 * archives の行も消す。番号が残っていると「戻したのにまだある」ことになる。
 *
 * @returns {{restored: number, row: object} | null} 番号が無ければ null
 */
export function restore(archivedSeq) {
	const seq = Number(archivedSeq);
	const row = db.prepare('SELECT * FROM archives WHERE archived_seq = ?').get(seq);
	if (!row) return null;

	db.exec('BEGIN IMMEDIATE');
	try {
		let restored = 0;
		for (const table of ['messages', 'cursors', 'connectors']) {
			const r = db.prepare(`UPDATE ${table} SET archived_seq = NULL WHERE archived_seq = ?`).run(seq);
			restored += Number(r.changes);
		}
		db.prepare('DELETE FROM archives WHERE archived_seq = ?').run(seq);
		db.exec('COMMIT');
		return { restored, row };
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/** 片付けたものの一覧。新しい順。件数も添える */
export function listArchives() {
	return db
		.prepare(
			`SELECT a.*,
			        (SELECT COUNT(*) FROM messages   WHERE archived_seq = a.archived_seq) AS msg_count,
			        (SELECT COUNT(*) FROM cursors    WHERE archived_seq = a.archived_seq) AS cursor_count,
			        (SELECT COUNT(*) FROM connectors WHERE archived_seq = a.archived_seq) AS connector_count
			 FROM archives a
			 ORDER BY a.archived_seq DESC`
		)
		.all();
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

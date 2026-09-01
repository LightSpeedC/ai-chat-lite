import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { ROOT, DB_PATH, DATA_DIR } from './config.mjs';
import { nowJst } from './time.mjs';
import { log } from './log.mjs';

/**
 * DB の形を版で管理し、足りない分を順に当てる。
 *
 * CREATE TABLE IF NOT EXISTS は既にあるテーブルを作り替えない。列を足すだけなら
 * ALTER TABLE で済むが、CHECK の変更・列の削除・型の変更はテーブルを作り直す
 * しかなく、そのたびに専用の手順を書くことになっていた。
 *
 * ver_000001/ ver_000002/ … に SQL を置き、versions テーブルに「どこまで
 * 当てたか」を持つ。起動時に足りない分だけを順に当てる。
 *
 * store.mjs とは別の接続で開く。store.mjs は読み込んだ時点で DB を開くため、
 * 形を変える前に import すると古い形のまま掴んでしまう。
 */

/** 版の SQL の置き場。納品するものなので src/ 側に置く */
const MIGRATIONS_DIR = join(ROOT, 'src', 'scripts', '20_migrate');

/** フォルダ名の形。6 桁のゼロ埋め */
const VER_DIR = /^ver_(\d{6})$/;

/**
 * 置き場にある版を、番号順に読む。
 *
 * 連続していなければ止める。飛んでいると、当て損ねに気づけない。
 */
export function listVersions(dir = MIGRATIONS_DIR) {
	if (!existsSync(dir)) return [];

	const found = [];
	for (const name of readdirSync(dir)) {
		const m = name.match(VER_DIR);
		if (!m) continue;
		const seq = Number(m[1]);
		// 名前順に当てる。1 つの版に複数の SQL を置ける
		const files = readdirSync(join(dir, name))
			.filter((f) => f.endsWith('.sql'))
			.sort();
		if (files.length === 0) throw new Error(`${name} に .sql がありません`);
		found.push({ seq, name, files, dir: join(dir, name) });
	}

	found.sort((a, b) => a.seq - b.seq);
	found.forEach((v, i) => {
		if (v.seq !== i + 1) {
			throw new Error(`版の番号が連続していません: ${v.name}（${i + 1} が来るはずでした）`);
		}
	});
	return found;
}

/** その版の SQL を 1 つに繋いだもの。指紋もここから取る */
function readSql(version) {
	return version.files.map((f) => readFileSync(join(version.dir, f), 'utf8')).join('\n');
}

function fingerprint(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * すでに何かテーブルがあるか。
 *
 * versions を持たない DB が空とは限らない。改名の前から動いている DB は
 * 「版 1 の形」なので、ver_000001 を当ててはいけない（すでにその形である）。
 */
function hasAnyTable(db) {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.get();
	return Number(row.n) > 0;
}

/**
 * 当てる前の控えを取る。
 *
 * 下り（元に戻す SQL）は持たない。SQLite は列の削除もできず、下りを正しく
 * 書き続けるのは重い。戻すならここから戻す。
 *
 * VACUUM INTO は稼働中でも 24 ミリ秒で終わることを実測している。chat.db だけを
 * 複製すると -wal 側の分が落ちるが、VACUUM INTO なら 1 つに揃う。
 */
function takeBackup(db, fromSeq) {
	const at = nowJst().replace(/[^0-9]/g, '').slice(0, 14);
	const path = join(DATA_DIR, `pre-ver-${String(fromSeq).padStart(6, '0')}-${at}.db`);
	if (existsSync(path)) rmSync(path);
	db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
	log.info(`版を上げる前の控えを取りました: ${path.replace(ROOT, '.')}`);
	return path;
}

/**
 * 足りない版を順に当てる。
 *
 * @returns {{from: number, to: number, applied: string[]}} 当てた結果
 */
export function migrate({ dbPath = DB_PATH, dir = MIGRATIONS_DIR } = {}) {
	const versions = listVersions(dir);
	mkdirSync(dirname(dbPath), { recursive: true });

	const db = new DatabaseSync(dbPath);
	try {
		const versionsExisted = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'versions'")
			.get();

		/*
		 * 「すでに使われているか」は versions を作る前に見る。
		 *
		 * 作ってから数えると versions 自身が 1 件として数えられ、空の DB でも
		 * 「使用済み」と判定してしまう。そうなると版 1 が当てられず、
		 * 版 2 が「no such table: messages」で落ちる。
		 */
		const alreadyUsed = hasAnyTable(db);

		db.exec(`
			CREATE TABLE IF NOT EXISTS versions (
			  version_seq INTEGER PRIMARY KEY,
			  applied_at  TEXT    NOT NULL
			                CHECK (length(applied_at) = 23),
			  script      TEXT    NOT NULL,
			  sql_sha256  TEXT    NOT NULL
			                CHECK (length(sql_sha256) = 64)
			);
		`);

		/*
		 * versions を持たない DB がすでに使われていたら、版 1 の形として記録する。
		 *
		 * 改名の前から動いている DB は ver_000001 の形になっている。当て直すと
		 * 「テーブルがもうある」で失敗するし、消して作れば中身が飛ぶ。
		 */
		if (!versionsExisted && alreadyUsed && versions.length > 0) {
			const first = versions[0];
			db.prepare('INSERT INTO versions (version_seq, applied_at, script, sql_sha256) VALUES (?, ?, ?, ?)').run(
				first.seq,
				nowJst(),
				`${first.name}（当てずに記録）`,
				fingerprint(readSql(first))
			);
			log.warn(`すでに使われている DB のため、${first.name} は当てずに記録しました`);
		}

		const rows = db.prepare('SELECT version_seq, script, sql_sha256 FROM versions ORDER BY version_seq').all();
		const appliedBy = new Map(rows.map((r) => [Number(r.version_seq), r]));
		const from = rows.length > 0 ? Number(rows[rows.length - 1].version_seq) : 0;

		/*
		 * 当て済みの SQL が書き換えられていないかを見る。
		 *
		 * 当て済みの環境では二度と実行されないため、書き換えると環境ごとに形が
		 * 違う状態になる。気づかないのがいちばん怖い。
		 */
		for (const v of versions) {
			const row = appliedBy.get(v.seq);
			if (!row) continue;
			const now = fingerprint(readSql(v));
			if (row.sql_sha256 !== now) {
				throw new Error(
					`当て済みの ${v.name} が書き換えられています。` +
						'当て済みの環境では実行されないため、環境ごとに形が違う状態になります。' +
						'新しい版として足してください。'
				);
			}
		}

		const pending = versions.filter((v) => !appliedBy.has(v.seq));
		if (pending.length === 0) return { from, to: from, applied: [] };

		log.info(`DB の版を上げます: ${from} → ${pending[pending.length - 1].seq}`);
		takeBackup(db, from);

		const applied = [];
		for (const v of pending) {
			const sql = readSql(v);
			/*
			 * 1 つの版を 1 つのトランザクションで当てる。失敗したら巻き戻す。
			 * SQLite は DDL もトランザクションに入る（PRAGMA と VACUUM は入らない）。
			 */
			db.exec('BEGIN IMMEDIATE');
			try {
				db.exec(sql);
				db.prepare('INSERT INTO versions (version_seq, applied_at, script, sql_sha256) VALUES (?, ?, ?, ?)').run(
					v.seq,
					nowJst(),
					v.files.join(', '),
					fingerprint(sql)
				);
				db.exec('COMMIT');
			} catch (err) {
				db.exec('ROLLBACK');
				throw new Error(`${v.name} を当てられませんでした: ${err?.message ?? err}`);
			}
			log.info(`  ${v.name} を当てました（${v.files.join(', ')}）`);
			applied.push(v.name);
		}

		return { from, to: pending[pending.length - 1].seq, applied };
	} finally {
		// 開いたら閉じる。閉じないと WAL の内容が本体に統合されない
		db.close();
	}
}

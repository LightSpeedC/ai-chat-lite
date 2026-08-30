import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { DB_PATH } from './config.mjs';
import { nowJst } from './time.mjs';

/**
 * バックアップの取得。
 *
 * VACUUM INTO を使う。ファイルをコピーする方法は使えない。
 * WAL モードで動かしているため、直近の書き込みは chat.db 本体ではなく
 * chat.db-wal 側にある。本体だけを複製すると、その時点で統合されていない
 * 分がまるごと落ちる（実測では 64 件のうち 0 件しか入っていなかった）。
 *
 * VACUUM INTO は WAL を織り込んだ一貫したスナップショットを別ファイルに書く。
 * 読み取り専用の接続から実行でき、サービスを止める必要がない。
 * 出来上がったファイルは -wal も -shm も伴わず、単体で開ける。
 */

/** 世代の上限。これを超えた分は古いものから消す */
export const KEEP_GENERATIONS = 8;

/** バックアップ名の書式。zip を外すと chat.db になるようにしてある */
const NAME_PATTERN = /^chat-(\d{8})-(\d{6})\.db(\.zip)?$/;

/**
 * バックアップの名前を組み立てる。
 *
 * 秒まで入れる。1 日に何度も取ることがあり、日付だけでは衝突するため。
 *
 * @param {string} [at] JST の日時文字列。省略すると現在時刻
 * @returns {string} 例: chat-20260830-123456
 */
export function backupBaseName(at = nowJst()) {
	const digits = at.replace(/[^0-9]/g, ''); // 20260830123456789
	return `chat-${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
}

/**
 * DB のスナップショットを書き出す。
 *
 * @param {string} dest 出力先。既に在るとエラーになる（SQLite の仕様）
 * @param {string} [src] 元の DB
 * @returns {{ dest: string, bytes: number, ms: number, messages: number }}
 */
export function vacuumInto(dest, src = DB_PATH) {
	if (!existsSync(src)) {
		throw new Error(`元の DB がありません: ${src}`);
	}
	if (existsSync(dest)) {
		throw new Error(`出力先が既にあります: ${dest}`);
	}
	mkdirSync(dirname(dest), { recursive: true });

	// 読み取り専用で開く。稼働中のサービスと同時に開いても書き込みを邪魔しない
	const db = new DatabaseSync(src, { readOnly: true });
	const startedAt = Date.now();
	try {
		// パスは埋め込むしかない（VACUUM INTO はプレースホルダを受け付けない）。
		// SQLite の文字列リテラルの規則に従い、シングルクォートを 2 つ重ねて逃がす
		const quoted = "'" + dest.split("'").join("''") + "'";
		db.exec('VACUUM INTO ' + quoted);
		const messages = db.prepare('SELECT count(*) AS c FROM messages').get().c;
		return { dest, bytes: statSync(dest).size, ms: Date.now() - startedAt, messages };
	} finally {
		db.close();
	}
}

/**
 * 保存済みのバックアップを新しい順に並べる。
 *
 * 名前で並べる。名前に日時が入っていて、桁を揃えてあるので辞書順が時系列順になる。
 * ファイルの更新日時は、コピーや展開で変わってしまうため当てにしない。
 *
 * @param {string} dir
 * @returns {string[]} ファイル名（新しい順）
 */
export function listBackups(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => NAME_PATTERN.test(name))
		.sort()
		.reverse();
}

/**
 * 世代を超えた分を消す。
 *
 * @param {string} dir
 * @param {number} [keep] 残す数
 * @returns {string[]} 消したファイル名
 */
export function pruneBackups(dir, keep = KEEP_GENERATIONS) {
	const stale = listBackups(dir).slice(keep);
	for (const name of stale) {
		rmSync(join(dir, name), { force: true });
	}
	return stale;
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { ROOT, DB_PATH } from './config.mjs';
import { nowJst } from './time.mjs';
import { MAINTENANCE_FILE } from './maintenance.mjs';

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

/**
 * 世代の区分。直近は細かく、古いものは粗く残す。
 *
 * 取る時刻を 1 分ずつずらしてある。同時刻にすると 4 つが同じ DB を同時に読み、
 * ファイル名の秒まで一致して衝突する。月曜 0 時には 4 つすべてが順に走る。
 */
export const KINDS = {
	hourly: { keep: 8, label: '毎時', span: '8 時間' },
	daily: { keep: 7, label: '毎日', span: '1 週間' },
	weekly: { keep: 4, label: '毎週', span: '1 か月' },
	monthly: { keep: 6, label: '毎月', span: '半年' },
};

/** 区分を指定せずに取ったときの置き場。手で取ったものは hourly に混ぜる */
export const DEFAULT_KIND = 'hourly';

/** 区分の名前として使えるか。フォルダ名になるので、知らない名前は受け付けない */
export function isKnownKind(kind) {
	return Object.hasOwn(KINDS, kind);
}

/** その区分で残す世代数 */
export function keepOf(kind) {
	return KINDS[kind]?.keep ?? KINDS[DEFAULT_KIND].keep;
}

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

// --- 取ってはいけないときに取らないためのしくみ ---

/** バックアップ中を表す印 */
export const RUNNING_FILE = join(ROOT, '_data', 'BACKUP-RUNNING');

/**
 * 印を見に行く間隔と、諦めるまでの回数。30 秒 × 10 回 = 最大 5 分。
 *
 * 環境変数で短くできる。既定のままでは動作を確かめるのに 5 分かかるため。
 */
export const LOCK_POLL_MS = Number(process.env.AICHAT_LOCK_POLL_MS ?? 30 * 1000);
export const LOCK_MAX_TRIES = Number(process.env.AICHAT_LOCK_MAX_TRIES ?? 10);

/**
 * 握ったまま終わった印を残骸とみなすまでの時間。
 *
 * タスクの実行時間の上限を 10 分にしてあるため、正常に動いている処理の印が
 * 30 分残ることはない。これを見ないと、強制終了で残った印のせいで
 * 以降どの区分も待って諦め続けることになる。
 */
export const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * 印が効いているか。無ければ false、古すぎるものも false。
 *
 * @param {string} file
 * @param {number} [staleMs] これより古い印は残骸とみなす。0 で無効
 */
export function isLockActive(file, staleMs = 0) {
	if (!existsSync(file)) return false;
	if (staleMs <= 0) return true;
	try {
		return Date.now() - statSync(file).mtimeMs < staleMs;
	} catch {
		// 見に行った瞬間に消えた
		return false;
	}
}

/**
 * バックアップ中の印を置く。置けたら true、既にあれば false。
 *
 * `wx` フラグ（O_CREAT | O_EXCL）で作る。OS が「無ければ作る」を
 * 一続きの操作として保証するため、同時に取り合っても 1 つしか成功しない。
 *
 * 名前を変える方式（LOCK.pid を作って LOCK へ rename）は Windows では
 * 使えない。Node の renameSync は既にある印を黙って上書きするため、
 * 2 つのプロセスが両方「取れた」と思い込む。実測で確かめてある。
 * PowerShell の Rename-Item と cmd の ren は失敗するが、cmd の move は
 * 上書きするので、シェルによって結果が変わる書き方も避ける。
 */
export function acquireLock(kind = 'manual', file = RUNNING_FILE) {
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(file, `${kind} が ${nowJst()} に開始しました（pid ${process.pid}）\n`, {
			flag: 'wx',
		});
		return true;
	} catch (err) {
		if (err.code === 'EEXIST') return false;
		throw err;
	}
}

/**
 * 印を取れるまで待つ。
 *
 * 「空くのを待ってから置く」と書くと、確認してから置くまでの間に
 * 割り込まれる。置きに行って失敗したら待つ、の順にする。
 *
 * メンテナンスの印は人が置くものなので、こちらは奪わずに消えるのを待つ。
 *
 * @returns {Promise<{ acquired: boolean, waitedMs: number, reason: string }>}
 *   acquired が false なら諦めた。呼び出し元はバックアップを取らずに終える
 */
export async function acquireWithWait({
	kind = 'manual',
	file = RUNNING_FILE,
	maintenanceFile = MAINTENANCE_FILE,
	pollMs = LOCK_POLL_MS,
	maxTries = LOCK_MAX_TRIES,
	staleMs = STALE_LOCK_MS,
	onWait = null,
} = {}) {
	const startedAt = Date.now();

	for (let tries = 0; tries <= maxTries; tries++) {
		let label = null;

		if (isLockActive(maintenanceFile, 0)) {
			// DB を触っている最中。中途半端な状態を複製しないよう手を出さない
			label = 'メンテナンス';
		} else {
			// 握ったまま終わった印は残骸とみなして外す
			if (existsSync(file) && !isLockActive(file, staleMs)) {
				releaseLock(file);
			}
			if (acquireLock(kind, file)) {
				return { acquired: true, waitedMs: Date.now() - startedAt, reason: '' };
			}
			label = 'バックアップ';
		}

		if (tries === maxTries) {
			return {
				acquired: false,
				waitedMs: Date.now() - startedAt,
				reason: `${label}の印が消えませんでした: ${label === 'メンテナンス' ? maintenanceFile : file}`,
			};
		}
		onWait?.({ label, tries: tries + 1, maxTries, pollMs });
		await sleep(pollMs);
	}
	// ここには来ない
	return { acquired: false, waitedMs: Date.now() - startedAt, reason: '不明' };
}

/** 印を消す。無くても構わない */
export function releaseLock(file = RUNNING_FILE) {
	rmSync(file, { force: true });
}

/** 印に書かれた内容。無ければ空 */
export function readLock(file = RUNNING_FILE) {
	try {
		return readFileSync(file, 'utf8').trim();
	} catch {
		return '';
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
export function pruneBackups(dir, keep = KINDS[DEFAULT_KIND].keep) {
	const stale = listBackups(dir).slice(keep);
	for (const name of stale) {
		rmSync(join(dir, name), { force: true });
	}
	return stale;
}

/**
 * 全区分の控えを新しい順に並べる。戻すときに選ぶ材料になる。
 *
 * @param {string} backupRoot _backup のパス
 * @returns {{ kind: string, name: string, path: string }[]}
 */
export function listAllBackups(backupRoot) {
	const all = [];
	for (const kind of Object.keys(KINDS)) {
		const dir = join(backupRoot, kind);
		for (const name of listBackups(dir)) {
			all.push({ kind, name, path: join(dir, name) });
		}
	}
	// 名前に日時が入っているので、名前で並べれば時系列順になる
	return all.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/*
 * テストが残したデータを消す。
 *
 * テストは実際に動いているサーバーへ投稿するため、走らせるたびに参加者とルームが
 * 増える。名前で見分けられるようにしておき、終わったらまとめて消す。
 *
 *   connector_id が test-  で始まるもの … connectors / cursors / messages（発言者・宛先）
 *   room_id が sandbox- で始まるもの … messages / cursors
 *
 * public のように残したいルームへ投稿したものも、発言者が test- なら消える。
 *
 * 使い方:
 *   node tools/40_test/purge-test-data.mjs                消す（接頭辞に当たる全部）
 *   node tools/40_test/purge-test-data.mjs --dry-run      数えるだけ
 *   node tools/40_test/purge-test-data.mjs --names a,b,c  その名前だけ消す
 *   node tools/40_test/purge-test-data.mjs --production   本番を相手にする
 *
 * --names は、テストが自分で作った分だけを消すためにある。接頭辞で全部消すと、
 * 同時に走っている別のテストのデータまで巻き込む。名前は connector_id と room_id の
 * どちらとしても照合する。
 *
 * 【既定はテスト側】
 *   何も指定しなければ tmp/_data を相手にする。忘れて本番を消す事故を防ぐため、
 *   本番のパスをこのファイルに書かない。本番を触るには --production が要る。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/** テストが作るものの目印。ここを変えるときはテスト側の名前も揃える */
export const CONNECTOR_PREFIX = 'test-';
export const ROOM_PREFIX = 'sandbox-';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dryRun = process.argv.includes('--dry-run');
const toProduction = process.argv.includes('--production');

/*
 * 相手にする置き場。
 *
 * 既定はテスト。--production を渡したときだけ本番になる。
 * AICHAT_DATA が立っていればそちらを使う（run-ui-tests から渡される）。
 */
const dataDir = toProduction
	? join(root, '_data')
	: (process.env.AICHAT_DATA ?? join(root, 'tmp', '_data'));
const dbPath = join(dataDir, 'chat.db');

/** --names で渡された名前。空なら接頭辞で全部を対象にする */
const namesArg = process.argv[process.argv.indexOf('--names') + 1];
const names =
	process.argv.includes('--names') && namesArg
		? namesArg.split(',').map((s) => s.trim()).filter(Boolean)
		: [];

const where = dbPath.replace(root, '.');
console.log(`相手: ${where}${toProduction ? '  ← 本番' : ''}`);

if (!existsSync(dbPath)) {
	console.log('DB がありません。消すものもありません。');
	process.exit(0);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA secure_delete = ON');

/*
 * 消す条件を組み立てる。
 *   名前を渡されたとき … その名前と一致するものだけ
 *   渡されないとき     … 接頭辞に当たるもの全部
 */
const build = () => {
	if (names.length === 0) {
		const u = `${CONNECTOR_PREFIX}%`;
		const r = `${ROOM_PREFIX}%`;
		return {
			messages: ['from_connector_id LIKE ? OR to_connector_id LIKE ? OR room_id LIKE ?', [u, u, r]],
			cursors: ['connector_id LIKE ? OR room_id LIKE ?', [u, r]],
			connectors: ['connector_id LIKE ?', [u]],
		};
	}
	const marks = names.map(() => '?').join(', ');
	return {
		messages: [
			`from_connector_id IN (${marks}) OR to_connector_id IN (${marks}) OR room_id IN (${marks})`,
			[...names, ...names, ...names],
		],
		cursors: [`connector_id IN (${marks}) OR room_id IN (${marks})`, [...names, ...names]],
		connectors: [`connector_id IN (${marks})`, [...names]],
	};
};

const conditions = build();
const count = (table) => {
	const [cond, args] = conditions[table];
	return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cond}`).get(...args).n);
};

const found = { messages: count('messages'), cursors: count('cursors'), connectors: count('connectors') };
const total = found.messages + found.cursors + found.connectors;
const scope = names.length === 0 ? '接頭辞に当たる全部' : `指定された ${names.length} 件の名前`;

if (total === 0) {
	console.log(`テストデータはありません（${scope}）。`);
	db.close();
	process.exit(0);
}

console.log(`テストデータ（${scope}）: messages ${found.messages} / cursors ${found.cursors} / connectors ${found.connectors}`);

if (dryRun) {
	console.log('（--dry-run のため消していません）');
	db.close();
	process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
for (const table of ['messages', 'cursors', 'connectors']) {
	const [cond, args] = conditions[table];
	db.prepare(`DELETE FROM ${table} WHERE ${cond}`).run(...args);
}
db.exec('COMMIT');

/*
 * 領域を詰めるのは、接頭辞でまとめて消したときだけにする。
 *
 * VACUUM は DB の排他ロックを取る。テストが並行して走っている最中に取ると、
 * 他のテストの読み書きが待たされて落ちる（実際に chat-ui が落ちた）。
 * 中身は secure_delete で潰れているので、詰めるのは後回しでよい。
 */
if (names.length === 0) {
	try {
		db.exec('VACUUM');
	} catch {
		/* 取れなくても消えてはいる。次の機会に詰まる */
	}
}

db.close();
console.log(`テストデータ ${total} 件を消しました。`);

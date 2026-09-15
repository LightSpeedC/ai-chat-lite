/*
 * 参加者の ID 付け替え（rename）を、本番の写しで試す。
 *
 * 【なぜ要るか】
 * rename は connectors ・ cursors ・ messages（差出人 ・ 宛先 ・ 本文の @）・
 * archives を横断して書き換える。**取りこぼしても例外は出ない。**
 * 古い ID を指す行が残るだけで、静かに食い違う。
 *
 * 本番でいきなり実行すると、取りこぼしに気づくのが「あとから」になる。
 * 先に写しで試し、**古い ID を指す行が 0 件になること**を数えてから本番へ進む。
 *
 * 【本番に書き込まない】
 * 写しは読み取り専用の接続から VACUUM INTO で作る。本番の DB には触らない。
 * 写しは 1 ファイルに畳まれるので、-wal ・ -shm を取り違える余地もない。
 *
 *   node tools/40_test/rename-dryrun.mjs --from html2md --to ai-agent-tools
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 引数を読む */
function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const from = arg('from');
const to = arg('to');
if (!from || !to) {
	console.error('使い方: node tools/40_test/rename-dryrun.mjs --from <旧 ID> --to <新 ID>');
	process.exit(2);
}

const workDir = join(root, 'tmp', '_data-rename');
const copyPath = join(workDir, 'chat.db');
const livePath = join(root, '_data', 'chat.db');

// --- 1. 本番の写しを作る（本番には書き込まない） ---

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

{
	const live = new DatabaseSync(livePath, { readOnly: true });
	live.exec(`VACUUM INTO '${copyPath.replace(/\\/g, '/')}'`);
	live.close();
}
process.stdout.write(`写しを作りました: ${copyPath.replace(root, '.')}\n\n`);

// --- 2. 古い ID を指す行を数える ---

/** 古い ID を指す行を、置き場ごとに数える */
function countRefs(db, id) {
	const one = (sql, ...a) => db.prepare(sql).get(...a).n;
	return {
		connectors: one('SELECT COUNT(*) n FROM connectors WHERE connector_id=?', id),
		cursors: one('SELECT COUNT(*) n FROM cursors WHERE connector_id=?', id),
		messagesFrom: one('SELECT COUNT(*) n FROM messages WHERE from_connector_id=?', id),
		messagesTo: one('SELECT COUNT(*) n FROM messages WHERE to_connector_id=?', id),
		messagesBody: one('SELECT COUNT(*) n FROM messages WHERE msg_body LIKE ?', `%@${id}%`),
		archivesBy: one('SELECT COUNT(*) n FROM archives WHERE archived_connector_id=?', id),
		archivesTarget: one("SELECT COUNT(*) n FROM archives WHERE archive_kind='connector' AND archive_id=?", id),
	};
}

const LABELS = {
	connectors: 'connectors',
	cursors: 'cursors',
	messagesFrom: 'messages 差出人',
	messagesTo: 'messages 宛先',
	messagesBody: 'messages 本文の @',
	archivesBy: 'archives 実行者',
	archivesTarget: 'archives 対象',
};

/** 件数の表を出す */
function report(title, counts) {
	process.stdout.write(`--- ${title} ---\n`);
	let total = 0;
	for (const [key, label] of Object.entries(LABELS)) {
		process.stdout.write(`  ${label.padEnd(20)} ${String(counts[key]).padStart(5)} 件\n`);
		total += counts[key];
	}
	process.stdout.write(`  ${'合計'.padEnd(20)} ${String(total).padStart(5)} 件\n\n`);
	return total;
}

let before;
{
	const db = new DatabaseSync(copyPath, { readOnly: true });
	before = countRefs(db, from);
	db.close();
}
const beforeTotal = report(`付け替える前（${from} を指す行）`, before);

if (beforeTotal === 0) {
	console.error(`${from} を指す行がありません。ID を確かめてください。`);
	process.exit(1);
}

// --- 3. 写しに対して付け替える ---

/*
 * store を写しの置き場で読み込む。config.mjs は AICHAT_DATA を見て
 * 置き場を決めるので、import より前に立てる必要がある。
 */
process.env.AICHAT_DATA = workDir;
process.env.AICHAT_NO_EXIT = '1';

const store = await import('../../src/server/store.mjs');

const preview = store.previewRename(from);
process.stdout.write('--- 下見（previewRename）---\n');
for (const [key, value] of Object.entries(preview)) {
	process.stdout.write(`  ${key.padEnd(20)} ${String(value).padStart(5)}\n`);
}
process.stdout.write('\n');

const result = store.renameConnector(from, to);
process.stdout.write('--- 付け替えた結果（renameConnector）---\n');
for (const [key, value] of Object.entries(result)) {
	process.stdout.write(`  ${key.padEnd(20)} ${String(value).padStart(5)}\n`);
}
process.stdout.write('\n');

if (typeof store.closeDb === 'function') store.closeDb();

// --- 4. 数え直す ---

const db = new DatabaseSync(copyPath, { readOnly: true });
const afterOld = countRefs(db, from);
const afterNew = countRefs(db, to);
db.close();

const oldTotal = report(`付け替えた後（${from} を指す行。0 であること）`, afterOld);
const newTotal = report(`付け替えた後（${to} を指す行）`, afterNew);

// --- 5. 判定 ---

let ng = 0;
if (oldTotal !== 0) {
	console.error(`古い ID を指す行が ${oldTotal} 件残っています。取りこぼしです。`);
	ng++;
}
if (newTotal !== beforeTotal) {
	console.error(`件数が合いません。前 ${beforeTotal} 件 → 後 ${newTotal} 件。`);
	ng++;
}

if (ng === 0) {
	process.stdout.write(`通りました。${beforeTotal} 件がすべて ${to} へ移りました。\n`);
	process.stdout.write('写しは tmp/_data-rename に残してあります。中身を見て確かめてください。\n');
} else {
	process.stdout.write('\n本番では実行しないでください。\n');
}

process.exit(ng === 0 ? 0 : 1);

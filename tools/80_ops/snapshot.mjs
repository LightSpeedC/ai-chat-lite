/*
 * 節目の控えを 1 つ取る。
 *
 * 版を上げる前、改名の前など、あとで「あの時点」へ戻りたくなる場面で使う。
 * 1 時間ごとの定期バックアップ（backup.ps1）とは別のもので、こちらは人が
 * 名前を付けて残す。
 *
 *   定期  _backup/<区分>/chat-yyyymmdd-hhmmss.db.zip   機械が回す。世代で消える
 *   節目  _backup/yyyymmdd-hhmmss-<名前>.db            人が取る。消えない
 *
 * 使い方:
 *   node tools/80_ops/snapshot.mjs ver3            _backup へ取る
 *   node tools/80_ops/snapshot.mjs ver3 --dry-run  どこへ何を取るかだけ出す
 *   node tools/80_ops/snapshot.mjs --help          使い方を出す
 *
 * 【VACUUM INTO で取る】
 *   -wal に残っている分も本体に統合された 1 ファイルになる。3 ファイル一組で
 *   持ち運ぶ必要がなくなり、「本体だけコピーして中身が空だった」を避けられる。
 *   動いているサーバーを止めなくてよい。
 *
 * 【名前は日時が先】
 *   yyyymmdd-hhmmss-<名前>.db にすると、名前順がそのまま時系列順になる。
 *   名前を先にすると before-connector と before-ver3 が日時と関係なく並ぶ。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function usage(exitCode) {
	console.log('節目の控えを 1 つ取る（VACUUM INTO で 1 ファイルにまとめる）。');
	console.log('');
	console.log('  node tools/80_ops/snapshot.mjs <名前> [オプション]');
	console.log('');
	console.log('  <名前>        何の前の控えかを表す語。ver3 / connector など');
	console.log('  --production  本番を相手にする（既定）');
	console.log('  --data <path> 置き場を指定する。テストの DB を控えるとき');
	console.log('  --dry-run     どこへ何を取るかだけ出す');
	console.log('  --help        この使い方を出す（短い形 -h）');
	console.log('');
	console.log('  出力は _backup/yyyymmdd-hhmmss-<名前>.db。名前順がそのまま時系列順になる。');
	process.exit(exitCode);
}

const KNOWN = new Set(['--production', '--data', '--dry-run', '--help', '-h']);
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(args.length === 0 ? 2 : 0);

const dataIndex = args.indexOf('--data');
const dataValueIndex = dataIndex < 0 ? -1 : dataIndex + 1;
const unknown = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && i !== dataValueIndex);
if (unknown.length > 0) {
	console.error(`知らないオプションです: ${unknown.join(' ')}`);
	console.error('');
	usage(2);
}

/** 名前。オプションでない最初の引数 */
const name = args.find((a, i) => !a.startsWith('-') && i !== dataValueIndex);
if (!name) {
	console.error('何の前の控えかを表す語を渡してください。例: ver3');
	console.error('');
	usage(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
	console.error(`名前に使えるのは英数字とハイフンだけです: ${name}`);
	process.exit(2);
}

const dryRun = args.includes('--dry-run');
const dataDir = dataValueIndex >= 0 ? args[dataValueIndex] : join(root, '_data');
const dbPath = join(dataDir, 'chat.db');
const backupDir = join(root, '_backup');

if (!existsSync(dbPath)) {
	console.error(`DB がありません: ${dbPath.replace(root, '.')}`);
	process.exit(1);
}

/** yyyymmdd-hhmmss。JST で組み立てる */
function stamp() {
	const jst = new Date(Date.now() + 9 * 3600 * 1000);
	const p = (n, w = 2) => String(n).padStart(w, '0');
	return (
		`${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
		`-${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
	);
}

const dest = join(backupDir, `${stamp()}-${name}.db`);

console.log(`相手: ${dbPath.replace(root, '.')}`);
console.log(`控え: ${dest.replace(root, '.')}`);

if (dryRun) {
	console.log('--dry-run なので取りません。');
	process.exit(0);
}

mkdirSync(backupDir, { recursive: true });

const db = new DatabaseSync(dbPath);
try {
	db.prepare('VACUUM INTO ?').run(dest);
} finally {
	db.close();
}

/*
 * 控えの側を数える。
 *
 * 取れたことと、中身が入っていることは別である。VACUUM INTO が空の本体だけを
 * 写していないかを、ここで確かめる。
 */
const check = new DatabaseSync(dest, { readOnly: true });
try {
	const has = (t) =>
		check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

	console.log('取りました:');
	for (const t of ['messages', 'connectors', 'cursors', 'archives']) {
		if (has(t)) console.log(`  ${t.padEnd(11)}: ${check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n} 件`);
	}
	if (has('versions')) {
		console.log(`  版         : ${check.prepare('SELECT MAX(version_seq) AS v FROM versions').get().v}`);
	}
} finally {
	check.close();
}

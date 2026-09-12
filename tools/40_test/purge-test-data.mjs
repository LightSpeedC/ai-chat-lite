/*
 * テストが残したデータを消す。
 *
 * テストは実際に動いているサーバーへ投稿するため、走らせるたびに参加者とルームが
 * 増える。名前で見分けられるようにしておき、終わったらまとめて消す。
 *
 *   connector_id が test-  で始まるもの … connectors / cursors / messages（発言者・宛先） / archives
 *   room_id が sandbox- で始まるもの … messages / cursors / archives
 *
 * 片付け（archive）の記録と、それを指す知らせも消す。以前は 3 テーブルしか
 * 見ておらず、片付けた記録だけが本番に残り続けた（i260912-01）。
 *
 * public のように残したいルームへ投稿したものも、発言者が test- なら消える。
 *
 * 使い方（--help でも出る）:
 *   node tools/40_test/purge-test-data.mjs --test         tmp/_data を相手にする
 *   node tools/40_test/purge-test-data.mjs --production   本番を相手にする
 *   node tools/40_test/purge-test-data.mjs --test --dry-run     数えるだけ
 *   node tools/40_test/purge-test-data.mjs --test --names a,b,c その名前だけ消す
 *
 * --names は、テストが自分で作った分だけを消すためにある。接頭辞で全部消すと、
 * 同時に走っている別のテストのデータまで巻き込む。名前は connector_id と room_id の
 * どちらとしても照合する。
 *
 * 【置き場は必ず明示する】
 *   --test か --production のどちらかが要る。付け忘れは断る（i260906-02）。
 *
 *   以前は何も指定しなければ tmp/_data を相手にしていた。そのため本番を掃除する
 *   手順で --production が抜けていたとき、手順どおり実行しても本番の test- は
 *   1 件も消えず、しかも「消しました」と出た。読み手は消えたと思い込む。
 *   既定を本番にするのは論外なので、明示を求める形にした。
 *
 *   AICHAT_DATA が立っていればそれを使う（run-ui-tests から渡される）。
 *   立てた側が置き場を決めているので、これも「明示された」とみなす。
 *   本番のパスはこのファイルに書かない。--production から組み立てる。
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

/** テストが作るものの目印。ここを変えるときはテスト側の名前も揃える */
export const CONNECTOR_PREFIX = 'test-';
export const ROOM_PREFIX = 'sandbox-';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const OPTIONS = [
	['--test', 'tmp/_data を相手にする（AICHAT_DATA が立っていればそちら）'],
	['--production', '本番を相手にする'],
	['--dry-run', '数えるだけ。消さない'],
	['--names a,b,c', 'その名前だけ消す。connector_id と room_id のどちらとしても照合する'],
	['--help', 'この使い方を出す（短い形 -h）'],
];

/*
 * 知らない引数を渡されたら、消さずに使い方を出して止める。
 *
 * 既定の動作が「消す」であるため、黙って無視すると打ち間違いがそのまま
 * 削除になる。実際に --help と打って 48 件を消した。
 */
function usage(exitCode) {
	const width = Math.max(...OPTIONS.map((o) => o[0].length));
	console.log('テストが残したデータを消す。');
	console.log('');
	console.log('  node tools/40_test/purge-test-data.mjs [オプション]');
	console.log('');
	for (const [name, desc] of OPTIONS) console.log(`  ${name.padEnd(width)}  ${desc}`);
	console.log('');
	console.log(`  目印: connector_id が ${CONNECTOR_PREFIX} で始まるもの / room_id が ${ROOM_PREFIX} で始まるもの`);
	console.log('  --names を付けなければ、目印に当たるものを全部消す。');
	console.log('  置き場は --test か --production で必ず明示する。');
	process.exit(exitCode);
}

const KNOWN = new Set(['--test', '--dry-run', '--names', '--production', '--help', '-h']);
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) usage(0);

/*
 * --names の値は引数ではないので、判定から外す。
 *
 * --names が無いときは -1 にする。indexOf の -1 に 1 を足して 0 にすると、
 * 先頭の引数が「値」と見なされて素通りする。
 */
const namesIndex = args.indexOf('--names');
const namesValueIndex = namesIndex < 0 ? -1 : namesIndex + 1;
const unknown = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && i !== namesValueIndex);
if (unknown.length > 0) {
	console.error(`知らないオプションです: ${unknown.join(' ')}`);
	console.error('');
	usage(2);
}

const dryRun = args.includes('--dry-run');
const toProduction = args.includes('--production');
const toTest = args.includes('--test');

/*
 * 置き場を明示しなければ断る（i260906-02）。
 *
 * 以前は付け忘れると黙って tmp/_data を見た。本番を掃除する手順で
 * --production が抜けていたとき、手順どおり実行しても本番の test- は 1 件も
 * 消えず、しかも「消しました」と出た。数えるだけ（--dry-run）でも同じで、
 * 「0 件だった」を本番の状態として読み違える。
 *
 * AICHAT_DATA が立っているときは、立てた側が置き場を決めているので明示と
 * みなす（run-ui-tests から渡される）。
 */
if (toProduction && toTest) {
	console.error('--test と --production は、どちらか一方だけを渡してください。');
	process.exit(2);
}
if (!toProduction && !toTest && !process.env.AICHAT_DATA) {
	console.error('どちらの置き場を相手にするかが指定されていません。');
	console.error('');
	console.error('  テスト: node tools/40_test/purge-test-data.mjs --test');
	console.error('  本番:   node tools/40_test/purge-test-data.mjs --production');
	console.error('');
	console.error('  既定値は持ちません。付け忘れたまま「消しました」と出ると、');
	console.error('  消えていない側を消えたものとして読み違えます。');
	process.exit(2);
}

/*
 * 相手にする置き場。
 *
 * --production なら本番。それ以外は AICHAT_DATA があればそちら、
 * 無ければ tmp/_data（--test を渡した場合だけここに来る）。
 */
const dataDir = toProduction
	? join(root, '_data')
	: (process.env.AICHAT_DATA ?? join(root, 'tmp', '_data'));
const dbPath = join(dataDir, 'chat.db');

/** --names で渡された名前。指定が無ければ空で、接頭辞に当たるものすべてが対象になる */
const wantsNames = args.includes('--names');
/*
 * 次の引数が - で始まるなら、それは値ではなく別のオプションである。
 * 値として拾うと、--names --dry-run が「--dry-run という名前を消す」になる。
 */
const namesArg = namesValueIndex >= 0 ? args[namesValueIndex] : undefined;
const namesValue = namesArg && !namesArg.startsWith('-') ? namesArg : undefined;
const names = namesValue
	? namesValue.split(',').map((s) => s.trim()).filter(Boolean)
	: [];

/*
 * --names を渡したのに名前が取れないときは断る。
 *
 * 空のまま進めると names.length === 0 が「接頭辞で全部」と同じ意味になり、
 * 絞ったつもりで全部消える。値の付け忘れ（--names だけ）・空文字・
 * カンマだけ、のどれもここで止める。
 */
if (wantsNames && names.length === 0) {
	console.error('--names には消す名前を渡してください（カンマ区切り）。');
	console.error('値を付けずに実行すると、接頭辞に当たるものすべてが対象になります。');
	process.exit(2);
}

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
/*
 * archives も相手にする。
 *
 * 本番に入り込んだ test- の参加者を archive で片付けると、archives に
 * 「何を片付けたか」の行が残る。以前はこの道具が 3 テーブルしか見なかった
 * ため、その行だけが残り続けた。archives の説明は aichat archives の一覧に
 * 出るので、テストの痕跡が読める状態になる（実際に 5 件が残っていた）。
 *
 * 片付けの知らせ（msg_kind = archive）も一緒に消す。差出人は片付けを実行した
 * 側なので from_connector_id では当たらないが、消す archives を指している
 * ものは残しても意味がない。番号の指す先が無くなり、画面には押しても何も
 * 起きない「戻す」ボタンだけが出る。
 */
const ARCHIVE_NOTICE = `ref_archived_seq IN (SELECT archived_seq FROM archives WHERE %COND%)`;

const build = () => {
	if (names.length === 0) {
		const u = `${CONNECTOR_PREFIX}%`;
		const r = `${ROOM_PREFIX}%`;
		const arcCond = 'archive_id LIKE ? OR archive_id LIKE ? OR archived_connector_id LIKE ?';
		return {
			messages: [
				`from_connector_id LIKE ? OR to_connector_id LIKE ? OR room_id LIKE ? OR ${ARCHIVE_NOTICE.replace('%COND%', arcCond)}`,
				[u, u, r, u, r, u],
			],
			cursors: ['connector_id LIKE ? OR room_id LIKE ?', [u, r]],
			connectors: ['connector_id LIKE ?', [u]],
			archives: [arcCond, [u, r, u]],
		};
	}
	const marks = names.map(() => '?').join(', ');
	const arcCond = `archive_id IN (${marks}) OR archived_connector_id IN (${marks})`;
	return {
		messages: [
			`from_connector_id IN (${marks}) OR to_connector_id IN (${marks}) OR room_id IN (${marks})` +
				` OR ${ARCHIVE_NOTICE.replace('%COND%', arcCond)}`,
			[...names, ...names, ...names, ...names, ...names],
		],
		cursors: [`connector_id IN (${marks}) OR room_id IN (${marks})`, [...names, ...names]],
		connectors: [`connector_id IN (${marks})`, [...names]],
		archives: [arcCond, [...names, ...names]],
	};
};

const conditions = build();
const count = (table) => {
	const [cond, args] = conditions[table];
	return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${cond}`).get(...args).n);
};

const found = {
	messages: count('messages'),
	cursors: count('cursors'),
	connectors: count('connectors'),
	archives: count('archives'),
};
const total = found.messages + found.cursors + found.connectors + found.archives;
const scope = names.length === 0 ? '接頭辞に当たる全部' : `指定された ${names.length} 件の名前`;

if (total === 0) {
	console.log(`テストデータはありません（${scope}）。`);
	db.close();
	process.exit(0);
}

console.log(
	`テストデータ（${scope}）: messages ${found.messages} / cursors ${found.cursors} / connectors ${found.connectors} / archives ${found.archives}`
);

if (dryRun) {
	console.log('（--dry-run のため消していません）');
	db.close();
	process.exit(0);
}

db.exec('BEGIN IMMEDIATE');
/*
 * archives は最後に消す。
 *
 * messages の条件が「消す archives を指している知らせ」を拾うため、先に
 * archives を消すと、その知らせが条件に当たらなくなって残る。
 */
for (const table of ['messages', 'cursors', 'connectors', 'archives']) {
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

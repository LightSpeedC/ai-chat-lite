import { join } from 'node:path';

import { ROOT, DB_PATH } from '../../src/server/config.mjs';
import {
	backupBaseName,
	vacuumInto,
	acquireWithWait,
	releaseLock,
	readLock,
	KEEP_GENERATIONS,
} from '../../src/server/backup.mjs';

/**
 * バックアップの取得（圧縮する前まで）。
 *
 * 圧縮と世代の整理は呼び出し元の PowerShell が行う。zip を作る手段が
 * Node の標準ライブラリに無いため（zlib は gzip と deflate だけで、
 * zip の容れ物は作れない）。ここは DB のスナップショットだけを引き受ける。
 *
 * 出力するファイル名は chat.db で固定する。zip の中身がこの名前になり、
 * 展開してそのまま _data へ置けるようにするため。世代を区別する日時は
 * zip 側の名前に付ける。
 *
 * 終了コード:
 *   0 … 取れた
 *   2 … 印が消えず、取らずに終えた（失敗ではない）
 *   1 … 取得に失敗した
 */

const kind = process.argv[2] ?? 'manual';
const outDir = process.argv[3] ?? join(ROOT, 'tmp', 'backup-work', kind);

// メンテナンス中や、別の区分が取っている最中は待つ。取れたら印を握った状態で返る
const lock = await acquireWithWait({
	kind,
	onWait: ({ label, tries, maxTries, pollMs }) => {
		// 待ち時間は環境変数で変えられる。決め打ちで書くと実際とずれる
		const sec = pollMs >= 1000 ? `${Math.round(pollMs / 1000)} 秒` : `${pollMs} ミリ秒`;
		console.error(`${label}の印があります。${sec}待ちます（${tries}/${maxTries}）`);
	},
});

if (!lock.acquired) {
	console.error(lock.reason);
	const held = readLock();
	if (held) console.error(`  印の中身: ${held}`);
	console.error('  今回は取得を見送ります。次の時刻に改めて取ります');
	process.exit(2);
}

if (lock.waitedMs >= 1000) {
	console.error(`印が取れました（${Math.round(lock.waitedMs / 1000)} 秒待機）`);
}

try {
	const result = vacuumInto(join(outDir, 'chat.db'), DB_PATH);

	// PowerShell 側が読み取る。1 行 1 項目で出す
	console.log(`base=${backupBaseName()}`);
	console.log(`file=${result.dest}`);
	console.log(`bytes=${result.bytes}`);
	console.log(`ms=${result.ms}`);
	console.log(`messages=${result.messages}`);
	console.log(`keep=${KEEP_GENERATIONS}`);
	console.log(`src=${DB_PATH}`);
	console.log(`kind=${kind}`);
} finally {
	// 取得に失敗しても必ず外す。残すと以降のすべてが待たされる
	releaseLock();
}

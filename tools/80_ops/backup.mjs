import { join } from 'node:path';

import { ROOT, DB_PATH } from '../../src/server/config.mjs';
import { backupBaseName, vacuumInto, listBackups, KEEP_GENERATIONS } from '../../src/server/backup.mjs';

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
 */

const outDir = process.argv[2] ?? join(ROOT, 'tmp', 'backup-work');

const result = vacuumInto(join(outDir, 'chat.db'), DB_PATH);

// PowerShell 側が読み取る。1 行 1 項目で出す
console.log(`base=${backupBaseName()}`);
console.log(`file=${result.dest}`);
console.log(`bytes=${result.bytes}`);
console.log(`ms=${result.ms}`);
console.log(`messages=${result.messages}`);
console.log(`keep=${KEEP_GENERATIONS}`);
console.log(`src=${DB_PATH}`);

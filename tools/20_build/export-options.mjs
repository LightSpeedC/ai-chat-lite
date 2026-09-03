/*
 * CLI のオプションとコマンドの定義を JSON に書き出す。
 *
 * C# 版（aichat.exe）はこの JSON をビルド時に埋め込む。定義の出どころを
 * src/client/options.mjs 1 か所に保ち、2 本の CLI が食い違わないようにする。
 *
 * 手で 2 か所に書くと必ずずれる。実際に usage() と USAGE の一覧が食い違い、
 * --retry-count が usage() から抜けていたことがある。
 *
 * 使い方:
 *   node tools/20_build/export-options.mjs           tmp/ に書き出す
 *   node tools/20_build/export-options.mjs --stdout  画面に出す（確認用）
 *   node tools/20_build/export-options.mjs --help     使い方を出す
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	WAIT_UNITS,
	DEFAULT_WAIT_SEC,
	ID_WRAP,
	ID_PATTERN,
	WAITER_PATTERN,
	OPTIONS,
	COMMANDS,
	ADMIN_COMMANDS,
	REMOVED,
	RETRY_INTERVAL_SEC,
	RETRY_TIMES,
	EXIT_UNREACHABLE,
} from '../../src/client/options.mjs';
import { DEFAULT_ROOM, MAX_WAIT_SEC, PORT } from '../../src/server/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function usage(exitCode) {
	console.log('CLI の定義を JSON に書き出す（C# 版が埋め込む元）。');
	console.log('');
	console.log('  node tools/20_build/export-options.mjs [オプション]');
	console.log('');
	console.log('  --stdout   ファイルに書かず画面に出す');
	console.log('  --out <p>  書き出し先を変える（既定 tmp/cli-options.json）');
	console.log('  --help     この使い方を出す（短い形 -h）');
	process.exit(exitCode);
}

const KNOWN = new Set(['--stdout', '--out', '--help', '-h']);
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage(0);

const outIndex = args.indexOf('--out');
const outValueIndex = outIndex < 0 ? -1 : outIndex + 1;
const unknown = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && i !== outValueIndex);
if (unknown.length > 0) {
	console.error(`知らないオプションです: ${unknown.join(' ')}`);
	console.error('');
	usage(2);
}

/*
 * REMOVED は Map なので、そのままでは JSON にならない。
 * 配列に直しておくと、C# 側でも順序が保たれる。
 */
const definition = {
	/*
	 * この JSON の形が変わったら上げる。C# 側が食い違いに気づけるようにするため。
	 *
	 *   1 … 最初の形
	 *   2 … id_wrap / id_pattern を足し、removed に short を足した
	 *       （--connector-id を廃止し、コマンドの直後に :id: を置く形へ）
	 *   3 … waiter_pattern を足した（waiters コマンド）
	 */
	schema: 3,
	generated_from: 'src/client/options.mjs',

	id_wrap: ID_WRAP,
	id_pattern: ID_PATTERN,
	waiter_pattern: WAITER_PATTERN,

	default_room: DEFAULT_ROOM,
	default_port: PORT,
	max_wait_sec: MAX_WAIT_SEC,
	default_wait_sec: DEFAULT_WAIT_SEC,
	retry_interval_sec: RETRY_INTERVAL_SEC,
	retry_times: RETRY_TIMES,
	exit_unreachable: EXIT_UNREACHABLE,

	wait_units: WAIT_UNITS,
	options: OPTIONS,
	commands: COMMANDS,
	admin_commands: ADMIN_COMMANDS,
	removed: [...REMOVED].map(([name, { short, hint }]) => ({ name, short, hint })),
};

const json = JSON.stringify(definition, null, '\t') + '\n';

if (args.includes('--stdout')) {
	process.stdout.write(json);
	process.exit(0);
}

const out = outValueIndex >= 0 ? args[outValueIndex] : join(root, 'tmp', 'cli-options.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, json, 'utf8');

console.log(`書き出しました: ${out.replace(root, '.')}`);
console.log(`  コマンド ${definition.commands.length} 件 / オプション ${definition.options.length} 件`);
console.log(`  管理コマンド ${definition.admin_commands.length} 件 / 廃止 ${definition.removed.length} 件`);

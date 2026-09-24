/*
 * Rust 版 CLI（aichat-rs）を作る。
 *
 * 手順は 3 つ。
 *   1. options.mjs から定義を JSON に書き出す（src/cli-rs/cli-options.json）
 *   2. cargo build --release
 *   3. できた実行ファイルを dist/ に置く
 *
 * 【なぜ node で書くか】
 * ps1 にすると Mac ・ Linux で動かない。Rust 版を作る動機がクロスプラットフォーム
 * なのに、作る道具が Windows 専用では筋が通らない。node はどの環境にも入っている。
 *
 * 【定義の JSON を追跡しない理由】
 * 生成物だから。出どころは src/client/options.mjs の 1 か所に保つ。
 * 無いままだと include_str! が通らないので、写し忘れには必ず気づける。
 *
 *   node tools/20_build/build-aichat-rs.mjs          作る
 *   node tools/20_build/build-aichat-rs.mjs --debug  最適化せずに作る（速い）
 *   node tools/20_build/build-aichat-rs.mjs --test   テストだけ走らせる
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeExe, reportPlaced } from './place-exe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const crate = join(root, 'src', 'cli-rs');

const debug = process.argv.includes('--debug');
const testOnly = process.argv.includes('--test');

/** 子プロセスを走らせ、失敗したら止める */
function run(label, file, args, cwd) {
	process.stdout.write(`--- ${label} ---\n`);
	const res = spawnSync(file, args, { cwd, stdio: 'inherit' });
	if (res.error) {
		console.error(`${file} を起こせませんでした: ${res.error.message}`);
		process.exit(1);
	}
	if (res.status !== 0) {
		console.error(`${label} が失敗しました（終了コード ${res.status}）。`);
		process.exit(res.status ?? 1);
	}
}

// --- 1. 定義を書き出す ---

const optionsJson = join(crate, 'cli-options.json');
run(
	'定義を書き出す',
	process.execPath,
	[join(root, 'tools', '20_build', 'export-options.mjs'), '--out', optionsJson],
	root
);

// --- 2. 作る ---

if (testOnly) {
	run('テスト', 'cargo', ['test'], crate);
	process.stdout.write('\nテストだけ走らせました。\n');
	process.exit(0);
}

// テストを通してから作る。壊れたものを置き換えない
run('テスト', 'cargo', ['test'], crate);

const profile = debug ? [] : ['--release'];
run(debug ? 'ビルド（最適化なし）' : 'ビルド', 'cargo', ['build', ...profile], crate);

// --- 3. root に置く ---

const exeName = process.platform === 'win32' ? 'aichat-rs.exe' : 'aichat-rs';
const built = join(crate, 'target', debug ? 'debug' : 'release', exeName);
if (!existsSync(built)) {
	console.error(`できたはずの実行ファイルがありません: ${built.replace(root, '.')}`);
	process.exit(1);
}

/*
 * 置くのは aichat-rs だけ。既定の名前（aichat）への差し替えは
 * tools/20_build/install-aichat.mjs が行う。
 *
 * 分けてあるのは、ビルドが走るたびに既定が入れ替わらないようにするため。
 * 既定の aichat は他プロジェクトの待受けも掴んでいる。
 *
 * 置き場は dist/（ビルド出力）。かつては root に置いていたが、PATH から
 * 名前で呼べるようにするためだけの理由だったので、その前提が無くなった
 * i260924-06 のタイミングでフォルダ構成の原則どおりに直した。
 */
process.stdout.write('\n');

const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });
const dest = join(distDir, exeName);
reportPlaced(dest, placeExe(built, dest, join(root, 'tmp')), root);

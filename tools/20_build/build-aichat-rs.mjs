/*
 * Rust 版 CLI（aichat-rs）を作る。
 *
 * 手順は 3 つ。
 *   1. options.mjs から定義を JSON に書き出す（src/cli-rs/cli-options.json）
 *   2. cargo build --release
 *   3. できた実行ファイルを root に置く
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
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 大きさを読みやすく */
function humanSize(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
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

const dest = join(root, exeName);

/*
 * 走っている待受けが掴んでいると置き換えられない。
 *
 * Windows では走っている exe を消せないが、名前は変えられる。掴んでいる側は
 * 名前を変えたあとの実体を使い続けるので、退避しても落ちない（ローカルルール
 * 「exe を作り直すときは待受けを止めない」と同じ考え方）。
 */
try {
	copyFileSync(built, dest);
} catch (err) {
	if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
	const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
	const parked = join(root, 'tmp', `aichat-rs-old-${stamp}${process.platform === 'win32' ? '.exe' : ''}`);
	const { renameSync, mkdirSync } = await import('node:fs');
	mkdirSync(join(root, 'tmp'), { recursive: true });
	renameSync(dest, parked);
	copyFileSync(built, dest);
	process.stdout.write(`  待受けが掴んでいたので退避しました: ${parked.replace(root, '.')}\n`);
	process.stdout.write('    走っている待受けは落ちません。退避先を使い続けます\n');
}

process.stdout.write(`\n置きました: ./${exeName}（${humanSize(statSync(dest).size)}）\n`);

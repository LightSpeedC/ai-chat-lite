/*
 * 既定の CLI（aichat）を Rust 版に差し替える。
 *
 * 【ビルドと分けてある理由】
 * ビルドが走るたびに既定が入れ替わると、試しに作っただけのものが
 * 他プロジェクトの待受けにまで届いてしまう。差し替えは明示して行う。
 *
 * 【aichat という名前】
 * 共通ルールの待受けの手順には `aichat` としか書いていない。他プロジェクトは
 * この名前でしか呼ばないため、ここが実質の製品になる。
 *
 * 【置き場は bin/】
 * 共通ルール「共有ツールの置き場とPATH」により、他プロジェクトから名前で
 * 呼ばれる公開CLIは bin/ に置く（i260922-01）。PATHに追加するのも bin/ だけで、
 * プロジェクトルート自体は対象にしない。
 *
 * 実行ファイルは Git 管理外（.gitignore の *.exe）なので、取得した直後は無い。
 * 先に node tools/20_build/build-aichat-rs.mjs でビルドすること。
 *
 *   node tools/20_build/install-aichat.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { placeExe, reportPlaced } from './place-exe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = process.platform === 'win32';

const source = join(root, 'dist', win ? 'aichat-rs.exe' : 'aichat-rs');
const dest = join(root, 'bin', win ? 'aichat.exe' : 'aichat');

mkdirSync(join(root, 'bin'), { recursive: true });

if (!existsSync(source)) {
	console.error(`Rust 版がありません: ${source.replace(root, '.')}`);
	console.error('先に node tools/20_build/build-aichat-rs.mjs を実行してください。');
	process.exit(1);
}

reportPlaced(dest, placeExe(source, dest, join(root, 'tmp')), root);

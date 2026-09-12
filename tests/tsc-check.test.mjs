/*
 * CLI のソースを TypeScript の検査に掛ける。
 *
 * まだ TypeScript 化していないので、.mjs のまま allowJs ＋ checkJs で通す。
 * 設定は root の tsconfig.json にあり、対象は src/client/*.mjs。
 *
 * 【なぜテストに入れるか】
 * 目で読んでも見つからない型の食い違いが、実測で 5 件出た（JSON.parse の戻りを
 * object のまま辿っている・数値でない値を引き算している）。どれも今は落ちないが、
 * 落ちないことを誰も保証していない。検査は 320ms で終わるので、常時掛けておく。
 *
 * 【Mac ・ Linux でも動かすために】
 * node_modules/.bin/tsc は Windows だと .cmd になり、直接 spawn できない。
 * bin/tsc は shebang 付きの Node スクリプトなので、process.execPath に渡せば
 * どの OS でも同じ形で起動できる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

test('src/client の .mjs が tsc の型検査を通る', () => {
	/*
	 * 依存を入れていないと検査できない。黙って通すと穴になるので、
	 * 何をすればよいかを書いて落とす。
	 */
	assert.ok(existsSync(tsc), `typescript が入っていません。プロジェクトの root で npm install を実行してください（探した場所: node_modules/typescript/bin/tsc）`);

	const res = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '--project', root], {
		cwd: root,
		encoding: 'utf8',
	});

	const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();

	assert.equal(res.status, 0, `tsc が型エラーを報告しました:\n${out}`);
});

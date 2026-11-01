/*
 * グラデーション・var() で塗る地の前に、色だけの地を直書きで足す。
 *
 * 共通ルール「絶対ルール: 文字色と背景色は必ずペアで成立させる」に合わせるための道具。
 * Windows のプレビュー (Explorer の Alt+P)は、グラデーションと var() を含む宣言を捨てる。
 * 色だけの地が前にあれば、そこで止まって読める色になる。足す色は、その宣言の中の最初の色。
 *
 * 対象は git が追跡している資料の HTML と docs の CSS。アプリの画面 (src/web)は資料ではないので外す。
 *
 * 使い方:
 *   node tools/90_misc/solid-background.mjs          対象と件数を出すだけ (書き換えない)
 *   node tools/90_misc/solid-background.mjs --write  書き換える
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DECL = /background:\s*([^;{}]*(?:gradient\(|var\()[^;{}]*);/g;
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)/;
// 直前がすでに色だけの地なら足さない
const SOLID_BEFORE = /background:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\));\s*$/;

export function addSolidBackground(text) {
	return text.replace(DECL, (decl, value, offset) => {
		if (SOLID_BEFORE.test(text.slice(Math.max(0, offset - 200), offset))) return decl;
		const color = value.match(COLOR);
		if (!color) return decl;
		// 宣言の前の字下げ (行頭からの空白)をそろえる。行の途中なら空白 1 つで区切る
		const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
		const before = text.slice(lineStart, offset);
		const sep = /^\s*$/.test(before) ? `\n${before}` : ' ';
		return `background: ${color[0]};${sep}${decl}`;
	});
}

function listTargets(root) {
	const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: root, encoding: 'utf8' });
	return out.split('\0').filter((p) => p && !p.startsWith('src/') && (p.endsWith('.html') || p === 'docs/css/style.css'));
}

function main() {
	const write = process.argv.includes('--write');
	const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
	let files = 0;
	let total = 0;
	for (const rel of listTargets(root)) {
		const path = join(root, rel);
		const text = readFileSync(path, 'utf8');
		const next = addSolidBackground(text);
		if (next === text) continue;
		const count = next.split('background:').length - text.split('background:').length;
		files++;
		total += count;
		console.log(`${String(count).padStart(5)}  ${rel}`);
		if (write) writeFileSync(path, next, 'utf8');
	}
	console.log(`${write ? '書き換えました' : '対象 (書き換えていません)'}: ${files} ファイル ${total} か所`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

/*
 * 全角の丸かっこ（ ）を半角の ( ) に直す。
 *
 * 共通ルール「かっこは半角」に合わせるための道具。前に半角空白を 1 つ置く。
 * ただし行頭・空白の直後・開きの記号やタグの直後には置かない。
 *
 * 対象は git が追跡しているテキストのうち、手で書くものだけ。
 * 生成物 (.md は html2md、cli-options.json は export-options) は元を直してから作り直す。
 *
 * 使い方:
 *   node tools/90_misc/halfwidth-parens.mjs          対象と件数を出すだけ (書き換えない)
 *   node tools/90_misc/halfwidth-parens.mjs --write  書き換える
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// この直後のかっこには空白を足さない
const NO_SPACE_AFTER = new Set([' ', '\t', '\n', '\r', '　', '(', '[', '{', '<', '>', '「', '『', '【', '〈', '《', '"', "'", '`']);

function convertPlain(text, prefix = '') {
	let out = '';
	for (const ch of text) {
		if (ch === '（') {
			const prev = (prefix + out).at(-1);
			out += prev === undefined || NO_SPACE_AFTER.has(prev) ? '(' : ' (';
		} else if (ch === '）') {
			out += ')';
		} else {
			out += ch;
		}
	}
	return out;
}

// 正規表現の中では ( がグループの始まりになるので、\( にする。開きの / の直後には空白を置かない
function convertRegexBody(body) {
	let out = '';
	for (const ch of body) {
		if (ch === '（') {
			const prev = out.at(-1);
			out += prev === undefined || NO_SPACE_AFTER.has(prev) ? '\\(' : ' \\(';
		} else if (ch === '）') {
			out += '\\)';
		} else {
			out += ch;
		}
	}
	return out;
}

// JS の正規表現リテラル。割り算と紛れないよう、式の始まりに来る / だけを拾う
const REGEX_LITERAL = /(^|[=(,:!&|?{};]\s*|\breturn\s+|^\s+)\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuy]*)/gm;

export function toHalfwidthParens(text, { regex = false } = {}) {
	if (!regex) return convertPlain(text);
	let out = '';
	let last = 0;
	for (const m of text.matchAll(REGEX_LITERAL)) {
		const start = m.index + m[1].length;
		out += convertPlain(text.slice(last, start), out);
		out += `/${convertRegexBody(m[2])}/${m[3]}`;
		last = m.index + m[0].length;
	}
	return out + convertPlain(text.slice(last), out);
}

// 手で書くテキストの拡張子。cmd・bat は SJIS なので外す (別に text find で探す)
const TEXT_EXT = new Set(['.html', '.mjs', '.js', '.ts', '.rs', '.ps1', '.json', '.xml', '.toml', '.css']);
// 正規表現リテラルを持つ言語
const JS_EXT = new Set(['.mjs', '.js', '.ts']);
// 生成物。元を直してから作り直す
const GENERATED = [/\.md$/, /^src\/cli-rs\/cli-options\.json$/, /^notes\/91_history\//];
// 全角かっこを値として持つので、書き換えると壊れる
const SELF = ['tools/90_misc/halfwidth-parens.mjs', 'tests/halfwidth-parens.test.mjs'];

function listTargets(root) {
	const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: root, encoding: 'utf8' });
	return out.split('\0').filter((p) => p && TEXT_EXT.has(extname(p)) && !GENERATED.some((re) => re.test(p)) && !SELF.includes(p));
}

function main() {
	const write = process.argv.includes('--write');
	const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
	let files = 0;
	let total = 0;
	for (const rel of listTargets(root)) {
		const path = join(root, rel);
		const text = readFileSync(path, 'utf8');
		const count = (text.match(/[（）]/g) ?? []).length;
		if (count === 0) continue;
		files++;
		total += count;
		console.log(`${String(count).padStart(5)}  ${rel}`);
		if (write) writeFileSync(path, toHalfwidthParens(text, { regex: JS_EXT.has(extname(rel)) }), 'utf8');
	}
	console.log(`${write ? '書き換えました' : '対象 (書き換えていません)'}: ${files} ファイル ${total} か所`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

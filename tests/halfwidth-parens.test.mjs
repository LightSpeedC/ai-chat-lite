/*
 * 全角の丸かっこを半角へ直す道具 (tools/90_misc/halfwidth-parens.mjs) の置き換え規則。
 *
 * 共通ルール「かっこは半角」は、丸かっこを半角の ( ) にし、前に半角空白を 1 つ置くとする。
 * 期待値は手で書いた。道具の出力から作ると、何を出しても通るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toHalfwidthParens } from '../tools/90_misc/halfwidth-parens.mjs';

test('文中の全角かっこは、前に半角空白を 1 つ置いた半角かっこになる', () => {
	assert.equal(toHalfwidthParens('内容（中身）です'), '内容 (中身)です');
});

test('かっこの直前がすでに空白なら、空白を重ねない', () => {
	assert.equal(toHalfwidthParens('内容 （中身）'), '内容 (中身)');
	assert.equal(toHalfwidthParens('\t（中身）'), '\t(中身)');
});

test('行頭のかっこには空白を足さない', () => {
	assert.equal(toHalfwidthParens('（中身）\n（次）'), '(中身)\n(次)');
	assert.equal(toHalfwidthParens('a\r\n（中身）'), 'a\r\n(中身)');
});

test('開きの記号やタグの直後のかっこには空白を足さない', () => {
	assert.equal(toHalfwidthParens('<td>（例）</td>'), '<td>(例)</td>');
	assert.equal(toHalfwidthParens('「（例）」'), '「(例)」');
	assert.equal(toHalfwidthParens("'（例）'"), "'(例)'");
	assert.equal(toHalfwidthParens('"（例）"'), '"(例)"');
	assert.equal(toHalfwidthParens('`（例）`'), '`(例)`');
	assert.equal(toHalfwidthParens('（（二重））'), '((二重))');
});

// 正規表現の中で ( にすると、グループの始まりとして読まれて壊れる。実際に 26 件の試験が落ちた
test('JS の正規表現リテラルの中では、エスケープした半角かっこになる', () => {
	const js = { regex: true };
	assert.equal(toHalfwidthParens('assert.match(s, /待受け中（最大/);', js), 'assert.match(s, /待受け中 \\(最大/);');
	assert.equal(toHalfwidthParens('const m = s.match(/（(\\d+)）/);', js), 'const m = s.match(/\\((\\d+)\\)/);');
	assert.equal(toHalfwidthParens('const m = /送信しました（(\\d+)）/.exec(s);', js), 'const m = /送信しました \\((\\d+)\\)/.exec(s);');
});

test('JS でも、正規表現の外の文字列とコメントは普通に直す', () => {
	const js = { regex: true };
	assert.equal(toHalfwidthParens("say('内容（中身）'); // 補足（注）", js), "say('内容 (中身)'); // 補足 (注)");
	assert.equal(toHalfwidthParens('const r = a / b; // 割る（二つ）', js), 'const r = a / b; // 割る (二つ)');
});

test('正規表現として扱わないときは、正規表現リテラルも普通に直す', () => {
	assert.equal(toHalfwidthParens('/待受け中（最大/'), '/待受け中 (最大/');
});

test('全角かっこが無ければ、文字列をそのまま返す', () => {
	assert.equal(toHalfwidthParens('a (b) c'), 'a (b) c');
});

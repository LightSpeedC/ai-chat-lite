/*
 * グラデーション・var() の地の前に、色だけの地を足す道具 (tools/90_misc/solid-background.mjs)。
 *
 * 共通ルール「絶対ルール: 文字色と背景色は必ずペアで成立させる」に従う。Windows のプレビュー
 * (Explorer の Alt+P)は、グラデーションと var() を含む宣言を捨てるため、白い字が白い地に乗る。
 * 期待値は手で書いた。道具の出力から作ると、何を出しても通るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addSolidBackground } from '../tools/90_misc/solid-background.mjs';

test('グラデーションの地の前に、その中の最初の色を直書きした地を足す', () => {
	assert.equal(
		addSolidBackground('h1 {\n\tbackground: linear-gradient(100deg, var(--accent, #12224d), var(--accent2, #2f5fbf));\n\tcolor: #fff;\n}'),
		'h1 {\n\tbackground: #12224d;\n\tbackground: linear-gradient(100deg, var(--accent, #12224d), var(--accent2, #2f5fbf));\n\tcolor: #fff;\n}',
	);
});

test('var() だけの地にも、既定値の色を直書きした地を足す', () => {
	assert.equal(addSolidBackground('code {\n\tbackground: var(--code-bg, #f4f6fa);\n}'), 'code {\n\tbackground: #f4f6fa;\n\tbackground: var(--code-bg, #f4f6fa);\n}');
});

test('1 行に書いた宣言では、同じ行の前に足す', () => {
	assert.equal(addSolidBackground('.b { background: linear-gradient(100deg, #1d7a3c, #45b56c); color: #fff; }'), '.b { background: #1d7a3c; background: linear-gradient(100deg, #1d7a3c, #45b56c); color: #fff; }');
});

test('すでに色だけの地が前にあれば、重ねて足さない (何度流しても同じ)', () => {
	const done = 'h1 {\n\tbackground: #12224d;\n\tbackground: linear-gradient(100deg, var(--accent, #12224d), #fff);\n}';
	assert.equal(addSolidBackground(done), done);
});

test('色だけの地・色の無い var() には触らない', () => {
	assert.equal(addSolidBackground('a { background: #fff; }'), 'a { background: #fff; }');
	assert.equal(addSolidBackground('a { background: var(--soft); }'), 'a { background: var(--soft); }');
});

test('hsl() と rgba() も色として拾う', () => {
	assert.equal(addSolidBackground('a { background: linear-gradient(180deg, hsl(280, 28%, 95%), #fff); }'), 'a { background: hsl(280, 28%, 95%); background: linear-gradient(180deg, hsl(280, 28%, 95%), #fff); }');
});

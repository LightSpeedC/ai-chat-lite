import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderBody, escapeText } from '../src/web/js/markdown.js';

// --- ここが画面で唯一の攻撃面になるため、通す・通さないを明示的に固定する ---

test('生の HTML はタグにならない', () => {
	const out = renderBody('<img src=x onerror="alert(1)">');
	assert.ok(!out.includes('<img'), out);
	assert.ok(out.includes('&lt;img'), out);
});

test('script タグも文字として出る', () => {
	const out = renderBody('<script>alert(1)</script>');
	assert.ok(!out.includes('<script'), out);
	assert.ok(out.includes('&lt;script&gt;'), out);
});

test('コードブロックの中の HTML も無害化される', () => {
	const out = renderBody('```\n<b>tag</b>\n```');
	assert.ok(out.includes('<pre><code>&lt;b&gt;tag&lt;/b&gt;</code></pre>'), out);
});

test('javascript: はリンクにならない', () => {
	// 自動リンクの対象を http と https に限っているため
	const out = renderBody('javascript:alert(1)');
	assert.ok(!out.includes('<a '), out);
});

test('& が二重にエスケープされない', () => {
	assert.equal(escapeText('a & b'), 'a &amp; b');
	assert.equal(renderBody('a & b'), 'a &amp; b');
});

// --- 通す記法 ---

test('太字', () => {
	assert.equal(renderBody('**太字**'), '<strong>太字</strong>');
});

test('インラインコード', () => {
	assert.equal(renderBody('`code`'), '<code>code</code>');
});

test('コードブロック', () => {
	assert.equal(renderBody('```\nconst x = 1;\n```'), '<pre><code>const x = 1;</code></pre>');
});

test('コードブロックの中の改行は <br> にならない', () => {
	// pre の中で二重に改行されてしまうため、先に退避してから改行を処理している
	const out = renderBody('```\n1 行目\n2 行目\n```');
	assert.equal(out, '<pre><code>1 行目\n2 行目</code></pre>');
	assert.ok(!out.includes('<br>'), out);
});

test('本文の改行は <br> になる', () => {
	assert.equal(renderBody('1 行目\n2 行目'), '1 行目<br>2 行目');
});

test('http と https は自動リンクになる', () => {
	assert.ok(renderBody('http://localhost:8787/').includes('<a href="http://localhost:8787/"'));
	assert.ok(renderBody('https://example.com/x').includes('<a href="https://example.com/x"'));
});

test('自動リンクには rel="noopener" が付く', () => {
	assert.ok(renderBody('https://example.com').includes('rel="noopener"'));
});

test('複数の記法が混ざっても壊れない', () => {
	const out = renderBody('**太字** と `コード` と\n```\nconst x = 1;\n```');
	assert.ok(out.includes('<strong>太字</strong>'), out);
	assert.ok(out.includes('<code>コード</code>'), out);
	assert.ok(out.includes('<pre><code>const x = 1;</code></pre>'), out);
});

test('コードブロックの中の記法は解釈されない', () => {
	const out = renderBody('```\n**太字ではない**\n```');
	assert.ok(!out.includes('<strong>'), out);
	assert.ok(out.includes('**太字ではない**'), out);
});

test('閉じていない記法はそのまま出る', () => {
	assert.equal(renderBody('**閉じていない'), '**閉じていない');
	assert.equal(renderBody('`閉じていない'), '`閉じていない');
});

test('空文字でも壊れない', () => {
	assert.equal(renderBody(''), '');
});

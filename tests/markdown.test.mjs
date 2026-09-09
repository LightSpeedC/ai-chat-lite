import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { renderBody, escapeText } from '../src/web/js/markdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKDOWN_JS_PATH = join(HERE, '..', 'src', 'web', 'js', 'markdown.js');

/*
 * 【なぜ必要か】
 * PLACEHOLDER をバイト値 0 の 1 文字リテラルで書くと、git がこのファイルを
 * -text（バイナリ）と判定する。以後 diff は "Binary files … differ" にしか
 * ならず、ripgrep も定義の行を返さない。escapeText や自動リンクの文字集合が
 * 1 文字戻っても diff に出ず、grep は 0 件を返す（0 件が正常に見える失敗）。
 * XSS 対策を止めている唯一のファイルが、レビューもコミット前確認も
 * 素通りすることになる。ソースをそのまま読んで確かめる。
 */
test('ソースに NUL バイトが無い（git のバイナリ判定を避けるため）', () => {
	const bytes = readFileSync(MARKDOWN_JS_PATH);
	const nulAt = bytes.indexOf(0);
	assert.equal(nulAt, -1, `${nulAt} バイト目に NUL がある。PLACEHOLDER はエスケープ記法（\\u0000）で書く`);
});

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

/*
 * 【なぜ必要か】
 * タグを塞いでも、属性の中に入る値は " 1 文字で抜け出せる。自動リンクが
 * href="…" に埋めるため、URL の文字集合が " を含んでいると、他の参加者の
 * 本文で on… の属性を足せた。同一オリジンから /api/admin/* が本番では
 * 認証なしに通るので、片付けとサーバー停止まで画面越しに届いていた。
 */
test('" は属性から抜け出せない', () => {
	const out = renderBody('https://example.com/a"onmouseover="alert(1)');
	// タグの中に属性が生えていない。href は 1 つだけ
	assert.ok(!/<a [^>]*onmouseover/.test(out), out);
	assert.equal((out.match(/href=/g) ?? []).length, 1, out);
	// 抜け出そうとしたクォートは実体参照になり、本文として残る
	assert.ok(out.includes('&quot;onmouseover=&quot;'), out);
});

test('" は実体参照になる', () => {
	assert.equal(escapeText('a " b'), 'a &quot; b');
	assert.equal(renderBody('a " b'), 'a &quot; b');
});

/*
 * 【なぜ必要か】
 * 自動リンクの文字集合に < > が残っていると、直後に自分で生成したタグ
 * （<code> や <strong>、コードブロックを戻した <pre><code>）を URL ごと
 * 飲み込む。href の中に入るだけなら実害は無いが、リンクの表示文字にも
 * 同じ値を使っているため、そちらは innerHTML としてそのまま解釈される。
 * 飲み込まれた <code> がタグとして生き返り、意図しない入れ子になる。
 */
test('自動リンクは直後の生成タグを飲み込まない', () => {
	const out = renderBody('https://example.com/`x`');
	assert.ok(!out.includes('<code>x</code>" '), out);
	assert.ok(!/href="[^"]*<code>/.test(out), out);
	assert.equal(out, '<a href="https://example.com/" target="_blank" rel="noopener">https://example.com/</a><code>x</code>');
});

test('リンクの直後の " はリンクに含まれない', () => {
	// 文字集合から外したので、URL はクォートの手前で切れる
	const out = renderBody('https://example.com" data-x=1');
	assert.ok(out.includes('href="https://example.com"'), out);
	assert.ok(!out.includes('data-x=1"'), out);
	assert.ok(out.includes('&quot;'), out);
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

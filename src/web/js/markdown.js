/**
 * 本文を最小限だけ Markdown として解釈する。
 *
 * ここが画面で唯一の攻撃面になる。ローカル限定・認証なしとはいえ、AI が外部から
 * 取得した文字列をそのまま投稿する経路は現実にあり得るため、依存パッケージを
 * 入れずに自前で持ち、範囲を絞って扱う。
 *
 * 順序が重要で、先に全体をエスケープしてから記法を処理する。
 * この順にすれば、本文に生の HTML が含まれていてもタグとして解釈される経路が無い。
 */

/**
 * HTML として意味を持つ文字を実体参照に置き換える。
 *
 * " も対象にする。タグを作れなくても、属性の中に入る値であれば " 1 文字で
 * 抜け出せる。自動リンクが href="…" に埋めるため、ここが唯一の入口になる。
 */
export function escapeText(src) {
	return String(src)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * コードブロックを退避するときの目印。
 *
 * String.fromCharCode(0) で組み立てる。バイト値 0 を 1 文字リテラルで
 * ソースに埋め込むと、git がこのファイルをバイナリ（-text）と判定する。
 * 以後 diff は "Binary files … differ" にしかならず、ripgrep もこの定義の
 * 行を返さない。関数呼び出しにすれば、ソースには制御文字が 1 バイトも残らない。
 *
 * msg_body はこの文字をそのまま素通しする（requireBody は文字数上限だけを見る）。
 * 本文に 2 つ挟んで数字を囲む形を含めると、6 の復元処理がその位置を
 * blocks[n] に置き換えてしまう（本文はエスケープ済みなので注入にはならない）。
 */
const PLACEHOLDER = String.fromCharCode(0);

export function renderBody(src) {
	// 1. 先にすべてエスケープする。ここで raw HTML の混入経路が塞がれる
	let s = escapeText(src);

	// 2. コードブロックは中の改行を残したいので、先に退避しておく。
	//    ここで退避しておかないと、あとの改行処理で <br> が混ざる
	const blocks = [];
	s = s.replace(/```([\s\S]*?)```/g, (_, code) => {
		blocks.push(code.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
		return `${PLACEHOLDER}${blocks.length - 1}${PLACEHOLDER}`;
	});

	// 3. 行内の記法
	s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
	s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

	// 4. 自動リンク。http と https だけを対象にする（javascript: を通さないため）。
	//
	//    & は &amp; の形だけ通す。エスケープ済みなので URL 内の & は &amp; に
	//    なっており、& を丸ごと外すとクエリ付きの URL が最初の &amp; の手前で
	//    切れる。href が投稿された URL と別のものになり、残りが「amp;b=2」と
	//    いう文字列として本文に落ちる（クエリ付き URL はよく貼られる）。
	//
	//    ただし & を無条件に通すと、&quot; &lt; &gt; まで URL に入ってしまう。
	//    エスケープ後は " < > がその形になっているので、下の「外す理由」が
	//    そのまま崩れる。だから &amp; だけを許し、他の実体参照では切る
	//
	//    " と ' も文字集合から外す。escapeText が " を実体参照にしているので
	//    ここに生の " は来ないが、属性値に埋める側でも閉じておく。
	//    片方だけに頼ると、エスケープの範囲を変えたときに黙って開く
	//
	//    < と > も外す。無いと、直後に自分で生成した <code> や <strong>、
	//    戻したコードブロックの <pre><code> を URL ごと飲み込む。href の中身
	//    だけならまだしも、表示文字にも同じ値を使っているため、そちらは
	//    innerHTML としてそのまま解釈され、飲み込んだタグが生き返ってしまう
	s = s.replace(
		/(https?:\/\/(?:[^\s&"'<>]|&amp;)+)/g,
		'<a href="$1" target="_blank" rel="noopener">$1</a>'
	);

	// 5. 残った改行
	s = s.replace(/\r?\n/g, '<br>');

	// 6. コードブロックを戻す
	s = s.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_, i) => {
		return `<pre><code>${blocks[Number(i)]}</code></pre>`;
	});

	return s;
}

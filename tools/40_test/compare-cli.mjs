/*
 * node 版と Rust 版の CLI を同じ引数で走らせ、出力と終了コードを比べる。
 *
 * 【なぜ道具にするか】
 * CLI が 3 本になり、突き合わせは何度も回す。そのたびに書き捨てると、
 * 比べ方が毎回変わって結果を信じられなくなる。
 *
 * tests/cli-rs.test.mjs はサーバーに繋がない呼び出しだけを見る。こちらは
 * 立っているテストサーバーへ実際に繋いで、投稿や履歴まで突き合わせる。
 *
 *   node tools/40_test/compare-cli.mjs who
 *   node tools/40_test/compare-cli.mjs --mask-numbers say :me: "本文"
 *   node tools/40_test/compare-cli.mjs --file tools/40_test/compare-cases.json
 *
 * 【--mask-numbers】
 * msg_seq のように投稿のたびに増える値は、伏せてから比べる。
 * 伏せないと「違う」のか「番号が進んだ」のか分からない。
 *
 * 接続先とアクセストークンは、立っているテスト用サーバーの server.json から読む。
 * 値は画面に出さない。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = join(root, 'dist', process.platform === 'win32' ? 'aichat-rs.exe' : 'aichat-rs');
const nodeCli = join(root, 'src', 'client', 'chat.mjs');

/** 立っているテスト用サーバーの接続先を読む */
function testServer() {
	const info = join(process.env.AICHAT_DATA ?? join(root, 'tmp', '_data'), 'server.json');
	if (!existsSync(info)) return null;
	try {
		const { port, access_token } = JSON.parse(readFileSync(info, 'utf8'));
		return { port: String(port), token: access_token ?? '' };
	} catch {
		return null;
	}
}

/** 数字を伏せる。投稿のたびに増える値を「違い」と数えないため */
const maskNumbers = (text) => text.replace(/\d+/g, 'N');

/**
 * 状態を変えるコマンド用に、両者へ別々の ID を割り当てる。
 *
 * 【なぜ要るか】
 * wait の初回接続は「案内を出してカーソルを立てて終わる」。同じ ID で
 * node → Rust の順に走らせると、Rust は 2 回目になって案内が出ない。
 * 比べているのは実装の差ではなく、走らせた順になってしまう。
 *
 * 引数の {ID} を、node 側は cmp-node-xx、Rust 側は cmp-rust-xx に置き換え、
 * 出力では両方を {ID} に戻してから比べる。**長さを同じにする**のは、
 * 桁を揃える出力で幅が変わらないようにするため。
 */
function idPair() {
	const tag = Math.random().toString(36).slice(2, 6).replace(/\d/g, 'x');
	return { node: `cmp-node-${tag}`, rust: `cmp-rust-${tag}` };
}

/** 1 通りを走らせて結果を返す */
export function compare(args, { mask = false } = {}) {
	const server = testServer();
	const conn = server ? ['-p', server.port, '-a', server.token] : [];
	const opts = { cwd: root, encoding: 'utf8' };

	const usesId = args.some((a) => a.includes('{ID}'));
	const ids = idPair();
	const fill = (who) => args.map((a) => a.replaceAll('{ID}', ids[who]));

	const n = spawnSync(process.execPath, [nodeCli, ...fill('node'), ...conn], opts);
	const r = spawnSync(exe, [...fill('rust'), ...conn], opts);

	const clean = (run, who) => {
		let text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
		if (usesId) text = text.replaceAll(ids[who], '{ID}');
		return mask ? maskNumbers(text) : text;
	};
	const nodeOut = clean(n, 'node');
	const rustOut = clean(r, 'rust');

	return {
		args,
		same: nodeOut === rustOut && n.status === r.status,
		node: { out: nodeOut, code: n.status },
		rust: { out: rustOut, code: r.status },
	};
}

/** 違いを読める形にする */
function showDiff(result) {
	const nodeLines = result.node.out.split('\n');
	const rustLines = result.rust.out.split('\n');
	const max = Math.max(nodeLines.length, rustLines.length);
	let shown = 0;
	for (let i = 0; i < max && shown < 6; i++) {
		if (nodeLines[i] === rustLines[i]) continue;
		console.log(`    ${i + 1} 行目`);
		console.log(`      node: ${JSON.stringify(nodeLines[i] ?? '(無し)')}`);
		console.log(`      rust: ${JSON.stringify(rustLines[i] ?? '(無し)')}`);
		shown++;
	}
	if (result.node.code !== result.rust.code) {
		console.log(`    終了コード node=${result.node.code} rust=${result.rust.code}`);
	}
}

// --- 本体 ---

if (!existsSync(exe)) {
	console.error('aichat-rs がありません。先に node tools/20_build/build-aichat-rs.mjs を走らせてください。');
	process.exit(1);
}

const argv = process.argv.slice(2);
const mask = argv.includes('--mask-numbers');
const fileAt = argv.indexOf('--file');

/** 走らせる一覧。--file が無ければコマンドラインの残りを 1 通りとして扱う */
let cases;
if (fileAt >= 0) {
	const path = argv[fileAt + 1];
	if (!path) {
		console.error('--file には一覧の置き場を渡してください。');
		process.exit(2);
	}
	cases = JSON.parse(readFileSync(join(root, path), 'utf8'));
} else {
	cases = [argv.filter((a) => a !== '--mask-numbers')];
}

let ok = 0;
let ng = 0;
for (const entry of cases) {
	// 一覧では { args, mask } の形も受ける
	const args = Array.isArray(entry) ? entry : entry.args;
	const useMask = Array.isArray(entry) ? mask : (entry.mask ?? mask);
	const result = compare(args, { mask: useMask });
	if (result.same) {
		ok++;
		console.log(`一致   ${args.join(' ') || '（引数なし）'}`);
	} else {
		ng++;
		console.log(`差分   ${args.join(' ') || '（引数なし）'}`);
		showDiff(result);
	}
}

console.log(`\n一致 ${ok} / 差分 ${ng}`);
process.exit(ng === 0 ? 0 : 1);

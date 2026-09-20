/*
 * 実行ファイルを置く。掴まれていたら、消さずに逃がしてから置く。
 *
 * 【なぜ消さないか】
 * 走っている待受けが exe を掴んでいる。待受けは 12 時間張りっぱなしになり、
 * 掴んでいるのは自分の分だけではない。他プロジェクトの待受けも混ざる。
 * 止めれば相手は原因不明の exit 255 で落ちる（ローカルルール 3）。
 *
 * Windows では走っている exe を削除できないが、名前は変えられる。改名は
 * ディレクトリの項目を書き換えるだけで、開かれている実体には触らないため、
 * 走っているプロセスは改名後の実体を使い続ける。空いた名前に新しいものを置ける。
 *
 * この前提は tests/exe-swap.test.mjs が実物の exe を走らせて確かめている。
 */
import { copyFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * 逃がした先の名前を組み立てる。
 *
 * 形は `<名前>-old-yyyyMMdd-HHmmss.exe`。呼び出し側とここで揃えてある。
 * 揃えないと、掃除する側が自分の置いたものしか見つけられない。
 */
function parkedName(stem, ext, when = new Date()) {
	const p = (n, len = 2) => String(n).padStart(len, '0');
	const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
	return `${stem}-old-${stamp}${ext}`;
}

/**
 * 前に逃がしたものを消す。掴まれていれば消えないので、失敗は無視する。
 *
 * 【置く側が片付ける】
 * 掃除を別の場所に持つと、名前を分けたときに対象から漏れる。実際に
 * （かつての C# 版ビルドで）出力先を aichat-cs.exe へ移したとき、
 * aichat-old-*.exe が誰にも消されない状態になった。
 * **置いた本人が、次に置くときに片付ける。**
 *
 * @returns {{ found: number, removed: number }}
 */
export function sweepParked(stem, ext, tmpDir) {
	let found = 0;
	let removed = 0;
	let names;
	try {
		names = readdirSync(tmpDir);
	} catch {
		return { found, removed };
	}
	const prefix = `${stem}-old-`;
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
		found++;
		try {
			unlinkSync(join(tmpDir, name));
			removed++;
		} catch {
			// まだ待受けが掴んでいる。次に置くときにまた試す
		}
	}
	return { found, removed };
}

/** 大きさを読みやすく */
export function humanSize(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * built を dest へ置く。掴まれていたら dest を tmpDir へ逃がしてから置く。
 *
 * 逃がし先は dest と同じボリュームでなければ改名できない。tmpDir には
 * プロジェクト直下の tmp/ を渡すこと。
 *
 * @returns {string | null} 逃がした先。逃がす必要がなければ null
 */
export function placeExe(built, dest, tmpDir) {
	const name = basename(dest);
	const ext = name.endsWith('.exe') ? '.exe' : '';
	const stem = ext ? name.slice(0, -ext.length) : name;

	// 置く前に、前に逃がした分を片付ける。掴まれているものは残る
	const swept = sweepParked(stem, ext, tmpDir);

	try {
		copyFileSync(built, dest);
		return { parked: null, swept };
	} catch (err) {
		if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;

		const parked = join(tmpDir, parkedName(stem, ext));
		mkdirSync(tmpDir, { recursive: true });
		renameSync(dest, parked);
		copyFileSync(built, dest);
		return { parked, swept };
	}
}

/** 置いた結果を報告する。root からの相対で書く */
export function reportPlaced(dest, result, root, write = process.stdout.write.bind(process.stdout)) {
	const { parked, swept } = result;
	if (swept && swept.found > 0) {
		write(
			`  逃がしてあった ${swept.found} 本のうち ${swept.removed} 本を消しました` +
				`（残り ${swept.found - swept.removed} 本は掴まれています）\n`
		);
	}
	if (parked) {
		write(`  待受けが掴んでいたので逃がしました: ${parked.replace(root, '.')}\n`);
		write('    走っている待受けは落ちません。逃がした先を使い続けます\n');
	}
	write(`置きました: ${dest.replace(root, '.')}（${humanSize(statSync(dest).size)}）\n`);
}

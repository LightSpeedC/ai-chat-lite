import { existsSync, readFileSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';

import { ROOT } from './config.mjs';
import { log } from './log.mjs';

/**
 * メンテナンスの印。このファイルがある間はサーバーを開始しない。
 *
 * 用途は DB の作り替えや整理。スキーマを変えたり中身を入れ替えたりする間、
 * サービスに勝手に起動されると DB を掴まれて手が出せなくなる。印を置いておけば
 * 何度落としても待機で止まり、作業が終わって印を消した時点で自分から起動する。
 *
 * 使い方:
 *   1. _data\MAINTENANCE を作る（中身に理由を書くとログに出る）
 *   2. サーバーを落とす（chat.mjs restart でよい。起動しようとして待機に入る）
 *   3. DB を好きに触る
 *   4. 印を消す → 数秒で自分から起動する
 */
export const MAINTENANCE_FILE = join(ROOT, '_data', 'MAINTENANCE');

/** 印があるか */
export function isUnderMaintenance(file = MAINTENANCE_FILE) {
	return existsSync(file);
}

/** 印に書かれた理由。空でもよい */
export function readReason(file = MAINTENANCE_FILE) {
	try {
		return readFileSync(file, 'utf8').trim();
	} catch {
		return '';
	}
}

/**
 * 印が消えるまで待つ。最初から無ければ待たない。
 *
 * @returns {Promise<boolean>} 待ったかどうか
 */
export function waitUntilCleared({ file = MAINTENANCE_FILE, pollMs = 3000 } = {}) {
	return new Promise((resolve) => {
		if (!isUnderMaintenance(file)) {
			resolve(false);
			return;
		}

		const reason = readReason(file);
		log.warn('メンテナンスの印があるため、起動を保留します');
		log.warn(`  印: ${file}`);
		if (reason) log.warn(`  理由: ${reason}`);
		log.warn('  この印を消すと、自分から起動します');

		let settled = false;
		let watcher = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			try {
				watcher?.close();
			} catch {
				/* 閉じられなくても支障はない */
			}
			log.info('メンテナンスの印が消えました。起動を続けます');
			resolve(true);
		};

		// fs.watch は取りこぼすことがあるため、ポーリングも併せて回す。
		// 印を消してから起動するまでの遅れは、この間隔が上限になる
		const timer = setInterval(() => {
			if (!isUnderMaintenance(file)) finish();
		}, pollMs);

		// ファイル自体ではなく親フォルダを見る。消えたあとの監視は続かないため
		try {
			watcher = watch(dirname(file), (_event, name) => {
				if (name === basename(file) && !isUnderMaintenance(file)) finish();
			});
		} catch {
			// 監視できない環境でもポーリングで拾える
		}
	});
}

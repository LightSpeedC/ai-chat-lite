import { nowJst } from './time.mjs';

/**
 * 1 行 1 件のログを出す。
 *
 *   2026-08-29 23:20:37.059 INFO  ai-chat-lite サーバーを起動しました
 *
 * 先頭を固定長の JST 日時にしているため、ログを行単位で並べ替えても時系列が崩れない。
 * レベルは 5 文字に揃えて、以降のメッセージの開始位置を固定する。
 *
 * ERROR も stdout に出す。WinSW は標準出力と標準エラーを別ファイルに分けるため、
 * 分けてしまうと 1 つの事象を追うのに 2 つのファイルを突き合わせることになる。
 */
function write(level, message) {
	console.log(`${nowJst()} ${level.padEnd(5)} ${message}`);
}

export const log = {
	debug: (message) => write('DEBUG', message),
	info: (message) => write('INFO', message),
	warn: (message) => write('WARN', message),
	error: (message) => write('ERROR', message),
};

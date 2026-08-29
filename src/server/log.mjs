import { nowJst } from './time.mjs';

/**
 * 1 行 1 件のログを出す。
 *
 *   2026-08-30 00:44:37.119 INFO  ai-chat-lite サーバーを起動しました
 *
 * 先頭を固定長の JST 日時にしているため、ログを行単位で並べ替えても時系列が崩れない。
 * レベルは 5 文字に揃えて、以降のメッセージの開始位置を固定する。
 *
 * ファイルへの書き出しは WinSW に任せる。標準出力は out.log、標準エラーは err.log に
 * 転送される。XML の logpath には %BASE% を付けること。相対パスはサービスの
 * カレントディレクトリ（C:\Windows\System32）を基準に解決されてしまう。
 */
function format(level, message) {
	return `${nowJst()} ${level.padEnd(5)} ${message}`;
}

export const log = {
	debug: (message) => console.log(format('DEBUG', message)),
	info: (message) => console.log(format('INFO', message)),
	warn: (message) => console.log(format('WARN', message)),
	// ERROR だけ標準エラーへ。WinSW が err.log に分けて記録する
	error: (message) => console.error(format('ERROR', message)),
};

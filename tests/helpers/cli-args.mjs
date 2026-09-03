/**
 * CLI を呼ぶときの引数を組み立てる。
 *
 * 名乗る ID はオプション（--connector-id / -c）ではなく、コマンドの直後の
 * 位置引数になった。末尾に足すことができないので、テスト側も同じ形で呼ぶ。
 *
 * 場所を固定したこと自体が変更の目的である。テストが末尾に足す抜け道を持つと、
 * 「コマンドの次の語が ID」という前提を検査できなくなる。
 */
import { ID_WRAP } from '../../src/client/options.mjs';

/**
 * 名乗る ID を取らないコマンド。
 *
 * 読むだけのコマンドは名乗る必要がない。--help はコマンドの代わりに置ける。
 * chat.mjs 側の READ_ONLY と揃えること。あちらは import できない
 * （トップレベルでコマンドを走らせる作りのため）。
 */
export const NO_ID = new Set(['recent', 'who', 'dump', 'archives', '--help', '-h']);

/** ID をコロンで囲む */
export function wrapId(connectorId) {
	return `${ID_WRAP}${connectorId}${ID_WRAP}`;
}

/**
 * コマンドの直後に名乗る ID を差し込む。
 *
 * args の先頭はコマンド。ID を取らないコマンドはそのまま返す。
 */
export function withId(args, connectorId) {
	const [command, ...rest] = args;
	if (NO_ID.has(command)) return args;
	return [command, wrapId(connectorId), ...rest];
}

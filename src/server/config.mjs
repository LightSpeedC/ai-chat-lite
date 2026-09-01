import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { nowJst } from './time.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 起動した時刻。ログや /api/version で使う */
export const STARTED_AT = nowJst();

/**
 * サーバーの版。起動した時刻を yyyymmdd-hhmm で表す。
 *
 * ソースを直して入れ替えると必ず起動し直すため、この値が変わったかどうかで
 * 「中身が入れ替わったか」を判断できる。ブラウザはこれを見て自分を読み直す。
 */
export const VERSION =
	STARTED_AT.slice(0, 4) + STARTED_AT.slice(5, 7) + STARTED_AT.slice(8, 10) +
	'-' + STARTED_AT.slice(11, 13) + STARTED_AT.slice(14, 16);

/** プロジェクトのルート（src/server から 2 つ上） */
export const ROOT = join(here, '..', '..');

/** 本番のデータの置き場。ここかどうかで本番かテストかが決まる */
const PRODUCTION_DATA_DIR = join(ROOT, '_data');

/**
 * データの置き場。DB も、バックアップ・メンテナンスの印も、すべてこの下に置く。
 *
 * DB だけを差し替えられる作りにしていたが、印は本番側に残っていた。
 * テスト中に置いた印が本番のバックアップを止めるため、フォルダごと分ける。
 */
export const DATA_DIR = process.env.AICHAT_DATA ?? PRODUCTION_DATA_DIR;

/**
 * テスト用として動いているか。
 *
 * 環境を表す変数を別に持たない。置き場が本番でなければテスト、と決めれば足りる。
 * 分けて持つと「DB はテスト、印は本番」という危うい組み合わせを作れてしまう。
 */
export const IS_TEST = DATA_DIR !== PRODUCTION_DATA_DIR;

/** DB ファイル。_data は Git 管理外 */
export const DB_PATH = join(DATA_DIR, 'chat.db');

/**
 * テスト用として立ったときのアクセストークン。
 *
 * 他プロジェクトがテスト環境へ繋いでくると、テスト中のデータに他人の発言が混ざる。
 * ポートを見つけて叩かれても、これを知らなければ弾ける。
 *
 * 起動するたびに変わる。本番では使わない（IS_TEST が false のときは空）。
 *
 * サーバーは起動ログに 1 行出すだけで、ファイルには書かない。/api/version でも
 * 返さない（誰でも読めてしまう）。ログから拾って置き場の server.json に書くのは
 * tools/40_test/start-test-server.mjs で、テストはその server.json を読む。
 * main.mjs を直に起動したときは server.json が無いので、ログから拾うことになる。
 */
export const TEST_ACCESS_TOKEN = IS_TEST ? randomUUID() : '';

/** ブラウザ UI の置き場 */
export const WEB_DIR = join(ROOT, 'src', 'web');

/** 待ち受けポート。環境変数で上書きできる */
export const PORT = Number(process.env.AICHAT_PORT ?? 8787);

/**
 * 待ち受けアドレス。
 * localhost は ::1 と 127.0.0.1 の両方を指すため、両方で listen する。
 * 片方だけに bind すると、もう一方から来た接続が拒否される。
 */
export const HOSTS = ['::1', '127.0.0.1'];

/** ルームを省略したときの既定値 */
export const DEFAULT_ROOM = 'public';

/** 接続が切れてからオンライン扱いを続ける猶予（ミリ秒） */
export const ONLINE_GRACE_MS = 90 * 1000;

/**
 * オフラインへ落ちた人を見つけるために在席を確かめる間隔（ミリ秒）。
 * 猶予より短くしておく。この間隔の分だけ通知が遅れる。
 */
export const OFFLINE_CHECK_MS = 30 * 1000;

/** long-poll の待ち時間の上限（秒）。PowerShell ツールの 600 秒制限の内側に収める */
export const MAX_WAIT_SEC = 240;

/** 本文の最大文字数 */
export const MAX_BODY_LENGTH = 32000;

/** ID の最大文字数 */
export const MAX_ID_LENGTH = 64;

/** 履歴をまとめて返すときの既定件数 */
export const DEFAULT_HISTORY_LIMIT = 50;

/** 一度に返す履歴の上限 */
export const MAX_HISTORY_LIMIT = 500;

/**
 * 起動時にログへ出す設定の一覧を、整形済みの行として返す。
 *
 * 既定値だけで動く作りにしているため、外から見ると「どの DB を掴んだか」が
 * 分からない。設定ミスがあっても静かに動いてしまうので、実際に使った値と、
 * それが既定なのか環境変数で上書きされたものなのかを記録する。
 */
// 由来は値と同じタイミング（読み込み時）に確定させる。呼び出し時に process.env を
// 見に行くと、その間に環境変数が変わった場合に値と表示がずれる。
const PORT_FROM_ENV = process.env.AICHAT_PORT !== undefined;
const DATA_FROM_ENV = process.env.AICHAT_DATA !== undefined;

export function describeEnv() {
	const rows = [
		{ name: 'AICHAT_PORT', value: String(PORT), fromEnv: PORT_FROM_ENV },
		{ name: 'AICHAT_DATA', value: DATA_DIR, fromEnv: DATA_FROM_ENV },
		{ name: '環境', value: IS_TEST ? 'テスト' : '本番', fromEnv: DATA_FROM_ENV },
	];
	const nameWidth = Math.max(...rows.map((r) => r.name.length));
	const valueWidth = Math.max(...rows.map((r) => r.value.length));
	return rows.map(
		(r) => `${r.name.padEnd(nameWidth)} = ${r.value.padEnd(valueWidth)}  ${r.fromEnv ? '(環境変数)' : '(既定)'}`
	);
}

/** 待ち受け先を 1 行で表す */
export function describeListen() {
	return `待ち受け: http://localhost:${PORT}/  [${HOSTS.join(', ')}]`;
}

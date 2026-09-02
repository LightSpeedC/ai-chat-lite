import { VERSION, IS_TEST } from './config.mjs';
import { sendJson, serveStatic } from './serve.mjs';

/**
 * メンテナンス中の要求の受け口。
 *
 * DB を触らない。store.mjs を読み込まないため、印を確かめる前に
 * DB を掴むことがない。
 *
 * 符号の使い分け:
 *   /api/version  … 200。状態を尋ねる口なので答える
 *   それ以外の API … 503。理由と Retry-After を返す
 *   画面           … 200。HTML は返し、中で /api/version を見て表示を変える
 *
 * すべて 200 にしてはいけない。/api/poll が 200 で空の配列を返すと、
 * CLI は「新着なし」として次の回へ進み、メンテナンスに気づかないまま
 * 既定の 12 時間回り続ける。
 */

/** Retry-After に入れる既定の秒数。見込みが渡されていないときに使う */
const DEFAULT_RETRY_SEC = 60;

/**
 * メンテナンス中の受け口を作る。
 *
 * @param {object} info 印から読んだもの
 * @param {string} info.reason 理由。空でもよい
 * @param {number} info.retryAfterSec 再開の見込み（秒）
 * @param {string} info.since いつから止まっているか
 */
export function createMaintenanceHandler(info = {}) {
	const reason = info.reason ?? '';
	const retryAfterSec = info.retryAfterSec ?? DEFAULT_RETRY_SEC;
	const since = info.since ?? '';

	return async function handleMaintenance(req, res) {
		const url = new URL(req.url, 'http://localhost');
		const path = url.pathname;

		/*
		 * 状態を尋ねる口だけは答える。
		 *
		 * 理由も返す。隠すほどのものではなく、画面が「なぜ止まっているか」を
		 * 出せる方が親切である。同じ内容を public の案内にも流している。
		 */
		if (path === '/api/version') {
			sendJson(res, 200, {
				version: VERSION,
				started_at: null,
				env: IS_TEST ? 'test' : 'production',
				maintenance: true,
				maintenance_since: since,
				maintenance_reason: reason,
			});
			return;
		}

		if (path.startsWith('/api/')) {
			sendJson(
				res,
				503,
				{
					error: 'メンテナンス中です',
					detail: reason || 'しばらくお待ちください',
					retry_after_sec: retryAfterSec,
				},
				{ 'Retry-After': String(retryAfterSec) }
			);
			return;
		}

		await serveStatic(res, path);
	};
}

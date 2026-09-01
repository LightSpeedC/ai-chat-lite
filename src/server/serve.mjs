import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { WEB_DIR } from './config.mjs';

/**
 * HTTP の応答を組み立てる部品。
 *
 * DB を触らない。メンテナンス中の受け口も通常の受け口も、ここを共有する。
 * store.mjs は読み込んだ時点で DB を開くため、メンテナンス中に使う部品を
 * server.mjs に置いたままにすると、印を確かめる前に DB を掴んでしまう。
 */

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

export function sendJson(res, status, payload, headers = {}) {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(text),
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(text);
}

export async function serveStatic(res, pathname) {
	const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
	// .. を含むパスで WEB_DIR の外へ出られないようにする
	const full = normalize(join(WEB_DIR, rel));
	if (!full.startsWith(normalize(WEB_DIR))) {
		sendJson(res, 403, { error: '参照できません' });
		return;
	}
	try {
		const content = await readFile(full);

		res.writeHead(200, {
			'Content-Type': CONTENT_TYPES[extname(full)] ?? 'application/octet-stream',
			'Content-Length': content.length,
			'Cache-Control': 'no-store',
		});
		res.end(content);
	} catch {
		sendJson(res, 404, { error: '見つかりません', path: pathname });
	}
}

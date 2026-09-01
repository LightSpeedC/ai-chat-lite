import { createServer } from 'node:http';

import { PORT, HOSTS } from './config.mjs';

/**
 * 待ち受けだけを始める。要求の受け口はあとから差し替える。
 *
 * メンテナンス中に「繋がるが断られる」状態を作るために分けてある。
 * 印が消えるのを待ってから待ち受けを始めると、その間ポートが開かず、
 * 繋ごうとした側は ECONNREFUSED を受ける。メンテナンス中なのか、
 * サービスが死んだのか、ポートを間違えたのかが区別できない。
 *
 * **同じ http.Server のまま受け口を差し替える。** 別のサーバーを立てて
 * 差し替えると、閉じてから開くまでの間にポートが空く瞬間ができる。
 *
 * localhost は ::1 と 127.0.0.1 の両方を指すため、両方で listen する。
 * 片方だけに bind すると、もう一方から来た接続が拒否される。
 */
export async function startListening(handler, port = PORT, hosts = HOSTS) {
	return Promise.all(
		hosts.map(
			(host) =>
				new Promise((resolve, reject) => {
					const server = createServer(handler);
					server.on('error', reject);
					server.listen(port, host, () => resolve(server));
				})
		)
	);
}

/** 要求の受け口を差し替える。待ち受けは切らない */
export function setHandler(servers, handler) {
	for (const server of servers) {
		server.removeAllListeners('request');
		server.on('request', handler);
	}
}

/** 待ち受けを閉じる。DB の後片付けは呼ぶ側が行う */
export function closeListening(servers) {
	return Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
}

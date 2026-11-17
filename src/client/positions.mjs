/**
 * 読み位置 (msg_seq) の整形。待機ログにだけ使う (i261117-02・決定 d1)。
 *
 * 画面には出さない。msg_seq の裸の数は昔の #N と同じ形で、--reply-to に写すと
 * 別の発言を指す取り違えが起きるため。人に見せる番号は msg_id (m261117-0c)。
 * ログは人が読むもので、--reply-to に写す場面が無く、停止の調べに使う。
 */

/**
 * どこまで読んだかを 1 行で書く。
 *
 * 位置はルームごとに持っている。1 つだけなら数を、複数なら「ルーム 数」を並べる。
 * 複数のときに 1 つの数で出すと、どのルームの位置か分からない。
 */
export function describePositions(result) {
	const rooms = result.rooms ?? [];
	if (rooms.length <= 1) return String(result.msg_seq ?? rooms[0]?.msg_seq ?? 0);
	return rooms.map((r) => `${r.room_id} ${r.msg_seq}`).join(' / ');
}

/**
 * 新着なしの行に添える、待っているルームの名前。1 ルームなら空 (名前は待受けの開始の行に出ている)。
 * 複数のときは、どのルームを待って新着なしだったかを残す。
 */
export function describeRooms(result) {
	// 一度も問い合わせずに抜けたときは result が null (Rust 版は空にしている)
	const rooms = result?.rooms ?? [];
	if (rooms.length <= 1) return '';
	return `、ルーム ${rooms.map((r) => r.room_id).join(' / ')}`;
}

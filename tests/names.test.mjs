/*
 * 本番でテスト用の名前を受けないことを確かめる。
 *
 * 【なぜサーバーを立てずに確かめるのか】
 * 本番として振る舞うサーバーは本番の DB を掴む。それを立てて確かめるのは
 * 本末転倒になる。判定を names.mjs の純粋な関数にしてあるので、本番かどうかを
 * 引数で渡して両方の場合を確かめられる。
 *
 * 【何が怖いのか】
 * テスト用の ID を名乗れば隔離される、という思い違いで本番へ繋いだ事故が
 * 3 度あった。ID は何も分けていない。分けているのは AICHAT_DATA とポートで、
 * それを知っているのはサーバーだけである。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	rejectionReason,
	TEST_CONNECTOR_PREFIX,
	SANDBOX_ROOM_PREFIX,
} from '../src/server/names.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('本番では test- で始まる ID を断る', () => {
	const reason = rejectionReason('test-shape', 'public', false);
	assert.ok(reason, '理由が返るはず');
	assert.match(reason, /test-shape/);
	assert.match(reason, /本番/);
});

test('本番では sandbox- で始まるルームを断る', () => {
	const reason = rejectionReason('ai-chat-lite', 'sandbox-1', false);
	assert.ok(reason, '理由が返るはず');
	assert.match(reason, /sandbox-1/);
});

test('大小は区別しない', () => {
	// Test- や TEST- で抜けられると、断る意味がなくなる
	assert.ok(rejectionReason('TEST-shape', 'public', false));
	assert.ok(rejectionReason('Test-shape', 'public', false));
	assert.ok(rejectionReason('ai-chat-lite', 'SANDBOX-1', false));
});

test('テストでは同じ名前を通す', () => {
	assert.equal(rejectionReason('test-shape', 'sandbox-1', true), null);
});

test('ふつうの名前は本番でも通る', () => {
	assert.equal(rejectionReason('ai-chat-lite', 'public', false), null);
	assert.equal(rejectionReason('html2md', 'ai-chat-lite', false), null);
});

test('名前が無くても落ちない', () => {
	// poll は connector_id を省略できる。null が来ても判定だけして通す
	assert.equal(rejectionReason(null, 'public', false), null);
	assert.equal(rejectionReason('ai-chat-lite', null, false), null);
});

test('頭に一致するだけで、途中に含むものは断らない', () => {
	// my-test-id を断ると、正当な名前まで使えなくなる
	assert.equal(rejectionReason('my-test-id', 'public', false), null);
	assert.equal(rejectionReason('ai-chat-lite', 'my-sandbox-room', false), null);
});

test('断る頭は test- と sandbox- である', () => {
	// 資料と周知に書く値なので、変えたらここが落ちる
	assert.equal(TEST_CONNECTOR_PREFIX, 'test-');
	assert.equal(SANDBOX_ROOM_PREFIX, 'sandbox-');
});

/*
 * 【なぜ実装の形を見るのか】
 * 判定そのものは上で確かめられるが、「繋ぐ口がその判定を通っているか」は
 * ここでしか見られない。テストは AICHAT_DATA を立てて走るので IS_TEST が
 * 真になり、API を叩いても断られないためである（本番として振る舞う
 * サーバーを立てるのは、本番の DB を掴むので本末転倒）。
 *
 * 実際 SSE（/api/events）だけ検査が抜けており、画面は SSE で繋ぐため
 * 本番で test- を名乗った接続が通っていた。そこから入り込んだ痕跡を
 * 手で消すことになった（レビュー #21 medium 9、i260912-01）。
 */
test('外から繋ぐ口はすべて判定を通る', () => {
	const src = readFileSync(join(here, '..', 'src', 'server', 'server.mjs'), 'utf8');

	/** 関数の本体を、次の「行頭の }」までで切り出す */
	const bodyOf = (name) => {
		const start = src.indexOf(`function ${name}(`);
		assert.ok(start >= 0, `${name} が見つからない`);
		const end = src.indexOf('\n}', start);
		return src.slice(start, end);
	};

	for (const name of ['handleJoin', 'handleSay', 'handlePoll', 'handleLeave', 'handleEvents']) {
		assert.ok(bodyOf(name).includes('rejectTestNames'), `${name} が判定を通っていない`);
	}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describePositions, describeRooms } from '../src/client/positions.mjs';

/*
 * 画面には位置の数を出さず、待機ログにだけ残す (i261117-02)。
 * Rust 版の同じ関数 (commands.rs の describe_rooms・describe_positions) と形をそろえる。
 */

const one = { msg_seq: 42, rooms: [{ room_id: 'public', msg_seq: 42 }] };
const many = {
	rooms: [
		{ room_id: 'public', msg_seq: 42 },
		{ room_id: 'ai-chat-lite', msg_seq: 7 },
	],
};

test('待機ログの位置は、1 ルームなら数だけ、複数ならルームごとに並べる', () => {
	assert.equal(describePositions(one), '42');
	assert.equal(describePositions(many), 'public 42 / ai-chat-lite 7');
});

test('新着なしの行に添えるルーム名は、1 ルームなら空、複数なら並べて位置の数は含めない', () => {
	assert.equal(describeRooms(one), '');
	assert.equal(describeRooms(many), '、ルーム public / ai-chat-lite');
});

test('一度も問い合わせずに抜けても (null)、ルーム名の整形は落ちない', () => {
	assert.equal(describeRooms(null), '');
	assert.equal(describeRooms({}), '');
});

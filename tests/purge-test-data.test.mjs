/*
 * 後始末の道具（tools/40_test/purge-test-data.mjs）を確かめる。
 *
 * 【なぜ必要か】
 * これは「消す」道具である。既定の動作が削除なので、引数の解釈を 1 つ誤ると
 * そのまま消える。実際に --help と打って 48 件を消したことがある。
 *
 * とくに置き場の決め方が危ない。以前は何も指定しなければ tmp/_data を相手に
 * していたため、本番を掃除するつもりの手順（--production の付け忘れ）が
 * 「テスト側を掃除して成功と出す」形になり、本番の test- が残り続けた
 * （i260906-02）。いまは置き場を明示しなければ止める。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { prepareTestDb } from './helpers/prepare-db.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PURGE = join(ROOT, 'tools', '40_test', 'purge-test-data.mjs');
const TEST_DATA = join(ROOT, 'tmp', '_data', 'unit-purge');

/**
 * 道具を動かす。AICHAT_DATA は渡さない。
 *
 * 渡すと「置き場が明示されている」ことになり、付け忘れの検査ができない。
 */
function purge(args, env = {}) {
	return run(process.execPath, [PURGE, ...args], {
		env: { ...process.env, AICHAT_DATA: undefined, ...env },
	});
}

/** 失敗を期待して動かす */
async function failing(args, env = {}) {
	try {
		const ok = await purge(args, env);
		return { code: 0, ...ok };
	} catch (err) {
		return err;
	}
}

before(async () => {
	mkdirSync(TEST_DATA, { recursive: true });
	await prepareTestDb(TEST_DATA);
});

after(() => {
	if (existsSync(TEST_DATA)) rmSync(TEST_DATA, { recursive: true, force: true });
});

describe('置き場を明示しなければ止まる（i260906-02）', () => {
	/*
	 * 【なぜ必要か】
	 * 以前は付け忘れると黙って tmp/_data を見た。本番を掃除する手順で
	 * --production が抜けていたため、手順どおり実行しても本番の test- は
	 * 1 件も消えず、しかも「消しました」と出ていた。読み手は消えたと思い込む。
	 */
	test('--production も --test も無ければ終了コード 2 で止まる', async () => {
		const { code, stderr } = await failing([]);

		assert.equal(code, 2);
		assert.match(stderr, /--test|--production/);
	});

	test('--dry-run だけでも止まる（数えるだけでも置き場は要る）', async () => {
		const { code, stderr } = await failing(['--dry-run']);

		assert.equal(code, 2);
		assert.match(stderr, /--test|--production/);
	});

	test('--test を渡せば動く', async () => {
		const { stdout } = await purge(['--test', '--dry-run'], { AICHAT_DATA: TEST_DATA });

		// 置き場が決まったので、数えるところまで進む
		assert.match(stdout, /相手|件/);
	});

	test('--test と --production は同時に渡せない', async () => {
		const { code, stderr } = await failing(['--test', '--production']);

		assert.equal(code, 2);
		assert.match(stderr, /どちらか/);
	});
});

describe('知らない引数は消さずに止まる', () => {
	test('打ち間違いは終了コード 2', async () => {
		// 既定の動作が削除なので、黙って無視すると打ち間違いがそのまま削除になる
        const { code } = await failing(['--test', '--no-such-option']);

		assert.equal(code, 2);
	});
});

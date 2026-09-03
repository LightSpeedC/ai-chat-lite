/*
 * 既定値を持たないことを確かめる。
 *
 * 【決めごと】接続先（--url / --port）はどのコマンドでも省略できない。
 * 環境変数も見ない。指定が無ければエラーで止める。
 *
 * 既定を本番のポートにすると、テストのつもりで叩いたものが本番に入る。
 * 実際にそれが起きた。書き込まないコマンド（waiters）でも同じで、既定を本番に
 * すると「テストのつもりで数えた本数」を本番の本数として読み違え、
 * 「張っているから張らない」と判断して本番の待受けが 1 本も無いまま止まる。
 *
 * このテストは全コマンドを機械的に回す。コマンドを足したときに書き忘れると
 * ここで落ちる。1 つずつ手で確かめていると、足したものが漏れる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { COMMANDS, ADMIN_COMMANDS, OPTIONS } from '../src/client/options.mjs';
import { wrapId } from './helpers/cli-args.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'src', 'client', 'chat.mjs');

/*
 * 置き場をテスト側に向ける。
 *
 * 接続先が無いので通信はしないが、wait は繋ぐ前に待受けの記録を開く。
 * 本番の置き場のままだと logs/client/ に残ってしまう（実際に残ったことがある）。
 */
const ENV = { ...process.env, AICHAT_DATA: join(here, '..', 'tmp', '_data', 'unit-no-defaults') };

const ME = 'test-no-defaults';

/**
 * コマンドを動かすのに最低限必要な引数。接続先は入れない。
 *
 * 接続先より先に弾かれるものがあると、確かめたいものが確かめられない。
 * ID・本文・対象・番号はここで埋める。
 */
const MINIMUM = {
	join: [wrapId(ME)],
	wait: [wrapId(ME), '--wait-sec', '1'],
	say: [wrapId(ME), '本文'],
	recent: [],
	who: [],
	waiters: [wrapId(ME)],
	dump: [],
	leave: [wrapId(ME)],
	archive: [wrapId(ME), 'room', 'test-room'],
	archives: [],
	restore: [wrapId(ME), '1'],
	restart: [wrapId(ME)],
	stop: [wrapId(ME)],
};

/*
 * 接続先を渡さない呼び出しは、繋ぐ前に止まる。だから待たされない。
 *
 * 逆に、繋がらないポートを渡すと 60 秒粘ってから諦める（wait は 10 分）。
 * このテストでは接続先を渡さないことで、粘りに入らせない。
 */
async function failing(args, env = ENV) {
	try {
		const ok = await run(process.execPath, [CLIENT, ...args], { env });
		assert.fail(`エラーにならなかった: ${args.join(' ')}\n${ok.stdout}`);
	} catch (err) {
		return { code: err.code, stderr: err.stderr ?? '', stdout: err.stdout ?? '' };
	}
}

describe('接続先に既定値が無い', () => {
	const all = [...COMMANDS, ...ADMIN_COMMANDS];

	test('確かめる対象が全コマンド分そろっている', () => {
		/*
		 * 定義にあるのに MINIMUM へ書き忘れると、そのコマンドは試されない。
		 * 「全部通った」のに実は試していなかった、という抜けを防ぐ。
		 */
		const missing = all.map((c) => c.name).filter((n) => MINIMUM[n] === undefined);
		assert.deepEqual(missing, [], `MINIMUM に無いコマンドがある: ${missing.join(' ')}`);

		const extra = Object.keys(MINIMUM).filter((n) => !all.some((c) => c.name === n));
		assert.deepEqual(extra, [], `定義に無いコマンドが MINIMUM にある: ${extra.join(' ')}`);
	});

	for (const c of [...COMMANDS, ...ADMIN_COMMANDS]) {
		test(`${c.name} は接続先を渡さないと終了コード 2 で止まる`, async () => {
			const { code, stderr } = await failing([c.name, ...MINIMUM[c.name]]);

			assert.equal(code, 2, `${c.name} が終了コード 2 で止まっていない`);
			assert.match(
				stderr,
				/(接続先が指定されていません|どこを見ている待受けを数えるかが指定されていません)/,
				`${c.name} が接続先の不足で止まっていない`
			);
		});
	}
});

describe('環境変数では渡せない', () => {
	/*
	 * 環境変数を口にすると、プロセス一覧に出ないため
	 * 「動いている待受けがどのプロジェクトのものか」が分からなくなる。
	 * 引数だけを受けると決めてある。
	 */
	test('AICHAT_PORT を置いても接続先にはならない', async () => {
		const { code, stderr } = await failing(['who'], { ...ENV, AICHAT_PORT: '8787' });

		assert.equal(code, 2);
		assert.match(stderr, /接続先が指定されていません/);
	});

	test('AICHAT_URL のような変数は定義そのものが無い', () => {
		// 読む口を増やしていないことを、定義の側から確かめる
		const names = OPTIONS.map((o) => o.long);
		assert.ok(names.includes('port'));
		assert.ok(names.includes('url'));
	});
});

describe('名乗る ID にも既定値が無い', () => {
	/*
	 * カレントのフォルダ名を自動で使わない。取り違えた名前で名乗ると
	 * connectors とログに残り、後から消せない。実際に ID は project フォルダ名と
	 * 一致しないものも使われている（一致を前提にできない）。
	 */
	test('書くコマンドは ID を渡さないと止まる', async () => {
		/*
		 * ID の確認は接続より先に走る。だから接続先を渡しても繋ぎに行かず、
		 * 粘りにも入らない。
		 */
		for (const name of ['join', 'wait', 'say', 'leave', 'restore', 'restart', 'stop', 'waiters']) {
			const { code, stderr } = await failing([name, '-p', '1']);

			assert.equal(code, 1, `${name} が終了コード 1 で止まっていない`);
			assert.match(stderr, /名乗る ID が指定されていません/, `${name} が ID の不足で止まっていない`);
		}
	});

	test('読むだけのコマンドは ID を取らない', async () => {
		/*
		 * who / recent / dump / archives は名乗る必要がない。
		 * 接続先も渡さないので、止まる理由は接続先の不足だけになる。
		 * ID の不足で止まっていなければ、ID を求めていないと言える。
		 */
		for (const name of ['who', 'recent', 'dump', 'archives']) {
			const { stderr } = await failing([name]);

			assert.doesNotMatch(stderr, /名乗る ID が指定されていません/, `${name} が ID を求めている`);
			assert.match(stderr, /接続先が指定されていません/, `${name} が接続先で止まっていない`);
		}
	});
});

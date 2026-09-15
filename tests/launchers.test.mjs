/*
 * root に置くランチャーのテスト。
 *
 * 【何を守るか】
 * `aichat` という名前をどの実装が受けるかは、他プロジェクトから見える動きそのものである。
 * 待受けを張る手順は共通ルールに書かれていて、そこには `aichat` としか書いていない。
 * 受け手が入れ替わったことに気づけないと、遅い実装を全プロジェクトが使い続けることになる。
 *
 * 名前の衝突も守る。cmd.exe は PATHEXT の順（.EXE が .CMD より先）で選ぶため、
 * 同じ名前の exe と cmd が両方あると、どちらが動くかがシェルによって変わる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

/** ファイルの中身の指紋 */
function digestOf(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('既定の aichat は Rust 版が受ける', () => {
	test('aichat.exe は aichat-rs.exe と同じ中身', { skip: win ? false : 'Windows 専用' }, () => {
		/*
		 * ビルドが両方に置く。片方だけ新しくなると、`aichat` と `aichat-rs` で
		 * 違う版が動き、突き合わせのテストが通ったまま本番だけ古いことになる。
		 */
		const exe = join(root, 'aichat.exe');
		const rs = join(root, 'aichat-rs.exe');
		assert.ok(existsSync(rs), 'aichat-rs.exe が無い（先にビルドが要る）');
		assert.ok(existsSync(exe), 'aichat.exe が無い');
		assert.equal(digestOf(exe), digestOf(rs), 'aichat.exe と aichat-rs.exe の中身が違う');
	});

	test('aichat という名前を exe 以外が持たない', { skip: win ? false : 'Windows 専用' }, () => {
		// PATHEXT の順で選ばれるため、両方あるとシェルによって受け手が変わる
		assert.ok(!existsSync(join(root, 'aichat.cmd')), 'aichat.cmd が残っている');
		assert.ok(!existsSync(join(root, 'aichat')), '拡張子なしの aichat が残っている');
	});
});

describe('bun 版のランチャー', () => {
	test('aichat-bun と aichat-bun.cmd が揃っている', () => {
		// cmd.exe は .cmd を、Bash は拡張子なしを選ぶ。片方だけだと環境で動かない
		assert.ok(existsSync(join(root, 'aichat-bun')), '拡張子なしの aichat-bun が無い');
		if (win) assert.ok(existsSync(join(root, 'aichat-bun.cmd')), 'aichat-bun.cmd が無い');
	});

	test('bun が無ければ node で動く', { skip: win ? false : 'Windows 専用' }, () => {
		/*
		 * bun を入れていない環境でも `aichat-bun` が使えることを見る。
		 * PATH から bun の置き場だけを外して実行する。
		 */
		const where = spawnSync('where', ['bun'], { encoding: 'utf8' });
		const bunDirs =
			where.status === 0
				? where.stdout
						.trim()
						.split(/\r?\n/)
						.map((p) => dirname(p).replace(/\\+$/, '').toLowerCase())
				: [];
		const path = (process.env.PATH ?? '')
			.split(';')
			.filter((d) => !bunDirs.includes(d.replace(/\\+$/, '').toLowerCase()))
			.join(';');

		const res = spawnSync('cmd', ['/c', join(root, 'aichat-bun.cmd')], {
			encoding: 'utf8',
			env: { ...process.env, PATH: path, Path: path },
		});
		const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
		assert.ok(!/bun/i.test(res.stderr ?? ''), `bun を呼びに行った: ${res.stderr?.trim()}`);
		assert.match(out, /ai-chat-lite クライアント/, `使い方が出ていない: ${out.slice(0, 200)}`);
	});
});

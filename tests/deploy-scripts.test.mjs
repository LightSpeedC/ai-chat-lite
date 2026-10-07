/*
 * deploy/ の登録スクリプト（install-service.cmd ・ uninstall-service.cmd）のガードを確かめる。
 *
 * 実際の登録・解除は管理者権限が要り、本番のサービスを止めるため、自動では流さない。
 * ここで見るのは「WinSW を呼ぶ前に必ず止まる」2 つのガードだけである。どちらも、
 * 管理者のシェルで流しても登録・解除は起きない。
 *
 *   C: 以外から呼んだとき           → 終了コード 1。subst のドライブはサービスから見えず、
 *                                      登録先に記録されると起動に失敗する
 *   必要なファイルが隣に無いとき     → 終了コード 1。移す前に間違えて動かしても、実体を呼ばない
 *
 * 管理者かどうか・登録済みかどうかのガードは、実機の状態に左右されるため、ここでは
 * 見ない（実機で確かめる。計画書 i260830-01 の 5 章）。
 *
 * 引数 nopause を渡して、入力待ち（pause）で固まらないようにする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const DEPLOY = join(ROOT, 'deploy');
const SCRIPTS = ['install-service.cmd', 'uninstall-service.cmd'];

/**
 * スクリプトを nopause で実行し、終了コードと出力（SJIS）を返す。
 *
 * windowsHide を付けるのは、子に専用のコンソールを持たせるため（CREATE_NO_WINDOW）。
 * コンソールのコードページは同じ窓の全プロセスで共有される。node --test で並んで動く
 * ほかのテスト（bun など）が一時的に変えると、cmd の日本語の出力が文字化けして、
 * 単独では通るのに全件実行で落ちた。
 */
function run(scriptPath) {
	const r = spawnSync('cmd.exe', ['/d', '/c', scriptPath, 'nopause'], { timeout: 30000, windowsHide: true });
	return { status: r.status, out: new TextDecoder('shift_jis').decode(r.stdout) };
}

/** その場所のドライブが C: か */
function isOnC(path) {
	return parse(path).root.toUpperCase() === 'C:\\';
}

describe('登録スクリプトのガード（i260830-01）', () => {
	for (const name of SCRIPTS) {
		test(`${name} は deploy/ にある`, () => {
			assert.ok(existsSync(join(DEPLOY, name)), `${name} が deploy/ に無い`);
		});

		test(`${name}: C: 以外から呼ぶと、WinSW を呼ぶ前に終了コード 1 で止まる`, {
			// このチェックアウトが C: にあると、C: 以外のパスを作れない
			skip: isOnC(DEPLOY) ? 'チェックアウトが C: にある' : false,
		}, () => {
			const { status, out } = run(join(DEPLOY, name));

			assert.equal(status, 1);
			assert.match(out, /C:ドライブで実行してください/, out);
		});

		test(`${name}: 必要なファイルが隣に無いと、終了コード 1 で止まる`, () => {
			/*
			 * 実体のパス（C:）で呼ぶため、subst の別名ではなく realpath を使う。
			 * 空の一時フォルダへスクリプトだけを写して呼ぶので、WinSW には届かない。
			 */
			const real = realpathSync.native(join(ROOT, 'tmp'));
			if (!isOnC(real)) return; // C: 以外にある環境では、先のガードが先に止まる

			const dir = join(real, 'deploy-guard-test');
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			try {
				copyFileSync(join(DEPLOY, name), join(dir, name));
				const { status, out } = run(join(dir, name));

				assert.equal(status, 1);
				assert.match(out, /node-ai-chat-lite-winsw\.exe/, out);
				assert.match(out, /見つかりません/, out);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

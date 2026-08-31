import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * config.mjs は読み込んだ時点で環境変数を評価するため、条件を変えるたびに
 * 読み直す必要がある。ESM は同じ URL を一度しか評価しないので、クエリを付けて
 * 別モジュールとして読ませる。
 */
async function loadConfig(env = {}) {
	const saved = { ...process.env };
	for (const key of ['AICHAT_PORT', 'AICHAT_DATA']) delete process.env[key];
	Object.assign(process.env, env);
	const mod = await import(`../src/server/config.mjs?case=${Math.random()}`);
	process.env = saved;
	return mod;
}

test('既定のポートは 8787', async () => {
	const { PORT } = await loadConfig();
	assert.equal(PORT, 8787);
});

test('AICHAT_PORT で上書きできる', async () => {
	const { PORT } = await loadConfig({ AICHAT_PORT: '9000' });
	assert.equal(PORT, 9000);
});

test('置き場の既定は _data、DB はその下', async () => {
	const { DATA_DIR, DB_PATH, ROOT } = await loadConfig();
	assert.equal(DATA_DIR, join(ROOT, '_data'));
	assert.equal(DB_PATH, join(ROOT, '_data', 'chat.db'));
});

test('DB のパスはカレントディレクトリに依存しない', async () => {
	// ROOT は config.mjs 自身の位置から 2 つ上。テストファイルから見た位置と一致する
	const here = dirname(fileURLToPath(import.meta.url));
	const { ROOT } = await loadConfig();
	assert.equal(ROOT, join(here, '..'));
});

test('AICHAT_DATA で置き場ごと上書きできる', async () => {
	const { DATA_DIR, DB_PATH } = await loadConfig({ AICHAT_DATA: 'X:\\somewhere' });
	assert.equal(DATA_DIR, 'X:\\somewhere');
	assert.equal(DB_PATH, join('X:\\somewhere', 'chat.db'));
});

// 置き場が本番でなければテスト。環境を表す変数を別に持たない
test('既定なら本番、差し替えたらテスト', async () => {
	const prod = await loadConfig();
	assert.equal(prod.IS_TEST, false);

	const t = await loadConfig({ AICHAT_DATA: 'X:\\somewhere' });
	assert.equal(t.IS_TEST, true);
});

test('待ち受けは ::1 と 127.0.0.1 の両方', async () => {
	const { HOSTS } = await loadConfig();
	assert.deepEqual(HOSTS, ['::1', '127.0.0.1']);
});

test('long-poll の上限は PowerShell ツールの 600 秒制限の内側', async () => {
	const { MAX_WAIT_SEC } = await loadConfig();
	assert.ok(MAX_WAIT_SEC < 600, `${MAX_WAIT_SEC} 秒では制限に届いてしまう`);
});

test('起動ログに環境変数の名前と値が並ぶ', async () => {
	const { describeEnv } = await loadConfig();
	const lines = describeEnv();
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^AICHAT_PORT = 8787\s+\(既定\)$/);
	assert.match(lines[1], /^AICHAT_DATA\s+= .+_data\s+\(既定\)$/);
	assert.match(lines[2], /^環境\s+= 本番\s+\(既定\)$/);
});

test('環境変数で上書きしたことがログで分かる', async () => {
	const { describeEnv } = await loadConfig({ AICHAT_PORT: '9000' });
	const lines = describeEnv();
	assert.match(lines[0], /\(環境変数\)$/);
	assert.match(lines[1], /\(既定\)$/, 'こちらは既定のままのはず');
});

test('起動ログに待ち受け先と実際の bind 先が出る', async () => {
	const { describeListen } = await loadConfig();
	const line = describeListen();
	assert.ok(line.includes('http://localhost:8787/'), line);
	assert.ok(line.includes('::1'), line);
	assert.ok(line.includes('127.0.0.1'), line);
});

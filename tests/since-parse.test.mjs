import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDateTimeArg } from '../src/client/since-parse.mjs';
import { nowJst } from '../src/server/time.mjs';

/*
 * recent --since / --before の絶対日時パーサ。
 *
 * 「いま」を跨ぐ判定（未来なら丸める）が主眼なので、テストは実際の現在時刻に
 * 対して相対的な入力（確実に過去・確実に未来）を使う。特定の日付を決め打ちで
 * 期待すると、実行するタイミング（年をまたぐ・日をまたぐ）で失敗する。
 */

const YEAR_MS = 366 * 24 * 60 * 60 * 1000; // うるう年を含めても確実に「1 年前後」の幅

describe('① 年月日（省いていない）', () => {
	test('丸めない。そのまま使う', () => {
		assert.equal(resolveDateTimeArg('2026/8/1'), '2026/08/01 00:00:00.000');
		assert.equal(resolveDateTimeArg('2026/8/1 14:30'), '2026/08/01 14:30:00.000');
		assert.equal(resolveDateTimeArg('2026/8/1 14:30:5'), '2026/08/01 14:30:05.000');
	});

	test('未来の年月日を指定しても丸めない（① だけの特徴）', () => {
		const farFuture = new Date(Date.now() + 10 * YEAR_MS);
		const y = farFuture.getUTCFullYear() + 1; // 確実に未来にする
		assert.equal(resolveDateTimeArg(`${y}/1/1`), `${y}/01/01 00:00:00.000`);
	});
});

describe('② 月日（年を省く）', () => {
	test('確実に過去の月日は、今年のまま', () => {
		// 1/1 は 1 年のどの時点で実行しても「今年の 1/1」が過去か、
		// 実行日そのものになる（未来にはならない）
		const thisYear = Number(nowJst().slice(0, 4));
		assert.equal(resolveDateTimeArg('1/1'), `${thisYear}/01/01 00:00:00.000`);
	});

	test('確実に未来の月日は、去年に丸める', () => {
		// 12/31 23:59 が実行した瞬間そのものであることは無いとみなせるほど、
		// 「今年の 12/31 23:59」は普通は未来（大晦日の実行でしか一致しない）
		const now = nowJst();
		const thisYear = Number(now.slice(0, 4));
		const candidateThisYear = `${thisYear}/12/31 23:59:00.000`;
		if (candidateThisYear > now) {
			assert.equal(resolveDateTimeArg('12/31 23:59'), `${thisYear - 1}/12/31 23:59:00.000`);
		}
	});
});

describe('③ 時刻のみ（日付を省く）', () => {
	test('確実に未来の時刻は、1 日前に丸める', () => {
		const now = nowJst();
		const today = now.slice(0, 10); // yyyy/mm/dd
		const candidateToday = `${today} 23:59:59.000`;
		if (candidateToday > now) {
			const resolved = resolveDateTimeArg('23:59:59');
			assert.ok(resolved < now, `丸めた結果がいまより前になっていない: ${resolved}`);
			assert.match(resolved, /^\d{4}\/\d{2}\/\d{2} 23:59:59\.000$/);
		}
	});
});

describe('区切り文字', () => {
	test('スペース・ハイフン・下線はどれも同じ結果になる', () => {
		const a = resolveDateTimeArg('2026/8/1 14:30');
		const b = resolveDateTimeArg('2026/8/1-14:30');
		const c = resolveDateTimeArg('2026/8/1_14:30');
		assert.equal(a, b);
		assert.equal(b, c);
	});
});

describe('--since と --before の丸めは対称', () => {
	test('同じ値を解決すれば、同じ結果になる（分岐していない証拠）', () => {
		assert.equal(resolveDateTimeArg('11/1'), resolveDateTimeArg('11/1'));
	});

	test('anchor を渡さずに単独で丸めても、両方とも去年に丸まる', () => {
		// 11/1 と 11/30 は、今年のその日がいまより未来なら両方とも去年に丸まる。
		// 片方だけ丸まる実装だと、去年〜今年という 1 年がかりの範囲になってしまう
		const since = resolveDateTimeArg('11/1');
		const before = resolveDateTimeArg('11/30');
		assert.equal(since.slice(0, 4), before.slice(0, 4), '年が食い違っている（非対称に丸めている）');
	});
});

describe('--before は anchor（--since が解決した値）の年・日付を引き継ぐ', () => {
	/*
	 * 「未来なら遡る」を --before にも単純に当てはめると、範囲を跨ぐ組み合わせで
	 * 別の壊れ方をする。「--since 9/9 --before 9/10」（今日と明日）は、
	 * 9/9 は今日なので未来ではなく今年のまま、9/10 を独立に見れば明日で
	 * 未来なので去年に遡る——今日と去年の組み合わせという意図しない範囲になる。
	 * anchor を渡せば、9/10 は「いま」ではなく since の年をそのまま引き継ぐ。
	 */
	test('今日と明日の組み合わせが、両方とも今年のままになる', () => {
		const since = resolveDateTimeArg('9/9');
		const before = resolveDateTimeArg('9/10', since);
		const thisYear = Number(nowJst().slice(0, 4));
		assert.equal(since, `${thisYear}/09/09 00:00:00.000`);
		assert.equal(before, `${thisYear}/09/10 00:00:00.000`);
	});

	test('確実に未来の範囲（11/1〜11/30）でも、anchor を渡せば同じ年になる', () => {
		const since = resolveDateTimeArg('11/1');
		const before = resolveDateTimeArg('11/30', since);
		assert.equal(since.slice(0, 4), before.slice(0, 4));
		// 範囲として筋が通っている（before が since より後）ことも確かめる
		assert.ok(before > since, `before が since より前になっている: ${before} <= ${since}`);
	});

	test('時刻のみの範囲（22:00〜23:00）でも、anchor を渡せば同じ日になる', () => {
		const since = resolveDateTimeArg('22:00');
		const before = resolveDateTimeArg('23:00', since);
		assert.equal(since.slice(0, 10), before.slice(0, 10), '日付が食い違っている');
		assert.ok(before > since);
	});

	test('① 年月日をすべて指定した --before は、anchor があっても無視する', () => {
		// 年月日を省いていないので、anchor の出る幕はない
		const before = resolveDateTimeArg('2020/1/1', '2026/09/09 00:00:00.000');
		assert.equal(before, '2020/01/01 00:00:00.000');
	});
});

describe('範囲外は断る', () => {
	test('月・日・時・分・秒の範囲外はエラー', () => {
		assert.throws(() => resolveDateTimeArg('13/1'), /月は/);
		assert.throws(() => resolveDateTimeArg('9/10 25:0'), /時は/);
		assert.throws(() => resolveDateTimeArg('9/10 12:60'), /分は/);
	});
});

describe('形が合わないものは断る', () => {
	test('3 段のどれにも当たらない値はエラー', () => {
		assert.throws(() => resolveDateTimeArg('foo'), /日時の形が違います/);
		assert.throws(() => resolveDateTimeArg('2026-8-1'), /日時の形が違います/, 'ハイフン区切りの日付は受けない仕様');
	});
});

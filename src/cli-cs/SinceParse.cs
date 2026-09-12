/*
 * recent --since / --before の絶対日時を解決する。
 *
 * node 版（src/client/since-parse.mjs）と同じ規則にする。食い違うと、
 * 同じコマンドを打ったのに片方だけ違う範囲が返ることになる。
 *
 * 【--since と --before は同じ規則を共有する】
 * 分けると、組み合わせたときに片方だけ丸まって範囲が壊れる。
 * 「--since 11/1 --before 11/30」を、丸めるのが --since だけだとすると、
 * 11/1 は今年が未来なので去年に丸まり、11/30 は丸めないので今年のまま
 * ——去年 11 月から今年 11 月末までという、意図しない範囲になる。
 * ここは分岐せず、1 つのメソッドだけを --since にも --before にも使う。
 *
 * 【--before は --since の年・日付を引き継ぐ】
 * 「未来なら 1 つ遡る」を --before にも単純に当てはめると、別の壊れ方をする。
 * 「--since 9/9 --before 9/10」（今日と明日）は、9/9 は今日なので未来ではなく
 * 今年のまま、9/10 は独立に見れば明日で未来なので去年に遡る——今日と去年の
 * 組み合わせという、これも意図しない範囲になる。
 *
 * --before に anchorTs（--since 側が解決した値）を渡すと、年・日付を省いた分は
 * 「いま」と比べて丸めるのではなく、anchorTs の年・日付をそのまま引き継ぐ。
 *
 * 【書式は 3 段】上から順に試し、最初に形が合ったものを使う。
 *   ① yyyy/m/d[<区切り>H:m[:s]]  年月日（＋任意で時刻）。省いていない
 *   ② m/d[<区切り>H:m[:s]]       月日（年を省く）
 *   ③ H:m[:s]                    時刻のみ（日付を省く）
 * 区切りは半角スペース・ハイフン・下線のどれでもよい。
 *
 * 【「いま」との比較は文字列で行う】
 * JstTime.NowJst() と同じ書式（yyyy/mm/dd HH:mm:ss.fff）は固定長で、
 * 辞書順がそのまま時系列順になる。
 */
using System;
using System.Text.RegularExpressions;

namespace AiChat
{
	internal static class SinceParse
	{
		private const long OneDayMs = 24 * 60 * 60 * 1000;

		// 日付と時刻の区切り。半角スペース・ハイフン・下線のどれでもよい
		private const string Sep = "[ \\-_]";

		private static readonly Regex ReFull = new Regex(
			"^(\\d{4})/(\\d{1,2})/(\\d{1,2})(?:" + Sep + "(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?)?$");
		private static readonly Regex ReMonthDay = new Regex(
			"^(\\d{1,2})/(\\d{1,2})(?:" + Sep + "(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?)?$");
		private static readonly Regex ReTimeOnly = new Regex("^(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2}))?$");

		/// <summary>読み手・使い方の両方に出す、書式の説明</summary>
		public const string FormatHelp =
			"日時は yyyy/m/d ・ m/d ・ H:m の 3 段のどれかです（時刻は任意で追加。区切りは半角スペース・ハイフン・下線）";

		private static void CheckRange(string name, int value, int min, int max)
		{
			if (value < min || value > max)
			{
				throw new FormatException(name + "は " + min + "〜" + max + " の範囲にしてください: " + value);
			}
		}

		/// <summary>
		/// その月に無い日を断る。
		///
		/// 日の検査は 1〜31 までしか見ない（月ごとの日数は見ない仕様）。
		/// 素通りさせると、node 版は翌月へ繰り上げて別の範囲を静かに返し、
		/// C# 版は .NET の例外がそのまま出る。2 本で終わり方が分かれていた。
		///
		/// 2 月は年で日数が変わるので、年が決まってから呼ぶこと。
		/// </summary>
		private static void CheckDayOfMonth(int year, int month, int day)
		{
			int last = DateTime.DaysInMonth(year, month);
			if (day > last)
			{
				throw new FormatException(
					month + " 月は " + last + " 日までです（" + year + " 年）: " + month + "/" + day);
			}
		}

		/// <summary>年月日だけの組。C# 5 の csc（.NET Framework 同梱）にはタプル構文が無いため</summary>
		private struct Ymd
		{
			public int Year;
			public int Month;
			public int Day;
		}

		private static Ymd DateParts(string jstStr)
		{
			string datePart = jstStr.Substring(0, 10); // "yyyy/mm/dd"
			string[] p = datePart.Split('/');
			return new Ymd { Year = int.Parse(p[0]), Month = int.Parse(p[1]), Day = int.Parse(p[2]) };
		}

		/// <summary>② 月日（年を省く）を決める</summary>
		private static string ResolveMonthDay(int month, int day, int hour, int minute, int second, string anchorTs)
		{
			if (anchorTs != null)
			{
				Ymd anchor = DateParts(anchorTs);
				CheckDayOfMonth(anchor.Year, month, day);
				return JstTime.FromParts(anchor.Year, month, day, hour, minute, second);
			}

			string now = JstTime.NowJst();
			Ymd today = DateParts(now);
			CheckDayOfMonth(today.Year, month, day);
			string candidate = JstTime.FromParts(today.Year, month, day, hour, minute, second);
			if (string.CompareOrdinal(candidate, now) <= 0) return candidate;
			CheckDayOfMonth(today.Year - 1, month, day);
			return JstTime.FromParts(today.Year - 1, month, day, hour, minute, second);
		}

		/// <summary>③ 時刻のみ（日付を省く）を決める</summary>
		private static string ResolveTimeOnly(int hour, int minute, int second, string anchorTs)
		{
			if (anchorTs != null)
			{
				Ymd anchor = DateParts(anchorTs);
				return JstTime.FromParts(anchor.Year, anchor.Month, anchor.Day, hour, minute, second);
			}

			string now = JstTime.NowJst();
			Ymd today = DateParts(now);
			string candidate = JstTime.FromParts(today.Year, today.Month, today.Day, hour, minute, second);
			if (string.CompareOrdinal(candidate, now) <= 0) return candidate;
			// 月・年をまたぐ計算は JstTime.Shift（内部は DateTime の引き算）に任せる
			return JstTime.Shift(candidate, -OneDayMs);
		}

		/// <summary>
		/// --since / --before の値を解決し、sent_at と同じ書式
		/// （yyyy/mm/dd HH:mm:ss.fff）の文字列にして返す。
		///
		/// 形が合わない・範囲外なら FormatException を投げる
		/// （呼び出し側が CLI のエラー表示に変える）。
		/// </summary>
		/// <param name="raw">渡された値</param>
		/// <param name="anchorTs">
		/// --before のとき、--since 側が解決した値。--since 自身を解決するときは渡さない（null のまま）
		/// </param>
		public static string ResolveDateTimeArg(string raw, string anchorTs = null)
		{
			Match m = ReFull.Match(raw);
			if (m.Success)
			{
				int year = int.Parse(m.Groups[1].Value);
				int month = int.Parse(m.Groups[2].Value);
				int day = int.Parse(m.Groups[3].Value);
				int hour = m.Groups[4].Success ? int.Parse(m.Groups[4].Value) : 0;
				int minute = m.Groups[5].Success ? int.Parse(m.Groups[5].Value) : 0;
				int second = m.Groups[6].Success ? int.Parse(m.Groups[6].Value) : 0;
				CheckRange("月", month, 1, 12);
				CheckRange("日", day, 1, 31);
				CheckRange("時", hour, 0, 23);
				CheckRange("分", minute, 0, 59);
				CheckRange("秒", second, 0, 59);
				CheckDayOfMonth(year, month, day);
				// 年月日をすべて指定しているので、丸めない（anchorTs も見ない）
				return JstTime.FromParts(year, month, day, hour, minute, second);
			}

			m = ReMonthDay.Match(raw);
			if (m.Success)
			{
				int month = int.Parse(m.Groups[1].Value);
				int day = int.Parse(m.Groups[2].Value);
				int hour = m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0;
				int minute = m.Groups[4].Success ? int.Parse(m.Groups[4].Value) : 0;
				int second = m.Groups[5].Success ? int.Parse(m.Groups[5].Value) : 0;
				CheckRange("月", month, 1, 12);
				CheckRange("日", day, 1, 31);
				CheckRange("時", hour, 0, 23);
				CheckRange("分", minute, 0, 59);
				CheckRange("秒", second, 0, 59);
				return ResolveMonthDay(month, day, hour, minute, second, anchorTs);
			}

			m = ReTimeOnly.Match(raw);
			if (m.Success)
			{
				int hour = int.Parse(m.Groups[1].Value);
				int minute = int.Parse(m.Groups[2].Value);
				int second = m.Groups[3].Success ? int.Parse(m.Groups[3].Value) : 0;
				CheckRange("時", hour, 0, 23);
				CheckRange("分", minute, 0, 59);
				CheckRange("秒", second, 0, 59);
				return ResolveTimeOnly(hour, minute, second, anchorTs);
			}

			throw new FormatException("日時の形が違います: " + raw + "（" + FormatHelp + "）");
		}
	}
}

/*
 * JST の文字列（yyyy/mm/dd HH:mm:ss.fff）を組み立てる。
 *
 * recent --since / --before 用に、サーバーの sent_at と同じスラッシュ区切りで
 * 作る。WaitLog も同じ書式に揃えている（以前はハイフン区切りの独自メソッドを
 * 持ち、node 版の writeWaitLog と食い違っていた。レビュー #20、i260908-05）。
 *
 * DateTime.UtcNow に 9 時間足すだけで、OS のタイムゾーン設定には
 * 依存しない（node 版の nowJst() と同じ考え方）。
 */
using System;
using System.Globalization;

namespace AiChat
{
	internal static class JstTime
	{
		private const string Format = "yyyy/MM/dd HH:mm:ss.fff";

		/// <summary>いまの JST を "yyyy/mm/dd HH:mm:ss.fff" 形式で返す</summary>
		public static string NowJst()
		{
			return DateTime.UtcNow.AddHours(9).ToString(Format, CultureInfo.InvariantCulture);
		}

		/// <summary>JST の年月日時分秒から、NowJst() と同じ書式の文字列を組み立てる</summary>
		public static string FromParts(int year, int month, int day, int hour, int minute, int second)
		{
			var dt = new DateTime(year, month, day, hour, minute, second, DateTimeKind.Unspecified);
			return dt.ToString(Format, CultureInfo.InvariantCulture);
		}

		/// <summary>NowJst() と同じ書式の文字列を、指定ミリ秒だけずらして返す</summary>
		public static string Shift(string jstStr, long deltaMs)
		{
			DateTime dt = DateTime.ParseExact(jstStr, Format, CultureInfo.InvariantCulture);
			return dt.AddMilliseconds(deltaMs).ToString(Format, CultureInfo.InvariantCulture);
		}

		/// <summary>指定ミリ秒前の JST を、NowJst() と同じ書式で返す（recent --since-day / --since-hour 用）</summary>
		public static string Before(long ms)
		{
			return DateTime.UtcNow.AddHours(9).AddMilliseconds(-ms).ToString(Format, CultureInfo.InvariantCulture);
		}
	}
}

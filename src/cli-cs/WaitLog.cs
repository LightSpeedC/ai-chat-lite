/*
 * 待受けの記録。
 *
 * node 版（chat.mjs の writeWaitLog）と同じものを同じ置き場に書く。
 * 待受けは背面で走るため、外から止められると何も残らない。1 回の long-poll が
 * 返るたびに 1 行書けば、最後の行の時刻が「最後に生きていた時刻」になる。
 *
 * 置き場は logs/client/yyyymmdd-hhmmss-<名乗る ID>.log。
 * 名前の先頭を日時にすると、名前順がそのまま時系列順になる。
 *
 * 書けなくても待受けは続ける。記録のために本体を止めるのは本末転倒である。
 */
using System;
using System.IO;
using System.Text;

namespace AiChat
{
	internal static class WaitLog
	{
		private static string path;

		/// <summary>記録を始める。テストのときと、書けないときは何もしない</summary>
		public static void Open(string root, string connectorId, bool isTest)
		{
			if (isTest) return;
			try
			{
				string dir = Path.Combine(root, "logs", "client");
				Directory.CreateDirectory(dir);
				path = Path.Combine(dir, Stamp() + "-" + connectorId + ".log");
			}
			catch
			{
				path = null;
			}
		}

		/// <summary>1 行書く。書式はサーバーのログに揃える（日時 + レベル + 本文）</summary>
		public static void Write(string body)
		{
			Write("INFO", body);
		}

		public static void Write(string level, string body)
		{
			if (path == null) return;
			try
			{
				File.AppendAllText(path, JstTime.NowJst() + " " + level.PadRight(5) + " " + body + "\n", new UTF8Encoding(false));
			}
			catch
			{
				/* 書けなくても続ける */
			}
		}

		/// <summary>yyyymmdd-hhmmss。JST で組み立てる</summary>
		private static string Stamp()
		{
			DateTime jst = DateTime.UtcNow.AddHours(9);
			return jst.ToString("yyyyMMdd-HHmmss");
		}

	}
}

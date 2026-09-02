/*
 * サーバーを呼ぶ。
 *
 * node 版（src/client/chat.mjs の call）と同じ振る舞いにする。
 *
 *   繋がらないときと、メンテナンス中（503）のときは繋ぎ直す
 *   間隔は 10 秒。回数はコマンドで違う（wait は 60 回 = 10 分）
 *   出すのは始めの 1 行と、諦めたときの 1 行だけ
 *   諦めたら終了コード 3。「向こうの都合」だと呼ぶ側が判別できるようにする
 *
 * HttpClient ではなく HttpWebRequest を使う。System.Net.Http への参照を
 * 増やさずに済み、待ち時間（240 秒）も Timeout で素直に指定できる。
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace AiChat
{
	internal class Client
	{
		private readonly string baseUrl;
		private readonly string accessToken;
		private readonly int retryTimes;
		private readonly Action<string> log;

		public Client(string baseUrl, string accessToken, int retryTimes, Action<string> log = null)
		{
			this.baseUrl = baseUrl;
			this.accessToken = accessToken ?? "";
			this.retryTimes = retryTimes;
			this.log = log;
		}

		/// <summary>繋ぎ直す長さを人が読む形にする</summary>
		public string DescribeRetry()
		{
			int total = Definition.RetryIntervalSec * retryTimes;
			string span = total % 60 == 0 ? (total / 60) + " 分" : total + " 秒";
			return span + "（" + Definition.RetryIntervalSec + " 秒 × " + retryTimes + " 回）まで";
		}

		public Dictionary<string, object> Get(string path, int timeoutSec = 60)
		{
			return Send("GET", path, null, timeoutSec);
		}

		public Dictionary<string, object> Post(string path, string jsonBody, int timeoutSec = 60)
		{
			return Send("POST", path, jsonBody, timeoutSec);
		}

		private Dictionary<string, object> Send(string method, string path, string jsonBody, int timeoutSec)
		{
			bool announced = false;
			string lastReason = "";

			for (int attempt = 0; attempt <= retryTimes; attempt++)
			{
				if (attempt > 0) Thread.Sleep(Definition.RetryIntervalSec * 1000);

				try
				{
					return SendOnce(method, path, jsonBody, timeoutSec);
				}
				catch (Unreachable e)
				{
					lastReason = e.Message;
					if (!announced && retryTimes > 0)
					{
						Console.Error.WriteLine("サーバーに繋がりません: " + baseUrl);
						Console.Error.WriteLine("  " + DescribeRetry() + "繋ぎ直します");
						announced = true;
					}
				}
				catch (UnderMaintenance e)
				{
					lastReason = "メンテナンス中です（" + e.Message + "）";
					if (!announced && retryTimes > 0)
					{
						Console.Error.WriteLine("メンテナンス中です: " + e.Message);
						Console.Error.WriteLine("  " + DescribeRetry() + "繋ぎ直します");
						announced = true;
					}
				}
			}

			Console.Error.WriteLine("諦めました: " + lastReason);
			if (log != null) log("諦めました: " + lastReason);
			Environment.Exit(Definition.ExitUnreachable);
			return null; // ここには来ない
		}

		private Dictionary<string, object> SendOnce(string method, string path, string jsonBody, int timeoutSec)
		{
			var request = (HttpWebRequest)WebRequest.Create(baseUrl + path);
			request.Method = method;
			// 待ち時間より少し長くする。240 秒待つ long-poll がここで切れては困る
			request.Timeout = (timeoutSec + 30) * 1000;
			request.ReadWriteTimeout = (timeoutSec + 30) * 1000;
			if (!string.IsNullOrEmpty(accessToken)) request.Headers.Add("X-AiChat-Access-Token", accessToken);

			if (jsonBody != null)
			{
				request.ContentType = "application/json";
				byte[] body = Encoding.UTF8.GetBytes(jsonBody);
				request.ContentLength = body.Length;
				try
				{
					using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
				}
				catch (WebException e)
				{
					throw new Unreachable("繋がりません（" + e.Status + "）");
				}
			}

			try
			{
				using (var response = (HttpWebResponse)request.GetResponse())
				{
					return ReadJson(response);
				}
			}
			catch (WebException e)
			{
				var response = e.Response as HttpWebResponse;
				if (response == null) throw new Unreachable("繋がりません（" + e.Status + "）");

				using (response)
				{
					Dictionary<string, object> json = ReadJson(response);
					int status = (int)response.StatusCode;

					// メンテナンス中。落ちているのではないので、同じように粘る
					if (status == 503)
					{
						throw new UnderMaintenance(Json.Str(json, "detail", "理由の記載なし"));
					}

					Console.Error.WriteLine("エラー (" + status + "): " + Json.Str(json, "error", "不明"));
					string detail = Json.Str(json, "detail");
					if (detail != null) Console.Error.WriteLine("  " + detail);
					Environment.Exit(1);
					return null;
				}
			}
		}

		private static Dictionary<string, object> ReadJson(HttpWebResponse response)
		{
			using (Stream stream = response.GetResponseStream())
			using (var reader = new StreamReader(stream, Encoding.UTF8))
			{
				string text = reader.ReadToEnd();
				if (string.IsNullOrEmpty(text)) return new Dictionary<string, object>();
				try
				{
					return Json.ParseObject(text);
				}
				catch (JsonException)
				{
					// JSON でない応答。エラーの本文が HTML で返る場合など
					return new Dictionary<string, object>();
				}
			}
		}

		private class Unreachable : Exception
		{
			public Unreachable(string message) : base(message) { }
		}

		private class UnderMaintenance : Exception
		{
			public UnderMaintenance(string message) : base(message) { }
		}
	}
}

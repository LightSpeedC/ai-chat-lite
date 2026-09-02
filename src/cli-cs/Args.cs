/*
 * 引数の解析。
 *
 * node 版（src/client/chat.mjs）と同じ振る舞いにする。食い違うと、同じ
 * コマンドを書いたのに片方だけ動かないことになる。
 *
 * 決めごと（node 版から引き継ぐもの）
 *   接続先と名乗る ID に既定値を持たない。指定が無ければ繋ぐ直前に止める
 *   --url と --port は同時に指定できない
 *   待つ長さは 1 つだけ。--wait-hour と --wait-min の併用はエラー
 *   廃止したオプションは黙って無視せず、エラーで止める
 */
using System;
using System.Collections.Generic;
using System.Linq;

namespace AiChat
{
	internal class Args
	{
		/// <summary>コマンド名。何も無ければ null</summary>
		public string Command { get; private set; }

		/// <summary>コマンドより後ろの引数</summary>
		private readonly List<string> rest;

		/// <summary>コマンドを含む全部。旗と廃止の判定に使う</summary>
		private readonly List<string> words;

		public Args(string[] argv)
		{
			words = new List<string>(argv);
			Command = argv.Length > 0 ? argv[0] : null;
			rest = argv.Length > 1 ? new List<string>(argv.Skip(1)) : new List<string>();
		}

		/// <summary>廃止したオプションが渡されていないかを確かめる。あれば止める</summary>
		public void RejectRemoved()
		{
			foreach (RemovedDef r in Definition.Removed)
			{
				if (!words.Contains("--" + r.Name)) continue;
				Console.Error.WriteLine("--" + r.Name + " は廃止されました。");
				Console.Error.WriteLine("  " + r.Hint);
				Environment.Exit(2);
			}
		}

		/// <summary>--name value の形で値を取る。短い形も同じ値として受ける</summary>
		public string Option(string longName, string fallback = null)
		{
			OptionDef def = Definition.Find(longName);
			foreach (string flag in def.Flags())
			{
				int i = rest.IndexOf(flag);
				if (i >= 0 && i + 1 < rest.Count) return rest[i + 1];
			}
			return fallback;
		}

		/// <summary>値を取らないオプションが渡されたか</summary>
		public bool HasFlag(string longName)
		{
			OptionDef def = Definition.Find(longName);
			return def.Flags().Any(flag => words.Contains(flag));
		}

		/// <summary>オプションでない引数（本文など）を順に返す</summary>
		public List<string> Positionals()
		{
			var found = new List<string>();
			for (int i = 0; i < rest.Count; i++)
			{
				if (rest[i].StartsWith("-"))
				{
					// 旗は値を取らない。飛ばすと次の位置引数が消える
					if (!Definition.FlagNames.Contains(rest[i])) i++;
					continue;
				}
				found.Add(rest[i]);
			}
			return found;
		}

		public string Positional()
		{
			List<string> found = Positionals();
			return found.Count > 0 ? found[0] : null;
		}

		/// <summary>
		/// 接続先を決める。既定値は持たない。
		///
		/// --url はホストごと、--port は localhost のポートだけを変える。
		/// 同じことを 2 通りで書けるため、両方あればエラーにする。片方を黙って
		/// 優先すると、書いたつもりの側が効かずに気づけない。
		/// </summary>
		public string ResolveBase()
		{
			string url = Option("url");
			string port = Option("port");

			if (url != null && port != null)
			{
				Console.Error.WriteLine("--url と --port は同時に指定できません。どちらか一方にしてください。");
				Environment.Exit(2);
			}
			if (url != null) return url.TrimEnd('/');
			if (port != null)
			{
				int parsed;
				if (!int.TryParse(port, out parsed))
				{
					Console.Error.WriteLine("--port には数だけを渡してください: " + port);
					Environment.Exit(2);
				}
				return "http://localhost:" + port;
			}
			return null;
		}

		/// <summary>
		/// 最大どれだけ待つかを秒で返す。0 は上限なし。
		///
		/// 単位ごとにオプションを持つので、2 つ以上あればエラーにする。
		/// 足したり後勝ちにしたりすると、書いたつもりの側が効かない。
		/// </summary>
		public WaitSpec ResolveWaitSec()
		{
			var given = new List<KeyValuePair<string, string>>();
			foreach (var unit in Definition.WaitUnits)
			{
				string raw = Option(unit.Key);
				if (raw != null) given.Add(new KeyValuePair<string, string>(unit.Key, raw));
			}

			if (given.Count > 1)
			{
				string names = string.Join(" と ", given.Select(g => "--" + g.Key).ToArray());
				Console.Error.WriteLine("待つ長さは 1 つだけ指定してください: " + names + " が両方あります。");
				Environment.Exit(2);
			}
			if (given.Count == 0) return new WaitSpec { Sec = Definition.DefaultWaitSec, FromDefault = true };

			string name = given[0].Key;
			string value = given[0].Value;
			int number;
			if (!int.TryParse(value, out number) || number < 0)
			{
				Console.Error.WriteLine("--" + name + " には 0 以上の数だけを渡してください: " + value);
				Environment.Exit(2);
			}

			int per = Definition.WaitUnits.First(u => u.Key == name).Value;
			return new WaitSpec { Sec = number * per, FromDefault = false };
		}
	}

	internal class WaitSpec
	{
		public int Sec;
		public bool FromDefault;
	}
}

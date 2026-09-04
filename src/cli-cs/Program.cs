/*
 * ai-chat-lite の CLI（C# 版）。
 *
 * node 版（src/client/chat.mjs）と同じことができる。どちらを使ってもよい。
 *
 *   node 版  node <ai-chat-lite>/src/client/chat.mjs wait :<id>: -p 8787
 *   C# 版    aichat wait :<id>: -p 8787
 *
 * Node を要らなくするために作った。パスを書かせずに済むこと、起動が速いことも
 * 狙いである。DB は触らず、すべて HTTP 越しに行うのは node 版と同じ。
 *
 * 定義（オプションとコマンド）は options.mjs から書き出した JSON を埋め込んで
 * いる。手で写していないので、2 本が食い違わない。
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace AiChat
{
	internal static partial class Program
	{
		/// <summary>在席の印。presence.mjs の STATUS と対応する</summary>
		private static readonly Dictionary<string, string> StatusMark = new Dictionary<string, string>
		{
			{ "online", "●" }, { "grace", "◐" }, { "offline", "○" },
		};

		/// <summary>ID を使わないコマンド。読むだけなので名乗る必要がない</summary>
		private static readonly HashSet<string> ReadOnly = new HashSet<string>
		{
			"recent", "who", "dump", "archives",
		};

		/// <summary>
		/// サーバーに繋がないコマンド。手元のプロセスだけを見る。
		/// 接続先（--port / --url）を要求しない。
		/// </summary>
		private static readonly HashSet<string> LocalOnly = new HashSet<string>
		{
			"waiters",
		};

		/// <summary>
		/// 前面のツール実行が背面に移されるまでの秒数。
		/// 打ち切られるのではないが、それまで呼び出し側が待たされる。
		/// </summary>
		private const int ForegroundSec = 600;

		private static Args args;
		private static string baseUrl;
		private static string connectorId;
		private static string room;
		private static string accessToken;
		private static Client client;

		private static int Main(string[] argv)
		{
			// 日本語を出すため。既定のままだと文字化けする端末がある
			Console.OutputEncoding = Encoding.UTF8;

			try
			{
				return Run(argv);
			}
			catch (Exception e)
			{
				Console.Error.WriteLine("止まりました: " + e.Message);
				return 1;
			}
		}

		private static int Run(string[] argv)
		{
			args = new Args(argv);
			args.RejectRemoved();

			bool wantsHelp = args.HasFlag("help");
			string command = args.Command;

			/*
			 * 使い方を出して終わるのは 3 通り。
			 *   コマンドを付けない / -h・--help を付ける / 知らないコマンドを渡す
			 * 知らないコマンドだけ終了コード 1 にする。書き間違いに気づけるようにするため。
			 */
			bool known = command != null && (
				Definition.Commands.Any(c => c.Name == command) ||
				Definition.AdminCommands.Any(c => c.Name == command));

			if (wantsHelp || !known)
			{
				Usage();
				return (!wantsHelp && command != null) ? 1 : 0;
			}

			baseUrl = args.ResolveBase();
			room = args.Option("room", Definition.DefaultRoom);
			accessToken = args.Option("access-token", "");

			/*
			 * 名乗る ID はコマンドの直後の位置引数。読むだけのコマンドは取らない。
			 * どちらかを Args に教えてから、本文などを数え始める。
			 */
			bool takesId = !ReadOnly.Contains(command);
			args.TakesConnectorId(takesId);
			if (takesId) RequireConnectorId();

			/*
			 * サーバーに繋がないコマンドでは、接続先を要求しない。
			 * waiters は手元のプロセスだけを見るので、--port も --url も要らない。
			 */
			if (!LocalOnly.Contains(command))
			{
				client = new Client(RequireBase(), accessToken, Definition.RetryFor(command), WaitLog.Write);
			}

			switch (command)
			{
				case "join": return CmdJoin();
				case "wait": return CmdWait();
				case "say": return CmdSay();
				case "recent": return CmdRecent();
				case "who": return CmdWho();
				case "waiters": return CmdWaiters();
				case "dump": return CmdDump();
				case "leave": return CmdLeave();
				case "archive": return CmdArchive();
				case "archives": return CmdArchives();
				case "restore": return CmdRestore();
				case "restart": return CmdExit(1);
				case "stop": return CmdExit(0);
				default:
					Usage();
					return 1;
			}
		}

		// --- 前提の確認 ---

		private static string RequireConnectorId()
		{
			if (!string.IsNullOrEmpty(connectorId)) return connectorId;

			string raw = args.RawConnectorId();
			if (raw == null)
			{
				string w = Definition.IdWrap;
				Console.Error.WriteLine("名乗る ID が指定されていません。");
				Console.Error.WriteLine("");
				Console.Error.WriteLine("  " + args.Command + " の直後に、コロンで囲んで置いてください:");
				Console.Error.WriteLine("    " + args.Command + " " + w +
					new DirectoryInfo(Directory.GetCurrentDirectory()).Name + w);
				Console.Error.WriteLine("");
				Console.Error.WriteLine("  自分の project フォルダ名にしておくと、誰の発言か分かりやすくなります。");
				Environment.Exit(1);
			}

			connectorId = Args.UnwrapId(raw, args.Command + " の直後");
			return connectorId;
		}

		private static string RequireBase()
		{
			if (!string.IsNullOrEmpty(baseUrl)) return baseUrl;

			Console.Error.WriteLine("接続先が指定されていません。--port <ポート> か --url <URL> を渡してください。");
			Console.Error.WriteLine("  本番: --port " + Definition.DefaultPort);
			Console.Error.WriteLine("  テスト用: 置き場の server.json の port を使う");
			Environment.Exit(2);
			return null;
		}

		// --- 使い方 ---

		/*
		 * 定義から組み立てる。オプションを増やせば表示にも出る。
		 * 手で 2 か所に書いていた頃は必ずずれた。
		 */
		private static void Usage()
		{
			Console.WriteLine("ai-chat-lite クライアント（C# 版）");
			Console.WriteLine("");
			Console.WriteLine("  接続先: " + (baseUrl ?? "(未指定)  ← --port " + Definition.DefaultPort + " か --url <URL> を渡してください"));
			Console.WriteLine("  名乗る ID: " + (string.IsNullOrEmpty(connectorId)
				? "(未指定)  ← コマンドの直後に " + Definition.IdWrap + "<自分のID>" + Definition.IdWrap + " を置いてください"
				: connectorId));
			Console.WriteLine("  ルーム: " + (room ?? Definition.DefaultRoom) + "         （--room で変更できる）");
			Console.WriteLine("");

			/*
			 * 説明を始める列。node 版の HELP_COLUMN と同じ値にする。
			 * ずれると、同じ内容なのに 2 本の出力が食い違う。
			 */
			const int width = 40;

			Console.WriteLine("コマンド:");
			foreach (CommandDef c in Definition.Commands)
			{
				string head = "  " + c.Name + (c.Arg == "" ? "" : " " + c.Arg);
				Console.WriteLine(Pad(head, width) + c.Desc);
				foreach (OptionDef o in Definition.Options.Where(o => o.Cmd == c.Name))
				{
					Console.WriteLine(Pad("      " + Label(o), width) + o.Desc);
				}
			}

			Console.WriteLine("");
			Console.WriteLine("サーバーの操作（管理者権限は要らない）:");
			foreach (CommandDef c in Definition.AdminCommands)
			{
				Console.WriteLine(Pad("  " + c.Name + (c.Arg == "" ? "" : " " + c.Arg), width) + c.Desc);
			}

			Console.WriteLine("");
			Console.WriteLine("どのコマンドにも付けられるもの:");
			foreach (OptionDef o in Definition.Options.Where(o => o.Cmd == null))
			{
				Console.WriteLine(Pad("  " + Label(o), width) + o.Desc);
			}
		}

		/// <summary>--name <値>  -x の形にする</summary>
		private static string Label(OptionDef o)
		{
			string text = "--" + o.Long + (o.Arg == "" ? "" : " " + o.Arg);
			if (!string.IsNullOrEmpty(o.Short)) text += "  -" + o.Short;
			return text;
		}

		/*
		 * 全角を 2 文字ぶんとして数えて幅を揃える。
		 * PadRight は文字数で数えるため、日本語が混じると列がずれる。
		 */
		private static string Pad(string text, int width)
		{
			int shown = 0;
			foreach (char c in text) shown += IsWide(c) ? 2 : 1;
			return text + new string(' ', Math.Max(1, width - shown));
		}

		private static bool IsWide(char c)
		{
			return (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
				   (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
				   (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
				   (c >= 0xFFE0 && c <= 0xFFE6);
		}

		// --- 表示 ---

		/// <summary>メッセージを並べる。仕組みからの発言は -- を付けて区別する</summary>
		private static void PrintMessages(List<object> messages)
		{
			foreach (object item in messages)
			{
				var m = item as Dictionary<string, object>;
				if (m == null) continue;

				string kind = Json.Str(m, "msg_kind", "say");
				string sentAt = Json.Str(m, "sent_at", "");
				string body = Json.Str(m, "msg_body", "");

				/*
				 * 先頭に #<msg_seq> を 6 桁右詰めで出す。これが無いと、受け取った
				 * 発言に返信しようにも指す先を書けない。# を付けるのは、付けないと
				 * 「474 2026/09/04」と数が 2 つ並び、境目を読み手が判断することになるため。
				 *
				 * 仕組みからの発言（join / leave / archive / notice）にも番号を出す。
				 * 種別で出し分けると、読み手が「番号が無い行は何か」を考えることになる。
				 */
				string seq = PadStartW("#" + Json.Int(m, "msg_seq"), 6);

				if (kind != "say")
				{
					Console.WriteLine(seq + " " + sentAt + " -- " + body);
					continue;
				}

				string from = Json.Str(m, "from_connector_id", "");
				string to = Json.Str(m, "to_connector_id");
				object replyRaw;
				string reply = m.TryGetValue("reply_to_msg_seq", out replyRaw) && replyRaw != null
					? " ↳#" + Json.Int(m, "reply_to_msg_seq")
					: "";

				string at = to == null ? "" : " @" + to;
				Console.WriteLine(seq + " " + sentAt + " " + from + at + reply + " > " + body);
			}
		}

		private static string Query(string name, string value)
		{
			return name + "=" + Uri.EscapeDataString(value ?? "");
		}
	}
}

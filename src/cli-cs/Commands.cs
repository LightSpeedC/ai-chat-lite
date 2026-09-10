/*
 * 各コマンドの中身。
 *
 * node 版（src/client/chat.mjs）と同じ振る舞い・同じ出力にする。出力まで
 * 揃えるのは、どちらで実行しても同じものが読めるようにするため。
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
		// --- 参加・離脱 ---

		private static int CmdJoin()
		{
			string role = args.Option("role", "ai");
			string body = "{" +
				"\"connector_id\":" + Json.Quote(connectorId) + "," +
				"\"connector_role\":" + Json.Quote(role) + "," +
				"\"room_id\":" + Json.Quote(room) + "}";

			Dictionary<string, object> result = client.Post("/api/join", body);

			Console.WriteLine(connectorId + " として " + Json.Str(result, "room_id", room) +
				" に参加しました（現在位置 " + Json.Int(result, "msg_seq") + "）");
			PrintConnectors(Json.Arr(result, "connectors"));
			return 0;
		}

		private static int CmdLeave()
		{
			string body = "{" +
				"\"connector_id\":" + Json.Quote(connectorId) + "," +
				"\"room_id\":" + Json.Quote(room) + "}";
			client.Post("/api/leave", body);
			Console.WriteLine(connectorId + " として離脱しました");
			return 0;
		}

		// --- 発言 ---

		private static int CmdSay()
		{
			string text = args.Positional();
			if (string.IsNullOrEmpty(text))
			{
				string w = Definition.IdWrap;
				Console.Error.WriteLine("本文を指定してください: say " + w + "<自分のID>" + w +
					" \"本文\" [--to " + w + "<相手>" + w + "] [--reply-to <msg_seq>]");
				return 2;
			}

			string to = args.OptionalWrappedId("to");
			long replyTo = args.ReplyToMsgSeq();
			string body = "{" +
				"\"from_connector_id\":" + Json.Quote(connectorId) + "," +
				"\"room_id\":" + Json.Quote(room) + "," +
				(to == null ? "" : "\"to_connector_id\":" + Json.Quote(to) + ",") +
				(replyTo == 0 ? "" : "\"reply_to_msg_seq\":" + replyTo + ",") +
				"\"msg_body\":" + Json.Quote(text) + "}";

			Dictionary<string, object> result = client.Post("/api/say", body);
			Console.WriteLine("送信しました（" + Json.Int(result, "msg_seq") + "）");
			return 0;
		}

		// --- 待受け ---

		private static int CmdWait()
		{
			WaitSpec spec = args.ResolveWaitSec();
			bool unlimited = spec.Sec == 0;
			string label = DescribeWait(spec.Sec);

			/*
			 * 1 回の long-poll は MAX_WAIT_SEC（240 秒）で必ず返る。返ってきたら
			 * 黙って張り直す。呼ぶ側から見ると 1 回の実行で長く待てる。
			 * 何回に分かれたかは呼ぶ側には関係がないので出さない。
			 */
			if (!spec.FromDefault && !unlimited && spec.Sec > ForegroundSec)
			{
				/*
				 * 括弧は「11 分」を秒に直して見せるためのもの。--wait-sec で
				 * 指定されたときは label 自体が秒なので、同じ値が 2 度出る。
				 */
				string detail = label == spec.Sec + " 秒" ? label : label + "（" + spec.Sec + " 秒）";
				Console.Error.WriteLine(detail + "待つ設定です。");
				Console.Error.WriteLine("  前面で呼ぶと " + ForegroundSec + " 秒で背面に移されます。プロセスは走り続けますが、");
				Console.Error.WriteLine("  それまでの間、呼び出し側は待たされます。");
				Console.Error.WriteLine("  はじめから run_in_background で呼んでください。");
				Console.Error.WriteLine("");
			}

			/*
			 * 参加・離脱では起こさない。
			 *
			 * public には join と leave が数分ごとに流れるため、既定のままだと 12 時間を
			 * 指定しても数分で返っていた。ルールは「参加・離脱の記録は伝えない」なので、
			 * 読まずに捨てるもので起こされていたことになる。
			 *
			 * 絞るのはサーバー側にする。ここで捨てて待ち直すと、下の waited += wait が
			 * 「待ち切った」前提で加算しているため、実際の経過より速く上限に達する。
			 * 除いた分もサーバーがカーソルを進めるので、取りこぼしにはならない。
			 */
			bool withJoins = args.HasFlag("with-joins");
			string excludeParam = withJoins ? "" : "&exclude=join,leave";

			/*
			 * 初めての接続なら案内を出す（i260909-01）。
			 *
			 * 「参加より前の発言は待たない」（USAGE「どこまで読んだかは覚えている」）は
			 * 資料に書いてあるが、読んでいても初回は踏むという報告があった。過去ログを
			 * 自動で流し込むのではなく、recent で自分から取りに行く形を案内するだけにする。
			 */
			Dictionary<string, object> cursorStatus = client.Get(
				"/api/cursor-status?" + Query("connector_id", connectorId) + "&" + Query("room_id", room));
			if (Json.Bool(cursorStatus, "first_time"))
			{
				string port = args.Option("port");
				string where = port != null ? "-p " + port : "-u " + args.Option("url");

				/*
				 * 初めてなのは、指定したルームのうち一部だけのことがある
				 * （first_time はいずれか 1 つでも初めてなら true）。
				 */
				var firstRooms = new List<string>();
				foreach (object item in Json.Arr(cursorStatus, "rooms"))
				{
					var r = item as Dictionary<string, object>;
					if (r != null && Json.Bool(r, "first_time")) firstRooms.Add(Json.Str(r, "room_id"));
				}
				string firstRoomsJoined = string.Join(", ", firstRooms.ToArray());

				Console.WriteLine("初めての接続です（" + firstRoomsJoined + "）。参加より前の発言は待ちません。過去が必要なら recent で取ってください（例）:");
				Console.WriteLine("    aichat recent --find \"ルール\" " + where + "   # ルール変更の周知をまとめて見る");
				Console.WriteLine("    aichat recent --since-day 1 " + where + "     # 1 日前からの発言を見る");
				Console.WriteLine("");

				/*
				 * 案内を出したら、待たずに終わる。理由は node 版と同じ
				 * （wait は完了時にしか通知が来ないため、案内を出しても待ち続けると
				 * 誰の目にも触れない）。wait=0 で 1 回だけ poll を叩き、カーソルだけ立てる。
				 *
				 * 対象は初めてのルームだけに絞る。room 全体（既存カーソルを持つ
				 * ルームも含む）に対してこれを呼ぶと、既存ルームの未読の新着まで
				 * 実際には取得したうえで、画面に出さないままカーソルだけ最新に
				 * 進めてしまう（i260909-03）。
				 */
				string firstRoomsParam = string.Join(",", firstRooms.ToArray());
				client.Get("/api/poll?" + Query("connector_id", connectorId) + "&" + Query("room_id", firstRoomsParam) + "&wait=0");
				Console.WriteLine("カーソルを立てました。改めて wait を実行してください。");
				return 0;
			}

			/*
			 * 出すのは 2 行だけ。12 時間を 240 秒ごとに知らせると 180 行になる。
			 *
			 * 「待受け中」と進行形にしてあるのは、この 1 行だけを見た相手に
			 * 「終わった」と読ませないため。待受けを張るサブエージェントは背面の
			 * コマンドを起こした時点で自分の仕事を終えるので、親には「終了」の扱いで
			 * 通知が届く。そこで張り直すと二重になる（課題 i260905-01）。
			 *
			 * pid を添えるのは、走っているかを親が確かめられるようにするため。
			 * aichat waiters が名指しする pid と同じ値になる。
			 */
			Console.WriteLine("pid " + System.Diagnostics.Process.GetCurrentProcess().Id +
				" で待受け中（最大 " + label + "、ルーム " + room + "、" + connectorId +
				(withJoins ? "、参加・離脱も" : "") + "）");

			WaitLog.Open(FindRoot(), connectorId, IsTestData());
			WaitLog.Write("待受け開始（最大 " + label + "、ルーム " + room + "、" + connectorId +
				"、pid " + System.Diagnostics.Process.GetCurrentProcess().Id +
				(withJoins ? "、参加・離脱も" : "、参加・離脱は除く") + "）");

			int waited = 0;
			Dictionary<string, object> last = null;

			while (unlimited || waited < spec.Sec)
			{
				int wait = unlimited ? Definition.MaxWaitSec : Math.Min(Definition.MaxWaitSec, spec.Sec - waited);

				/*
				 * since は渡さない。どこまで読んだかはサーバーが覚えている。
				 * 受け取った分は返答と同時に記録されるので、次はその続きから届く。
				 */
				string path = "/api/poll?" + Query("connector_id", connectorId) +
					"&" + Query("room_id", room) + "&wait=" + wait + excludeParam;
				last = client.Get(path, wait);
				waited += wait;

				List<object> messages = Json.Arr(last, "messages");
				WaitLog.Write("待機中（経過 " + waited + " 秒 / 上限 " +
					(unlimited ? "無し" : spec.Sec + " 秒") + "、新着 " + messages.Count +
					" 件、現在位置 " + DescribePositions(last) + "）");

				if (messages.Count > 0)
				{
					Console.WriteLine("新着 " + messages.Count + " 件:");
					PrintMessages(messages);
					WaitLog.Write("新着 " + messages.Count + " 件を受け取って終わります");
					return 0;
				}
			}

			Console.WriteLine("新着なし（" + label + "待機、現在位置 " + DescribePositions(last) + "）");
			WaitLog.Write("新着なし。上限まで待ち切って終わります（" + label + "）");
			return 0;
		}

		/// <summary>
		/// どこまで読んだかを 1 行で書く。
		///
		/// 位置はルームごとに持っている。1 つだけなら数を、複数なら「ルーム 数」を並べる。
		/// 複数のときに 1 つの数で出すと、どのルームの位置か分からない。
		/// </summary>
		private static string DescribePositions(Dictionary<string, object> result)
		{
			List<object> rooms = Json.Arr(result, "rooms");
			if (rooms.Count <= 1)
			{
				if (result.ContainsKey("msg_seq")) return Json.Int(result, "msg_seq").ToString(CultureInfo.InvariantCulture);
				var only = rooms.Count == 1 ? rooms[0] as Dictionary<string, object> : null;
				return only == null ? "0" : Json.Int(only, "msg_seq").ToString(CultureInfo.InvariantCulture);
			}

			var parts = new List<string>();
			foreach (object item in rooms)
			{
				var r = item as Dictionary<string, object>;
				if (r == null) continue;
				parts.Add(Json.Str(r, "room_id", "") + " " + Json.Int(r, "msg_seq"));
			}
			return string.Join(" / ", parts.ToArray());
		}

		/// <summary>待つ長さを人が読む形にする。0 は上限なし</summary>
		private static string DescribeWait(int sec)
		{
			if (sec == 0) return "上限なし";
			if (sec % 3600 == 0) return (sec / 3600) + " 時間";
			if (sec % 60 == 0) return (sec / 60) + " 分";
			return sec + " 秒";
		}

		// --- 読むだけ ---

		/// <summary>
		/// --since / --since-day / --since-hour から 1 つを解決する。
		///
		/// 3 つは排他。2 つ以上渡されたらエラー（exit 2）。どれも無ければ null。
		/// </summary>
		private static string ResolveSinceTs()
		{
			var given = new List<KeyValuePair<string, string>>();
			string since = args.Option("since");
			string sinceDay = args.Option("since-day");
			string sinceHour = args.Option("since-hour");
			if (since != null) given.Add(new KeyValuePair<string, string>("since", since));
			if (sinceDay != null) given.Add(new KeyValuePair<string, string>("since-day", sinceDay));
			if (sinceHour != null) given.Add(new KeyValuePair<string, string>("since-hour", sinceHour));

			if (given.Count > 1)
			{
				string names = string.Join(" と ", given.Select(u => "--" + u.Key).ToArray());
				Console.Error.WriteLine("期間の起点は 1 つだけ指定してください: " + names + " が両方あります。");
				Environment.Exit(2);
			}
			if (given.Count == 0) return null;

			string longName = given[0].Key;
			string raw = given[0].Value;
			if (longName == "since") return ParseSinceOrBeforeArg(raw, null);

			int n;
			if (!int.TryParse(raw, out n) || n < 0)
			{
				Console.Error.WriteLine("--" + longName + " には 0 以上の数だけを渡してください: " + raw);
				Environment.Exit(2);
			}
			long unitMs = longName == "since-day" ? 24L * 60 * 60 * 1000 : 60L * 60 * 1000;
			return JstTime.Before(n * unitMs);
		}

		/// <summary>
		/// --before を解決する。--since とは別に、単独でも渡せる（範囲検索は両方渡す）。
		///
		/// sinceTs（--since 系がすでに解決した値）を渡すと、年・日付を省いた分は
		/// それを引き継ぐ（「いま」とは比べない）。
		/// </summary>
		private static string ResolveBeforeTs(string sinceTs)
		{
			string raw = args.Option("before");
			return raw == null ? null : ParseSinceOrBeforeArg(raw, sinceTs);
		}

		private static string ParseSinceOrBeforeArg(string raw, string anchorTs)
		{
			try
			{
				return SinceParse.ResolveDateTimeArg(raw, anchorTs);
			}
			catch (FormatException e)
			{
				Console.Error.WriteLine(e.Message);
				Environment.Exit(2);
				return null;
			}
		}

		/// <summary>見出し行に出す、絞り込みの説明。分単位まで（秒・ミリ秒は削る）</summary>
		private static string DescribeFilter(string sinceTs, string beforeTs, string find, string from)
		{
			var parts = new List<string>();
			if (sinceTs != null) parts.Add(sinceTs.Substring(0, 16) + " 以降");
			if (beforeTs != null) parts.Add(beforeTs.Substring(0, 16) + " より前");
			if (find != null) parts.Add("「" + find + "」を含む");
			if (from != null) parts.Add(from + " からの");
			return parts.Count == 0 ? "直近 " : " " + string.Join("・", parts) + " ";
		}

		private static int CmdRecent()
		{
			string sinceTs = ResolveSinceTs();
			string beforeTs = ResolveBeforeTs(sinceTs);
			string find = args.Option("find");
			string from = args.OptionalFlexibleId("from");
			bool hasFilter = sinceTs != null || beforeTs != null || find != null || from != null;

			// 絞り込みのどれかを指定したときは既定の件数上限を 500 にする。
			// -n を明示すればそちらが勝つ。node 版と同じ規則
			string nRaw = args.Option("n");
			int limit;
			if (nRaw != null)
			{
				if (!int.TryParse(nRaw, out limit) || limit <= 0) limit = 20;
			}
			else
			{
				limit = hasFilter ? 500 : 20;
			}

			string query = "/api/history?" + Query("room_id", room) + "&limit=" + limit;
			if (sinceTs != null) query += "&" + Query("since_ts", sinceTs);
			if (beforeTs != null) query += "&" + Query("before_ts", beforeTs);
			if (find != null) query += "&" + Query("find", find);
			if (from != null) query += "&" + Query("from_connector_id", from);

			Dictionary<string, object> result = client.Get(query);
			List<object> messages = Json.Arr(result, "messages");

			if (messages.Count == 0)
			{
				Console.WriteLine(room + (hasFilter ? " には該当する発言がありません" : " にはまだ何もありません"));
				return 0;
			}
			Console.WriteLine(room + " の" + DescribeFilter(sinceTs, beforeTs, find, from) + messages.Count + " 件:");
			PrintMessages(messages);
			return 0;
		}

		private static int CmdWho()
		{
			Dictionary<string, object> result = client.Get("/api/connectors");
			List<object> connectors = Json.Arr(result, "connectors");

			if (connectors.Count == 0)
			{
				Console.WriteLine("まだ誰も参加していません");
				return 0;
			}

			Console.WriteLine("参加者:");
			foreach (object item in connectors)
			{
				var c = item as Dictionary<string, object>;
				if (c == null) continue;

				string status = Json.Str(c, "status", "offline");
				string mark = StatusMark.ContainsKey(status) ? StatusMark[status] : "?";
				string label = Json.Str(c, "status_label", status);
				int connections = Json.Int(c, "active_connection_count");

				Console.WriteLine("  " + mark + " " + Pad(Json.Str(c, "connector_id", ""), 22) +
					Pad(label, 12) + Pad(Json.Str(c, "connector_role", ""), 7) +
					"最終 " + Json.Str(c, "last_active_at", "") +
					(connections > 0 ? "  接続 " + connections : ""));
			}
			return 0;
		}

		/// <summary>参加者を短く並べる。join の後に出す</summary>
		private static void PrintConnectors(List<object> connectors)
		{
			Console.WriteLine("参加者 " + connectors.Count + " 人:");
			foreach (object item in connectors)
			{
				var c = item as Dictionary<string, object>;
				if (c == null) continue;
				string status = Json.Str(c, "status", "offline");
				string mark = StatusMark.ContainsKey(status) ? StatusMark[status] : "?";
				Console.WriteLine("  " + mark + " " + Json.Str(c, "connector_id", "") +
					" (" + Json.Str(c, "status_label", status) + ")");
			}
		}

		private static int CmdDump()
		{
			string root = FindRoot();
			string outPath = args.Option("out", Path.Combine(root, "tmp", "messages.jsonl"));

			/*
			 * /api/dump はルームで絞らず、片付けたものも含めて全件を返す。
			 * 切り分けに使うものなので、見えているものだけでは足りない。
			 */
			Dictionary<string, object> result = client.Get("/api/dump");
			List<object> messages = Json.Arr(result, "messages");

			/*
			 * --out に階層なしの名前（例: messages.jsonl）を渡すと
			 * Path.GetDirectoryName が空文字列を返し、Directory.CreateDirectory("")
			 * は ArgumentException を投げていた。カレントに作るだけなので、
			 * 親ディレクトリが要る場合だけ作る（レビュー #19、i260908-05）
			 */
			string outDir = Path.GetDirectoryName(outPath);
			if (!string.IsNullOrEmpty(outDir)) Directory.CreateDirectory(outDir);
			var sb = new StringBuilder();
			int archived = 0;
			foreach (object item in messages)
			{
				var m = item as Dictionary<string, object>;
				if (m == null) continue;
				if (Json.Has(m, "archived_seq")) archived++;
				sb.Append(Stringify(m)).Append('\n');
			}
			File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));

			Console.WriteLine(messages.Count + " 件を書き出しました（片付けたもの " + archived + " 件を含む）: " + outPath);
			return 0;
		}

		// --- 片付ける ---

		private static int CmdArchive()
		{
			List<string> found = args.Tail();
			if (found.Count < 2)
			{
				string w = Definition.IdWrap;
				Console.Error.WriteLine("対象を指定してください: archive " + w + "<自分のID>" + w +
					" message|connector|room <対象>");
				return 2;
			}

			string kind = found[0];
			string rawId = found[1];

			if (kind != "message" && kind != "connector" && kind != "room")
			{
				Console.Error.WriteLine("kind は message / connector / room です: " + kind);
				return 2;
			}

			/*
			 * 参加者を片付けるときだけ、対象も参加者の ID なのでコロンで囲む。
			 * 発言は番号、ルームはルーム ID なので囲まない。囲みの対象は参加者の ID だけ。
			 */
			string id = kind == "connector" ? Args.UnwrapId(rawId, "archive connector の対象") : rawId;

			/*
			 * 既定のルームはサーバー側でも弾くが、ここでも先に弾く。
			 * 下見を出して名前まで打たせてから断るのは、手間をかけさせるだけになる。
			 */
			if (kind == "room" && id == Definition.DefaultRoom)
			{
				Console.Error.WriteLine(Definition.DefaultRoom + " は片付けられません（参加時の行き先です）");
				return 2;
			}

			bool withMessages = args.HasFlag("with-messages");
			string query = "/api/admin/archive-preview?kind=" + kind + "&" + Query("id", id) +
				(withMessages ? "&with_messages=1" : "");
			Dictionary<string, object> counts = client.Get(query);

			int total = Json.Int(counts, "messages") + Json.Int(counts, "cursors") + Json.Int(counts, "connectors");
			if (total == 0)
			{
				Console.Error.WriteLine("片付けるものがありません: " + kind + " " + id);
				return 1;
			}

			PrintPreview(kind, id, counts);

			Console.Write("本当に片付ける場合は「" + id + "」と入力してください: ");
			string answer = (Console.ReadLine() ?? "").Trim();
			if (answer != id)
			{
				Console.WriteLine("中止しました。");
				return 1;
			}

			string description = args.Option("description");
			string body = "{" +
				"\"kind\":" + Json.Quote(kind) + "," +
				"\"id\":" + Json.Quote(id) + "," +
				"\"with_messages\":" + (withMessages ? "true" : "false") + "," +
				(description == null ? "" : "\"description\":" + Json.Quote(description) + ",") +
				"\"connector_id\":" + Json.Quote(connectorId) + "," +
				"\"confirm\":" + Json.Quote(id) + "}";

			Dictionary<string, object> result = client.Post("/api/admin/archive", body);

			Console.WriteLine("片付けました（archived_seq " + Json.Int(result, "archived_seq") + "）");
			Console.WriteLine("  " + Json.Str(result, "description", ""));
			Console.WriteLine("戻すには: restore " + Definition.IdWrap + connectorId + Definition.IdWrap +
				" " + Json.Int(result, "archived_seq"));
			return 0;
		}

		/// <summary>
		/// 参加者の ID を付け替える（i260909-02）。
		///
		/// archive と同じ形にする。先に件数を出し、旧 ID の入力を求めてから実行する。
		/// ID は connectors ・ cursors ・ messages（発言者 ・ 宛先 ・ 本文の @旧ID）・
		/// archives に散っており、手で SQL を書くと洗い出しから毎回やり直しになる。
		/// </summary>
		private static int CmdRename()
		{
			List<string> found = args.Tail();
			string w = Definition.IdWrap;
			if (found.Count < 3 || found[0] != "connector")
			{
				Console.Error.WriteLine("対象を指定してください: rename " + w + "<自分のID>" + w +
					" connector " + w + "<旧>" + w + " " + w + "<新>" + w);
				return 2;
			}

			string from = Args.UnwrapId(found[1], "rename の旧 ID");
			string to = Args.UnwrapId(found[2], "rename の新しい ID");
			if (from == to)
			{
				Console.Error.WriteLine("同じ ID には付け替えられません: " + from);
				return 2;
			}

			Dictionary<string, object> counts = client.Get("/api/admin/rename-preview?" + Query("from", from));

			Console.WriteLine("参加者 " + from + " を " + to + " に付け替えます。");
			Console.WriteLine("  参加者        " + Json.Int(counts, "connectors").ToString().PadLeft(4) + " 件");
			Console.WriteLine("  読んだ位置    " + Json.Int(counts, "cursors").ToString().PadLeft(4) + " 件");
			Console.WriteLine("  発言（差出人）" + Json.Int(counts, "messages_from").ToString().PadLeft(4) + " 件");
			Console.WriteLine("  発言（宛先）  " + Json.Int(counts, "messages_to").ToString().PadLeft(4) + " 件");
			Console.WriteLine("  発言（本文の @" + from + "）" + Json.Int(counts, "messages_body").ToString().PadLeft(4) + " 件");
			Console.WriteLine("  片付けの記録  " +
				(Json.Int(counts, "archives") + Json.Int(counts, "archive_targets")).ToString().PadLeft(4) + " 件");
			Console.WriteLine("走っている待受けがあると断られます。先に止めてください。");

			Console.Write("本当に付け替える場合は「" + from + "」と入力してください: ");
			string answer = (Console.ReadLine() ?? "").Trim();
			if (answer != from)
			{
				Console.WriteLine("中止しました。");
				return 1;
			}

			string body = "{" +
				"\"from\":" + Json.Quote(from) + "," +
				"\"to\":" + Json.Quote(to) + "," +
				"\"connector_id\":" + Json.Quote(connectorId) + "," +
				"\"confirm\":" + Json.Quote(from) + "}";

			Dictionary<string, object> result = client.Post("/api/admin/rename", body);

			int total = Json.Int(result, "connectors") + Json.Int(result, "cursors") +
				Json.Int(result, "messages_from") + Json.Int(result, "messages_to") +
				Json.Int(result, "messages_body") + Json.Int(result, "archives") +
				Json.Int(result, "archive_targets");
			Console.WriteLine("付け替えました（" + Json.Str(result, "from", from) + " → " +
				Json.Str(result, "to", to) + " / " + total + " 件）");
			Console.WriteLine("  待受けを張り直すときは、新しい ID で張ってください。");
			return 0;
		}

		/// <summary>何件片付くかを出す。0 件のものは出さない</summary>
		private static void PrintPreview(string kind, string id, Dictionary<string, object> counts)
		{
			string label = kind == "message" ? "発言" : kind == "connector" ? "参加者" : "ルーム";
			Console.WriteLine(label + " " + id + " を片付けると、次が見えなくなります。");

			int messages = Json.Int(counts, "messages");
			if (messages > 0)
			{
				string first = Json.Str(counts, "first", "");
				string last = Json.Str(counts, "last", "");
				string span = first == "" ? "" : "（" + Short(first) + " 〜 " + Short(last) + "）";
				Console.WriteLine("  発言       " + messages.ToString().PadLeft(4) + " 件" + span);
			}
			int cursors = Json.Int(counts, "cursors");
			if (cursors > 0) Console.WriteLine("  読んだ位置 " + cursors.ToString().PadLeft(4) + " 件");
			int connectors = Json.Int(counts, "connectors");
			if (connectors > 0) Console.WriteLine("  参加者     " + connectors.ToString().PadLeft(4) + " 件");

			Console.WriteLine("archives に記録され、restore で戻せます。");
		}

		/// <summary>yyyy-MM-dd HH:mm:ss.fff から MM-dd HH:mm を取る</summary>
		private static string Short(string sentAt)
		{
			return sentAt.Length >= 16 ? sentAt.Substring(5, 11) : sentAt;
		}

		private static int CmdArchives()
		{
			Dictionary<string, object> result = client.Get("/api/admin/archives");
			List<object> archives = Json.Arr(result, "archives");

			if (archives.Count == 0)
			{
				Console.WriteLine("片付けたものはありません。");
				return 0;
			}

			/*
			 * 対象（kind と id）を説明とは別の列で出す。
			 * 説明は --description で書き換えられるため、そこだけ見ても対象が分からない。
			 */
			var rows = new List<string[]>();
			foreach (object item in archives)
			{
				var a = item as Dictionary<string, object>;
				if (a == null) continue;

				string kind = Json.Str(a, "archive_kind", "");
				string label = kind == "message" ? "発言" : kind == "connector" ? "参加者" : kind == "room" ? "ルーム" : kind;
				int count = Json.Int(a, "msg_count") + Json.Int(a, "cursor_count") + Json.Int(a, "connector_count");

				rows.Add(new[]
				{
					Json.Int(a, "archived_seq").ToString(),
					Json.Str(a, "archived_at", ""),
					label + " " + Json.Str(a, "archive_id", ""),
					count.ToString(),
					Json.Str(a, "description", ""),
				});
			}

			int width = Math.Max(4, rows.Max(r => Shown(r[2])));
			Console.WriteLine("  seq  片付けた日時             " + Pad("対象", width) + " 件数  説明");
			foreach (string[] r in rows)
			{
				Console.WriteLine(r[0].PadLeft(5) + "  " + r[1] + "  " + Pad(r[2], width) +
					r[3].PadLeft(4) + "  " + r[4]);
			}
			return 0;
		}

		private static int CmdRestore()
		{
			string seq = args.Positional();
			int parsed;
			if (seq == null || !int.TryParse(seq, out parsed) || parsed < 1)
			{
				string w = Definition.IdWrap;
				Console.Error.WriteLine("戻す番号を指定してください: restore " + w + "<自分のID>" + w + " <archived_seq>");
				return 2;
			}

			string body = "{" +
				"\"archived_seq\":" + parsed + "," +
				"\"connector_id\":" + Json.Quote(connectorId) + "}";
			Dictionary<string, object> result = client.Post("/api/admin/restore", body);

			Console.WriteLine("archived_seq " + Json.Int(result, "archived_seq") + " を戻しました（" +
				Json.Int(result, "restored") + " 件）");
			Console.WriteLine("  " + Json.Str(result, "description", ""));
			return 0;
		}

		// --- サーバーの操作 ---

		/*
		 * 落とす。再起動されるかどうかは終了コードで決まる。
		 *   restart … 終了コード 1。異常終了として扱われ、10 秒後に起動し直す
		 *   stop    … 終了コード 0。正常終了として扱われ、止まったまま
		 */
		private static int CmdExit(int exitCode)
		{
			string body = "{" +
				"\"connector_id\":" + Json.Quote(connectorId) + "," +
				"\"exit_code\":" + exitCode + "}";
			Dictionary<string, object> result = client.Post("/api/admin/exit", body);

			Console.WriteLine("終了コード " + Json.Int(result, "exit_code") + " で終了します");
			if (exitCode == 1)
			{
				Console.WriteLine("  異常終了として扱われるため、10 秒後に起動し直します");
				Console.WriteLine("  10 秒ほど待ってから接続してください");
			}
			else
			{
				Console.WriteLine("  正常終了として扱われるため、止まったままになります");
				Console.WriteLine("  起動するには winsw の start が要ります");
			}
			return 0;
		}

		// --- 補助 ---

		/// <summary>全角を 2 文字ぶんとして数えた見た目の幅</summary>
		private static int Shown(string text)
		{
			int width = 0;
			foreach (char c in text) width += IsWide(c) ? 2 : 1;
			return width;
		}

		/*
		 * プロジェクトのルートを探す。
		 *
		 * exe は root に置く前提だが、どこから呼ばれても効くように、
		 * exe のある場所から上へ辿って package.json を探す。
		 */
		private static string FindRoot()
		{
			string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
			for (int i = 0; i < 5 && dir != null; i++)
			{
				if (File.Exists(Path.Combine(dir, "package.json"))) return dir;
				dir = Path.GetDirectoryName(dir);
			}
			return Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
		}

		/*
		 * テスト用の置き場を相手にしているか。
		 *
		 * CLI は DB を触らないので置き場を知らない。AICHAT_DATA が立っていれば
		 * テストとみなす（node 版の IS_TEST と同じ判断である）。
		 * 記録をテストで増やさないために使う。
		 */
		private static bool IsTestData()
		{
			return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("AICHAT_DATA"));
		}

		/// <summary>読んだ値を JSONL の 1 行に戻す</summary>
		private static string Stringify(object value)
		{
			if (value == null) return "null";
			if (value is bool) return (bool)value ? "true" : "false";
			if (value is double)
			{
				double d = (double)value;
				return d == Math.Floor(d) && !double.IsInfinity(d)
					? ((long)d).ToString(CultureInfo.InvariantCulture)
					: d.ToString("R", CultureInfo.InvariantCulture);
			}
			if (value is string) return Json.Quote((string)value);

			var obj = value as Dictionary<string, object>;
			if (obj != null)
			{
				var parts = obj.Select(p => Json.Quote(p.Key) + ":" + Stringify(p.Value));
				return "{" + string.Join(",", parts.ToArray()) + "}";
			}

			var arr = value as List<object>;
			if (arr != null)
			{
				return "[" + string.Join(",", arr.Select(Stringify).ToArray()) + "]";
			}

			return Json.Quote(Convert.ToString(value, CultureInfo.InvariantCulture));
		}
	}
}

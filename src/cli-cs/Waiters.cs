/*
 * 走っている待受けを数える（waiters コマンド）。
 *
 * サーバーには繋がない。手元のプロセスだけを見る。who は「サーバーが知って
 * いる在席」を返すが、本数は分からない（1 本でも 2 本でも「接続中」になる）。
 *
 * 【なぜコマンドにしたのか】
 * これまでは各プロジェクトに検索式を書かせていた。書き方を 1 つ守れなかった
 * だけで結果が反転し、そのたびに事故になった。
 *
 *   -c で絞らない        他プロジェクトの待受けまで数え、止めてしまう（i260901-07）
 *   プロセス名で絞る      張り方によって aichat.exe / cmd.exe / node.exe に変わる
 *   ID を直に書く        確認コマンド自身に一致し、0 本が 1 本に見える
 *   前方一致             project-a を探すと project-aa にも当たる
 *
 * 4 つとも原因は同じで、「式を人に書かせている」ことである。ここで数えれば
 * 誰も式を書かない。
 *
 * 【自分自身を数えない】
 * 自分の pid を除く。加えて、待受けに当たったプロセスの親も除く。
 * サブエージェントは pwsh 越しに呼ぶので、pwsh のコマンドラインにも
 * 「aichat wait :id:」がそのまま入っており、放っておくと 1 本が 2 本になる。
 * aichat-node なら cmd.exe → node.exe と 2 段になる。親をたどって落とす。
 *
 * node 版（chat.mjs の cmdWaiters）と同じ出力にする。出どころの式は
 * options.mjs の WAITER_PATTERN 1 か所で、埋め込んだ JSON から読む。
 */
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Management;
using System.Text.RegularExpressions;

namespace AiChat
{
	/// <summary>拾ったプロセス 1 つ</summary>
	internal class WaiterRow
	{
		public int Pid;
		public int Ppid;
		public string Name;
		public string Id;
		public DateTime At;
		public string Via;
		public string Target;    // 接続先の表示（:8787 や host:port）
		public List<string> Rooms;   // 見ているルーム。1 本で複数を見られる
		public int Port;         // 接続先のポート。読めなければ 0
	}

	/// <summary>どこを見ている待受けを数えるかの基準</summary>
	internal class Basis
	{
		public int Port;
		public List<string> Rooms;
		public string Label;
	}

	internal static partial class Program
	{
		private static int CmdWaiters()
		{
			List<WaiterRow> all = ListWaiters();
			Basis basis = BasisOf();

			if (all.Count == 0)
			{
				Console.WriteLine("待受けは走っていません。");
				Console.WriteLine("  " + string.Join(", ", basis.Rooms.ToArray()) + " の待受けがありません。次を張ってください:");
				Console.WriteLine("    " + WaitHint(basis.Rooms, connectorId));
				return 0;
			}

			PrintWaiters(all, basis, connectorId);
			return 0;
		}

		/// <summary>足りないルームを張るための 1 行を組み立てる</summary>
		private static string WaitHint(List<string> rooms, string me)
		{
			string port = args.Option("port", null);
			string where = port != null ? "-p " + port : "-u " + args.Option("url", "");
			return "aichat wait " + Definition.IdWrap + me + Definition.IdWrap +
				" " + where + " -r " + string.Join(",", rooms.ToArray());
		}

		/// <summary>
		/// どこを見ている待受けを数えるか。
		///
		/// --port / --url / --room で変えられる。渡さなければ本番の既定ルームになる。
		/// テスト用サーバーを相手にしているときも、同じコマンドで数えられるようにする。
		///
		/// ここを固定にしてしまうと、テスト環境では「全部が本番以外」に見えて
		/// 使えなくなる。基準は呼ぶ側が決める。
		/// </summary>
		private static Basis BasisOf()
		{
			string port = args.Option("port");
			string url = args.Option("url");

			/*
			 * 接続先を省略できない。既定値を持たない。
			 *
			 * 他のコマンドと同じ扱いにする。既定を本番にすると、テストのつもりで
			 * 数えたものが本番の本数として返る。「張っているから張らない」と判断して
			 * 本番の待受けが 1 本も無いまま止まる。書き込まないだけで、事故の形は同じ。
			 */
			if (port == null && url == null)
			{
				string w = Definition.IdWrap;
				Console.Error.WriteLine("どこを見ている待受けを数えるかが指定されていません。");
				Console.Error.WriteLine("");
				Console.Error.WriteLine("  本番: waiters " + w + "<自分のID>" + w +
					" -p " + Definition.DefaultPort + " -r " + Definition.DefaultRoom);
				Console.Error.WriteLine("");
				Console.Error.WriteLine("  既定値は持ちません。テストのつもりで数えた本数を本番の本数と読み違えるのを防ぐためです。");
				Environment.Exit(2);
			}

			int num = 0;
			if (port != null)
			{
				int.TryParse(port, out num);
			}
			else
			{
				Match m = Regex.Match(url, ":(\\d+)");
				if (m.Success) int.TryParse(m.Groups[1].Value, out num);
			}

			List<string> rooms = RoomsFrom(room);

			/*
			 * RoomsFrom はカンマで分割するだけで、文字種は見ていない。waiters は
			 * サーバーに繋がないため、サーバー側の room_id 検証を経由できない。
			 * シングルクォートで囲んで渡すと、cmd はクォート文字ごと値に含めて
			 * しまい（'public,ai-chat-lite' のような壊れた値になる）、そのまま
			 * カンマで割ると不正な文字を含む「ルーム名」がエラーにならず素通り
			 * していた（実際に指摘があった）。ここで弾く
			 */
			foreach (string r in rooms)
			{
				if (Regex.IsMatch(r, Definition.IdPattern)) continue;
				Console.Error.WriteLine("ルーム名に使えない文字が入っています: " + r);
				Console.Error.WriteLine("  使えるのは英数字・ハイフン・下線・ピリオドだけです。ピリオドは先頭と末尾には置けません。");
				Environment.Exit(2);
			}

			return new Basis { Port = num, Rooms = rooms, Label = ":" + num };
		}

		/// <summary>-r の値をルームの一覧にする。省略なら既定のルーム 1 つ。重複は落とす</summary>
		private static List<string> RoomsFrom(string value)
		{
			var rooms = new List<string>();
			string raw = (value ?? "").Trim();
			if (raw.Length > 0)
			{
				foreach (string part in raw.Split(','))
				{
					string room = part.Trim();
					if (room.Length > 0 && !rooms.Contains(room)) rooms.Add(room);
				}
			}
			if (rooms.Count == 0) rooms.Add(Definition.DefaultRoom);
			return rooms;
		}

		/// <summary>
		/// 待受けのプロセスを拾う。
		///
		/// WMI を .NET から直に引く。PowerShell を挟まないので、子プロセスが
		/// 数に混ざる余地がない。
		/// </summary>
		private static List<WaiterRow> ListWaiters()
		{
			var rows = new List<WaiterRow>();
			var names = new Dictionary<int, string>();
			var re = new Regex(Definition.WaiterPattern);
			int self = Process.GetCurrentProcess().Id;

			var query = new ManagementObjectSearcher(
				"SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process");

			foreach (ManagementObject o in query.Get())
			{
				string cmd = o["CommandLine"] as string;
				if (string.IsNullOrEmpty(cmd)) continue;

				int pid = Convert.ToInt32(o["ProcessId"]);
				if (pid == self) continue;

				Match m = re.Match(cmd);
				if (!m.Success) continue;

				var row = new WaiterRow
				{
					Pid = pid,
					Ppid = Convert.ToInt32(o["ParentProcessId"]),
					Name = (o["Name"] as string) ?? "",
					Id = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value,
					/*
					 * 秒に丸める。node 版は PowerShell に yyyy-MM-dd HH:mm:ss で
					 * 出させているため秒までしか持たない。ここでミリ秒を残すと、
					 * 同じ秒に立った 2 本の並び順が 2 本の CLI で食い違う（実際に食い違った）。
					 */
					At = TruncateToSecond(ManagementDateTimeConverter.ToDateTime((string)o["CreationDate"])),
				};
				FillTarget(row, cmd);
				rows.Add(row);
				names[row.Pid] = row.Name;
			}

			/*
			 * 親を落とす。pwsh → aichat.exe や pwsh → cmd.exe → node.exe と連なるとき、
			 * 途中の段はすべて同じコマンドラインを抱えているため全部が当たってしまう。
			 * 「当たったものの直親」を落とすと、連鎖でも末端 1 つだけが残る。
			 */
			var parents = new HashSet<int>(rows.Select(r => r.Ppid));
			List<WaiterRow> leaves = rows.Where(r => !parents.Contains(r.Pid)).ToList();

			// 親の名前から張り方を決める。cmd.exe 越しの node は aichat-node である
			foreach (WaiterRow r in leaves)
			{
				string parentName;
				names.TryGetValue(r.Ppid, out parentName);
				r.Via = ViaOf(r.Name, parentName);
			}

			return leaves.OrderBy(r => r.At).ThenBy(r => r.Pid).ToList();
		}

		/// <summary>ミリ秒を落とす。node 版と並び順を揃えるため</summary>
		private static DateTime TruncateToSecond(DateTime at)
		{
			return new DateTime(at.Year, at.Month, at.Day, at.Hour, at.Minute, at.Second, at.Kind);
		}

		/// <summary>コマンドラインから「--name 値」を読む。短い形も同じ値として受ける</summary>
		private static string ReadArg(string cmd, string longName, string shortName)
		{
			Match m = Regex.Match(cmd, "(?:^|\\s)(?:--" + longName + "|-" + shortName + ")\\s+([^\\s\"]+)");
			return m.Success ? m.Groups[1].Value : null;
		}

		/// <summary>
		/// その待受けが「どこを待っているか」を読む。
		///
		/// 【なぜ要るのか】
		/// 本数だけ数えても、待っている場所が違えば意味がない。とくにルームは
		/// 間違えても静かに動く。繋がっているので who は「接続中」と出し、waiters も
		/// 1 本と数えるが、public の発言は 1 つも届かない。どこも異常に見えない。
		///
		/// ポートは間違えれば繋がらないか別のサーバーに繋がるので、まだ気づける。
		/// ルームはそれが無い。だから両方を出す。
		///
		/// 値はすべて引数で渡す決まりなので、コマンドラインを読めば分かる。
		/// 環境変数で渡せるようにしていないのは、まさにこのためである。
		/// </summary>
		private static void FillTarget(WaiterRow row, string cmd)
		{
			string port = ReadArg(cmd, "port", "p");
			string url = ReadArg(cmd, "url", "u");
			string room = ReadArg(cmd, "room", "r");

			row.Rooms = RoomsFrom(room);
			row.Target = "(未指定)";
			int portNum = 0;

			if (port != null)
			{
				row.Target = ":" + port;
				int.TryParse(port, out portNum);
			}
			else if (url != null)
			{
				// スキームは落として host:port だけ出す
				string shown = Regex.Replace(url, "^[a-zA-Z]+://", "").TrimEnd('/');
				row.Target = shown;
				Match m = Regex.Match(shown, ":(\\d+)");
				if (m.Success) int.TryParse(m.Groups[1].Value, out portNum);
			}

			row.Port = portNum;
		}

		/// <summary>張り方の名前。出力に出るのは aichat / aichat-node / node の 3 つ</summary>
		private static string ViaOf(string name, string parentName)
		{
			string lower = (name ?? "").ToLowerInvariant();
			if (lower == "aichat.exe") return "aichat";
			if (lower == "node.exe")
			{
				return (parentName ?? "").ToLowerInvariant() == "cmd.exe" ? "aichat-node" : "node";
			}
			return lower.EndsWith(".exe") ? lower.Substring(0, lower.Length - 4) : lower;
		}

		/// <summary>経過を h:mm で返す。日をまたいでも時のまま増やす（2 日なら 48:00 になる）</summary>
		private static string ElapsedOf(DateTime at)
		{
			int min = (int)Math.Max(0, Math.Floor((DateTime.Now - at).TotalMinutes));
			return (min / 60) + ":" + (min % 60).ToString("00", CultureInfo.InvariantCulture);
		}

		/*
		 * 一覧を出す。node 版と 1 文字ずつ同じにする（テストで突き合わせている）。
		 *
		 * 幅は文字数ではなく表示幅で揃える。「張り方」は 3 文字だが 6 桁を占める。
		 */
		private static void PrintWaiters(List<WaiterRow> all, Basis basis, string me)
		{
			// 同じ接続先の分を並べる。ルームは列に出す。1 本が複数を見ていることがある
			List<WaiterRow> here = all.Where(r => r.Port == basis.Port).ToList();
			List<WaiterRow> elsewhere = all.Where(r => r.Port != basis.Port).ToList();

			Console.WriteLine("  " + basis.Label + " を見ている待受け");
			Console.WriteLine("");

			if (here.Count == 0)
			{
				Console.WriteLine("  ありません。");
			}
			else
			{
				int idWidth = Math.Max(Width("ID"), here.Max(r => Width(r.Id)));
				int viaWidth = Math.Max(Width("張り方"), here.Max(r => Width(r.Via)));
				int roomWidth = Math.Max(Width("ルーム"), here.Max(r => Width(string.Join(", ", r.Rooms.ToArray()))));

				Console.WriteLine("  " + PadEndW("ID", idWidth) + "  " + PadEndW("張り方", viaWidth) + "  " +
					PadEndW("いつから", 8) + "  " + PadStartW("経過", 5) + "  " +
					PadEndW("ルーム", roomWidth) + "  " + PadStartW("pid", 6));

				foreach (WaiterRow r in here)
				{
					// 自分の分に印を付ける。止めてよいのはこれだけである
					string mark = r.Id == me ? "*" : " ";
					Console.WriteLine(mark + " " + PadEndW(r.Id, idWidth) + "  " + PadEndW(r.Via, viaWidth) + "  " +
						r.At.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "  " +
						PadStartW(ElapsedOf(r.At), 5) + "  " +
						PadEndW(string.Join(", ", r.Rooms.ToArray()), roomWidth) + "  " +
						PadStartW(r.Pid.ToString(CultureInfo.InvariantCulture), 6));
				}
			}

			List<WaiterRow> mine = here.Where(r => r.Id == me).ToList();

			Console.WriteLine("");
			Console.WriteLine("  自分（" + me + "）: " + mine.Count + " 本 / この場所に " + here.Count + " 本");

			/*
			 * 別の場所を見ている自分の分は、pid まで出す。
			 *
			 * ルームを間違えた待受けは静かに動く。繋がっているので who は「接続中」と
			 * 出すが、この場所の発言は 1 つも届かない。件数だけでは止めようがないので
			 * pid を添える。他プロジェクトの分は件数だけにする（止めてはいけないため）。
			 */
			List<WaiterRow> strayMine = elsewhere.Where(r => r.Id == me).ToList();
			if (strayMine.Count > 0)
			{
				string shown = string.Join("、", strayMine
					.Select(r => "pid " + r.Pid + "（" + r.Target + " / " + string.Join(", ", r.Rooms.ToArray()) + "）").ToArray());
				Console.WriteLine("  自分の分が別の場所に " + strayMine.Count + " 本: " + shown);
			}

			// elsewhere は接続先が違う分だけ。同じ接続先ならルームが違っても表に出ている
			int others = elsewhere.Count - strayMine.Count;
			if (others > 0) Console.WriteLine("  他に " + others + " 本（別の接続先）");

			/*
			 * 次にやることを書く。事実だけ出すと、読み手が判断のためにルールを
			 * 思い出すことになる。その場に要る 1 行をここに出す。
			 *
			 * ただし指示するのは自分の分についてだけにし、対象を名指しする。
			 * 「1 本だけ残してください」のように読み手に選ばせると、他プロジェクトの
			 * 待受けを止める事故が起きる（i260901-07）。
			 */
			/*
			 * 覆えているかで見る。本数では見ない。
			 *
			 * 1 本が複数のルームを見られるようになったので、「2 ルームなら 2 本」は成り立たない。
			 * 渡したルームが 1 つでも欠けていれば、そこを名指しして張り方を出す。
			 */
			var covered = new HashSet<string>();
			foreach (WaiterRow r in mine) foreach (string room in r.Rooms) covered.Add(room);
			List<string> missing = basis.Rooms.Where(room => !covered.Contains(room)).ToList();

			/*
			 * 止めてよいのは、覆っている全ルームが他の待受けでも覆われているものだけ。
			 *
			 * 「2 本目以降を止める」にすると、そのルームを覆う唯一の 1 本まで名指しする。
			 * 言われたとおり止めれば覆えなくなり、張り直す → また二重、を往復する。
			 *
			 * 数えるのは渡したルームだけにする。待受けが見ている全ルームで数えると、
			 * 渡したルームが二重でも「覆えている」と出て、渡していないルームの pid を
			 * 止めろとも出る。
			 *
			 * 止めてよいかは、その待受けが見ている全ルームで見る。基準の中だけで見ると、
			 * 基準の外を覆っている側まで止めろと言うことになる。数ではなく中身を見るので、
			 * 外の数が同じでも持っているルームが違えば両方が残る。
			 *
			 * 並びは基準の外を多く持つものを先に。止められるものをより多く見つけられる。
			 * 古い順は、基準の外の数が同じときの決め方として残す。
			 */
			var basisRooms = new HashSet<string>(basis.Rooms);
			List<WaiterRow> order = mine
				.Where(r => r.Rooms.Any(room => basisRooms.Contains(room)))
				.OrderByDescending(r => r.Rooms.Count(room => !basisRooms.Contains(room)))
				.ThenBy(r => r.At)
				.ToList();
			var keep = new List<WaiterRow>();
			var stop = new List<WaiterRow>();
			var held = new HashSet<string>();
			foreach (WaiterRow r in order)
			{
				if (r.Rooms.All(room => held.Contains(room)))
				{
					stop.Add(r);
					continue;
				}
				keep.Add(r);
				foreach (string room in r.Rooms) held.Add(room);
			}

			/*
			 * やることは 1 つとは限らない。片方で打ち切ると、もう片方が隠れる。
			 * 「足りない」と「余っている」は同時に起こる。
			 */
			if (missing.Count > 0)
			{
				Console.WriteLine("  " + string.Join(", ", missing.ToArray()) + " の待受けがありません。次を張ってください:");
				Console.WriteLine("    " + WaitHint(missing, me));
			}

			if (stop.Count > 0)
			{
				// 出すのも基準の中だけ。渡していないルームの名前を混ぜない
				var rooms = new List<string>();
				foreach (WaiterRow r in stop) foreach (string room in r.Rooms) if (basisRooms.Contains(room) && !rooms.Contains(room)) rooms.Add(room);
				string stopped = string.Join(", ", stop.Select(r => r.Pid.ToString(CultureInfo.InvariantCulture)).ToArray());
				string kept = string.Join(", ", keep.Select(r => r.Pid.ToString(CultureInfo.InvariantCulture)).ToArray());
				Console.WriteLine("  " + string.Join(", ", rooms.ToArray()) +
					" を二重に張っています。pid " + stopped + " を止めてください（pid " + kept + " を残す）。");
			}

			if (missing.Count == 0 && stop.Count == 0)
			{
				Console.WriteLine("  すべて覆えています。張る必要はありません。");
			}
		}

		/// <summary>表示幅。全角を 2 桁として数える</summary>
		private static int Width(string text)
		{
			int w = 0;
			foreach (char c in text) w += IsWide(c) ? 2 : 1;
			return w;
		}

		/// <summary>表示幅で右に詰める</summary>
		private static string PadEndW(string text, int w)
		{
			return text + new string(' ', Math.Max(0, w - Width(text)));
		}

		/// <summary>表示幅で左に詰める</summary>
		private static string PadStartW(string text, int w)
		{
			return new string(' ', Math.Max(0, w - Width(text))) + text;
		}
	}
}

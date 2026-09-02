/*
 * CLI の定義。
 *
 * 出どころは src/client/options.mjs である。tools/20_build/export-options.mjs が
 * JSON に書き出し、ビルド時に埋め込む（csc の /resource:）。
 *
 * 手で写さない。2 か所に書くと必ずずれる。埋め込んだ JSON の schema が
 * 上がったら、こちらも合わせる。
 */
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace AiChat
{
	internal class OptionDef
	{
		public string Long;
		public string Short;   // 無ければ null
		public string Arg;     // 値の見出し。"" なら旗
		public string Cmd;     // そのコマンドだけのもの。null はどれにでも
		public string Desc;

		public bool IsFlag { get { return Arg == ""; } }

		/// <summary>--name と -x の両方を返す</summary>
		public IEnumerable<string> Flags()
		{
			yield return "--" + Long;
			if (!string.IsNullOrEmpty(Short)) yield return "-" + Short;
		}
	}

	internal class CommandDef
	{
		public string Name;
		public string Arg;
		public string Desc;
	}

	internal class RemovedDef
	{
		public string Name;
		public string Hint;
	}

	/// <summary>埋め込んだ JSON から読んだ定義</summary>
	internal static class Definition
	{
		/// <summary>この版が読める JSON の形。上がったら合わせる</summary>
		public const int ExpectedSchema = 1;

		public static string DefaultRoom { get; private set; }
		public static int DefaultPort { get; private set; }
		public static int MaxWaitSec { get; private set; }
		public static int DefaultWaitSec { get; private set; }
		public static int RetryIntervalSec { get; private set; }
		public static int ExitUnreachable { get; private set; }

		public static Dictionary<string, int> RetryTimes { get; private set; }
		public static List<KeyValuePair<string, int>> WaitUnits { get; private set; }
		public static List<OptionDef> Options { get; private set; }
		public static List<CommandDef> Commands { get; private set; }
		public static List<CommandDef> AdminCommands { get; private set; }
		public static List<RemovedDef> Removed { get; private set; }

		/// <summary>値を取らないオプション（旗）の一覧。--help や -h が入る</summary>
		public static HashSet<string> FlagNames { get; private set; }

		static Definition()
		{
			string json = ReadEmbedded("cli-options.json");
			var root = Json.ParseObject(json);

			int schema = Json.Int(root, "schema", 0);
			if (schema != ExpectedSchema)
			{
				throw new Exception(
					"埋め込んだ定義の形が違います（schema " + schema + " / 期待 " + ExpectedSchema + "）。" +
					"tools/20_build/build-aichat.cmd で作り直してください。");
			}

			DefaultRoom = Json.Str(root, "default_room", "public");
			DefaultPort = Json.Int(root, "default_port", 8787);
			MaxWaitSec = Json.Int(root, "max_wait_sec", 240);
			DefaultWaitSec = Json.Int(root, "default_wait_sec", 12 * 3600);
			RetryIntervalSec = Json.Int(root, "retry_interval_sec", 10);
			ExitUnreachable = Json.Int(root, "exit_unreachable", 3);

			RetryTimes = new Dictionary<string, int>();
			var retry = Json.Obj(root, "retry_times");
			if (retry != null)
			{
				foreach (var pair in retry) RetryTimes[pair.Key] = (int)Json.Num(retry, pair.Key, 0);
			}

			WaitUnits = new List<KeyValuePair<string, int>>();
			foreach (object item in Json.Arr(root, "wait_units"))
			{
				var u = item as Dictionary<string, object>;
				if (u == null) continue;
				WaitUnits.Add(new KeyValuePair<string, int>(Json.Str(u, "long"), Json.Int(u, "sec", 1)));
			}

			Options = new List<OptionDef>();
			FlagNames = new HashSet<string>();
			foreach (object item in Json.Arr(root, "options"))
			{
				var o = item as Dictionary<string, object>;
				if (o == null) continue;
				var def = new OptionDef
				{
					Long = Json.Str(o, "long"),
					Short = Json.Str(o, "short"),
					Arg = Json.Str(o, "arg", ""),
					Cmd = Json.Str(o, "cmd"),
					Desc = Json.Str(o, "desc", ""),
				};
				Options.Add(def);
				if (def.IsFlag) foreach (string flag in def.Flags()) FlagNames.Add(flag);
			}

			Commands = ReadCommands(root, "commands");
			AdminCommands = ReadCommands(root, "admin_commands");

			Removed = new List<RemovedDef>();
			foreach (object item in Json.Arr(root, "removed"))
			{
				var r = item as Dictionary<string, object>;
				if (r == null) continue;
				Removed.Add(new RemovedDef { Name = Json.Str(r, "name"), Hint = Json.Str(r, "hint", "") });
			}
		}

		private static List<CommandDef> ReadCommands(Dictionary<string, object> root, string key)
		{
			var list = new List<CommandDef>();
			foreach (object item in Json.Arr(root, key))
			{
				var c = item as Dictionary<string, object>;
				if (c == null) continue;
				list.Add(new CommandDef
				{
					Name = Json.Str(c, "name"),
					Arg = Json.Str(c, "arg", ""),
					Desc = Json.Str(c, "desc", ""),
				});
			}
			return list;
		}

		/// <summary>長い名前から短い名前を引く。定義に無ければ例外（書き間違いに気づくため）</summary>
		public static OptionDef Find(string longName)
		{
			foreach (OptionDef o in Options) if (o.Long == longName) return o;
			throw new Exception("定義に無いオプションです: " + longName);
		}

		/// <summary>そのコマンドが繋ぎ直す回数</summary>
		public static int RetryFor(string command)
		{
			int times;
			if (command != null && RetryTimes.TryGetValue(command, out times)) return times;
			return RetryTimes.ContainsKey("default") ? RetryTimes["default"] : 6;
		}

		private static string ReadEmbedded(string name)
		{
			Assembly asm = Assembly.GetExecutingAssembly();
			foreach (string resource in asm.GetManifestResourceNames())
			{
				if (!resource.EndsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
				using (Stream stream = asm.GetManifestResourceStream(resource))
				using (var reader = new StreamReader(stream))
				{
					return reader.ReadToEnd();
				}
			}
			throw new Exception(
				"定義が埋め込まれていません: " + name +
				"。tools/20_build/build-aichat.cmd でビルドしてください。");
		}
	}
}

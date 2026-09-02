/*
 * 小さな JSON の読み書き。
 *
 * .NET Framework には System.Text.Json が無い。DataContractJsonSerializer は
 * 型を先に決める必要があり、この CLI が扱う「決まりきっていない形」に合わない。
 * JavaScriptSerializer は System.Web.Extensions への参照が増える。
 *
 * 扱うのはサーバーが返す JSON だけで、形は単純である（オブジェクト・配列・
 * 文字列・数値・真偽・null）。自分で書けば依存が増えず、csc 単体で通る。
 *
 * 読んだ結果は Dictionary / List / string / double / bool / null になる。
 */
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AiChat
{
	/// <summary>JSON を読む。壊れていれば JsonException を投げる</summary>
	internal static class Json
	{
		public static object Parse(string text)
		{
			int i = 0;
			object value = ParseValue(text, ref i);
			SkipWhite(text, ref i);
			if (i < text.Length) throw new JsonException("末尾に余分な文字があります: 位置 " + i);
			return value;
		}

		/// <summary>オブジェクトとして読む。違う形なら例外</summary>
		public static Dictionary<string, object> ParseObject(string text)
		{
			var value = Parse(text) as Dictionary<string, object>;
			if (value == null) throw new JsonException("オブジェクトではありません");
			return value;
		}

		private static object ParseValue(string s, ref int i)
		{
			SkipWhite(s, ref i);
			if (i >= s.Length) throw new JsonException("値がありません");

			char c = s[i];
			switch (c)
			{
				case '{': return ParseObjectAt(s, ref i);
				case '[': return ParseArrayAt(s, ref i);
				case '"': return ParseString(s, ref i);
				case 't': Expect(s, ref i, "true"); return true;
				case 'f': Expect(s, ref i, "false"); return false;
				case 'n': Expect(s, ref i, "null"); return null;
				default: return ParseNumber(s, ref i);
			}
		}

		private static Dictionary<string, object> ParseObjectAt(string s, ref int i)
		{
			var result = new Dictionary<string, object>();
			i++; // {
			SkipWhite(s, ref i);
			if (i < s.Length && s[i] == '}') { i++; return result; }

			while (true)
			{
				SkipWhite(s, ref i);
				string key = ParseString(s, ref i);
				SkipWhite(s, ref i);
				if (i >= s.Length || s[i] != ':') throw new JsonException("キーの後に : がありません");
				i++;
				result[key] = ParseValue(s, ref i);
				SkipWhite(s, ref i);
				if (i >= s.Length) throw new JsonException("} が閉じていません");
				if (s[i] == ',') { i++; continue; }
				if (s[i] == '}') { i++; return result; }
				throw new JsonException("オブジェクトの区切りが読めません: 位置 " + i);
			}
		}

		private static List<object> ParseArrayAt(string s, ref int i)
		{
			var result = new List<object>();
			i++; // [
			SkipWhite(s, ref i);
			if (i < s.Length && s[i] == ']') { i++; return result; }

			while (true)
			{
				result.Add(ParseValue(s, ref i));
				SkipWhite(s, ref i);
				if (i >= s.Length) throw new JsonException("] が閉じていません");
				if (s[i] == ',') { i++; continue; }
				if (s[i] == ']') { i++; return result; }
				throw new JsonException("配列の区切りが読めません: 位置 " + i);
			}
		}

		private static string ParseString(string s, ref int i)
		{
			if (i >= s.Length || s[i] != '"') throw new JsonException("文字列ではありません: 位置 " + i);
			i++;
			var sb = new StringBuilder();

			while (i < s.Length)
			{
				char c = s[i++];
				if (c == '"') return sb.ToString();

				if (c != '\\') { sb.Append(c); continue; }

				if (i >= s.Length) throw new JsonException("エスケープが途切れています");
				char e = s[i++];
				switch (e)
				{
					case '"': sb.Append('"'); break;
					case '\\': sb.Append('\\'); break;
					case '/': sb.Append('/'); break;
					case 'b': sb.Append('\b'); break;
					case 'f': sb.Append('\f'); break;
					case 'n': sb.Append('\n'); break;
					case 'r': sb.Append('\r'); break;
					case 't': sb.Append('\t'); break;
					case 'u':
						if (i + 4 > s.Length) throw new JsonException("\\u が途切れています");
						sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
						i += 4;
						break;
					default: throw new JsonException("知らないエスケープです: \\" + e);
				}
			}
			throw new JsonException("文字列が閉じていません");
		}

		private static double ParseNumber(string s, ref int i)
		{
			int start = i;
			if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
			while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '-' || s[i] == '+')) i++;

			string raw = s.Substring(start, i - start);
			double value;
			if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
			{
				throw new JsonException("数として読めません: " + raw);
			}
			return value;
		}

		private static void Expect(string s, ref int i, string word)
		{
			if (i + word.Length > s.Length || s.Substring(i, word.Length) != word)
			{
				throw new JsonException(word + " のはずが違います: 位置 " + i);
			}
			i += word.Length;
		}

		private static void SkipWhite(string s, ref int i)
		{
			while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
		}

		// --- 書く側 ---

		/// <summary>文字列を JSON の文字列に直す。囲む " も付ける</summary>
		public static string Quote(string value)
		{
			if (value == null) return "null";
			var sb = new StringBuilder("\"");
			foreach (char c in value)
			{
				switch (c)
				{
					case '"': sb.Append("\\\""); break;
					case '\\': sb.Append("\\\\"); break;
					case '\b': sb.Append("\\b"); break;
					case '\f': sb.Append("\\f"); break;
					case '\n': sb.Append("\\n"); break;
					case '\r': sb.Append("\\r"); break;
					case '\t': sb.Append("\\t"); break;
					default:
						// 制御文字は \u にする。それ以外はそのまま（UTF-8 で送る）
						if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
						else sb.Append(c);
						break;
				}
			}
			return sb.Append('"').ToString();
		}

		// --- 読んだ結果から取り出す ---

		/// <summary>文字列として取る。無ければ fallback</summary>
		public static string Str(Dictionary<string, object> obj, string key, string fallback = null)
		{
			object value;
			if (obj == null || !obj.TryGetValue(key, out value) || value == null) return fallback;
			return value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture);
		}

		/// <summary>数として取る。無ければ fallback</summary>
		public static double Num(Dictionary<string, object> obj, string key, double fallback = 0)
		{
			object value;
			if (obj == null || !obj.TryGetValue(key, out value) || value == null) return fallback;
			if (value is double) return (double)value;
			double parsed;
			return double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture),
				NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
		}

		/// <summary>整数として取る。無ければ fallback</summary>
		public static int Int(Dictionary<string, object> obj, string key, int fallback = 0)
		{
			return (int)Num(obj, key, fallback);
		}

		/// <summary>真偽として取る。無ければ fallback</summary>
		public static bool Bool(Dictionary<string, object> obj, string key, bool fallback = false)
		{
			object value;
			if (obj == null || !obj.TryGetValue(key, out value) || value == null) return fallback;
			if (value is bool) return (bool)value;
			return fallback;
		}

		/// <summary>配列として取る。無ければ空</summary>
		public static List<object> Arr(Dictionary<string, object> obj, string key)
		{
			object value;
			if (obj == null || !obj.TryGetValue(key, out value) || value == null) return new List<object>();
			return value as List<object> ?? new List<object>();
		}

		/// <summary>オブジェクトとして取る。無ければ null</summary>
		public static Dictionary<string, object> Obj(Dictionary<string, object> obj, string key)
		{
			object value;
			if (obj == null || !obj.TryGetValue(key, out value)) return null;
			return value as Dictionary<string, object>;
		}

		/// <summary>その鍵が入っていて、値が null でないか</summary>
		public static bool Has(Dictionary<string, object> obj, string key)
		{
			object value;
			return obj != null && obj.TryGetValue(key, out value) && value != null;
		}
	}

	internal class JsonException : Exception
	{
		public JsonException(string message) : base(message) { }
	}
}

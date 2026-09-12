//! Windows の API を直に呼んで、走っているプロセスを数える。
//!
//! **外部クレートは要らない。**標準ライブラリだけで宣言を書ける。
//!
//! 【なぜ直に呼ぶか】
//! PowerShell を起こすと、その起動だけで 213 ms かかる。ここは 20 ms で済む。
//! `waiters` は待受けを張る前に毎回叩くので、その差がそのまま体感になる。
//!
//! 【取り方は 2 段】
//! `CreateToolhelp32Snapshot` は pid ・ 親 pid ・ 実行ファイル名までしか返さない。
//! **コマンドラインは PEB を読まないと取れない。**`NtQueryInformationProcess` で
//! PEB の番地を得て、`ReadProcessMemory` で辿る。
//!
//! 【非公開の仕組みに乗っている】
//! `NtQueryInformationProcess` と PEB の並びは、マイクロソフトが公開して
//! いない。**Windows の版が変わると位置がずれうる。**だから呼ぶ側は、
//! ここが失敗したときに別の手へ落ちられるようにしておく。

#![cfg(windows)]

use crate::jst;
use crate::waiters::Process;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
const PROCESS_VM_READ: u32 = 0x0010;
const INVALID_HANDLE: isize = -1;

/// 1601-01-01 から 1970-01-01 までの 100 ナノ秒の数
const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;

/// JST と UTC の差（ミリ秒）
const JST_OFFSET_MS: i64 = 9 * 60 * 60 * 1000;

#[repr(C)]
struct ProcessEntry32W {
	dw_size: u32,
	cnt_usage: u32,
	th32_process_id: u32,
	th32_default_heap_id: usize,
	th32_module_id: u32,
	cnt_threads: u32,
	th32_parent_process_id: u32,
	pc_pri_class_base: i32,
	dw_flags: u32,
	sz_exe_file: [u16; 260],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FileTime {
	low: u32,
	high: u32,
}

extern "system" {
	fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
	fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
	fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
	fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
	fn ReadProcessMemory(process: isize, address: usize, buffer: *mut u8, size: usize, read: *mut usize) -> i32;
	fn GetProcessTimes(process: isize, creation: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
	fn CloseHandle(handle: isize) -> i32;
}

#[link(name = "ntdll")]
extern "system" {
	fn NtQueryInformationProcess(process: isize, kind: u32, info: *mut u8, len: u32, written: *mut u32) -> i32;
}

/// `FILETIME` を JST の `yyyy-MM-dd HH:mm:ss` に直す。
///
/// 元期が 1601 年で単位が 100 ナノ秒。1970 年からのミリ秒に直してから
/// 9 時間足す。**書式は `Get-CimInstance` に揃える**（ハイフン区切り・ミリ秒なし）。
pub fn filetime_to_jst(low: u32, high: u32) -> String {
	let ticks = ((high as u64) << 32) | (low as u64);
	if ticks < FILETIME_EPOCH_DIFF {
		return String::new();
	}
	let utc_ms = ((ticks - FILETIME_EPOCH_DIFF) / 10_000) as i64;
	let text = jst::from_epoch_ms(utc_ms + JST_OFFSET_MS);

	// `yyyy/mm/dd HH:mm:ss.fff` → `yyyy-MM-dd HH:mm:ss`
	text.replace('/', "-").split('.').next().unwrap_or("").to_string()
}

/// UTF-16 の並びから、最初の NUL までを文字列にする
fn from_utf16(codes: &[u16]) -> String {
	let len = codes.iter().position(|c| *c == 0).unwrap_or(codes.len());
	String::from_utf16_lossy(&codes[..len])
}

/// 走っているプロセスを数える。取れなければ理由を返す。
///
/// **コマンドラインが読めないものは落とす。**待受けはコマンドラインで見分ける
/// ので、読めないものは判定しようがない。システムのプロセスがここに当たるが、
/// 待受けではないので困らない。
pub fn list_processes() -> Result<Vec<Process>, String> {
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE || snapshot == 0 {
		return Err("プロセスの一覧を開けませんでした".to_string());
	}

	// 途中で返る道があるので、必ず閉じる形にする
	let result = collect(snapshot);
	unsafe { CloseHandle(snapshot) };
	result
}

fn collect(snapshot: isize) -> Result<Vec<Process>, String> {
	// 構造体は 0 で埋めてから大きさだけ入れる。入れ忘れると 0 件が返る
	let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
	entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;

	let mut rows = Vec::new();
	let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };

	while ok != 0 {
		let pid = entry.th32_process_id;

		// 待受けを見分けるのはコマンドライン。読めないものは持たない
		if let Some(cmd) = command_line_of(pid) {
			rows.push(Process {
				pid: pid as i64,
				ppid: entry.th32_parent_process_id as i64,
				name: from_utf16(&entry.sz_exe_file),
				at: created_at_of(pid),
				cmd,
			});
		}

		entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
		ok = unsafe { Process32NextW(snapshot, &mut entry) };
	}
	Ok(rows)
}

/// そのプロセスを、読み取りだけできる形で開く
fn open_for_read(pid: u32) -> Option<isize> {
	let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
	if handle == 0 {
		None
	} else {
		Some(handle)
	}
}

/// 相手のメモリから指定の大きさを読む
fn read_memory(handle: isize, address: usize, size: usize) -> Option<Vec<u8>> {
	if address == 0 {
		return None;
	}
	let mut buffer = vec![0u8; size];
	let mut read = 0usize;
	let ok = unsafe { ReadProcessMemory(handle, address, buffer.as_mut_ptr(), size, &mut read) };
	if ok == 0 || read < size {
		None
	} else {
		Some(buffer)
	}
}

/// バイト列から 8 バイトの番地を読む
fn read_usize(bytes: &[u8], at: usize) -> usize {
	let mut value = [0u8; 8];
	value.copy_from_slice(&bytes[at..at + 8]);
	usize::from_le_bytes(value) as usize
}

/// 1 つのプロセスのコマンドラインを読む。読めなければ `None`
///
/// PEB → ProcessParameters → CommandLine と辿る。**位置は非公開の仕組みに
/// 乗っている**ので、読めなければ黙って諦める。
fn command_line_of(pid: u32) -> Option<String> {
	let handle = open_for_read(pid)?;
	let result = read_command_line(handle);
	unsafe { CloseHandle(handle) };
	result
}

fn read_command_line(handle: isize) -> Option<String> {
	// PROCESS_BASIC_INFORMATION は 48 バイト。PebBaseAddress は 8 番地
	let mut info = [0u8; 48];
	let mut written = 0u32;
	let status = unsafe { NtQueryInformationProcess(handle, 0, info.as_mut_ptr(), 48, &mut written) };
	if status != 0 {
		return None;
	}

	let peb = read_usize(&info, 8);

	// PEB の 0x20 に ProcessParameters
	let peb_bytes = read_memory(handle, peb, 0x30)?;
	let params = read_usize(&peb_bytes, 0x20);

	// RTL_USER_PROCESS_PARAMETERS の 0x70 に CommandLine（長さ 2 バイト ＋ 番地 8 バイト）
	let param_bytes = read_memory(handle, params, 0x80)?;
	let length = u16::from_le_bytes([param_bytes[0x70], param_bytes[0x71]]) as usize;
	let address = read_usize(&param_bytes, 0x78);
	if length == 0 || address == 0 {
		return None;
	}

	let raw = read_memory(handle, address, length)?;
	let codes: Vec<u16> = raw.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
	Some(String::from_utf16_lossy(&codes))
}

/// 立った時刻を JST で返す。取れなければ空
fn created_at_of(pid: u32) -> String {
	let handle = match open_for_read(pid) {
		Some(h) => h,
		None => return String::new(),
	};
	let mut creation = FileTime::default();
	let mut exit = FileTime::default();
	let mut kernel = FileTime::default();
	let mut user = FileTime::default();
	let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
	unsafe { CloseHandle(handle) };

	if ok == 0 {
		String::new()
	} else {
		filetime_to_jst(creation.low, creation.high)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn 構造体の大きさがWindowsの決まりと合う() {
		// 64 ビットでは 44 ＋ 520 を 8 バイト境界へ丸めて 568。
		// ここがずれると Process32FirstW が 0 件を返す（実際に踏んだ）
		assert_eq!(std::mem::size_of::<ProcessEntry32W>(), 568);
	}

	#[test]
	fn 元期の差を当てはめると1970年になる() {
		// FILETIME の 116444736000000000 はちょうど 1970-01-01T00:00:00Z
		let text = filetime_to_jst(
			(FILETIME_EPOCH_DIFF & 0xFFFF_FFFF) as u32,
			(FILETIME_EPOCH_DIFF >> 32) as u32,
		);
		assert_eq!(text, "1970-01-01 09:00:00", "JST なので 9 時");
	}

	#[test]
	fn 書式はハイフン区切りでミリ秒を持たない() {
		// Get-CimInstance が返す形に揃える。揃えないと並べ替えが食い違う
		let ticks = FILETIME_EPOCH_DIFF + 10_000 * 1000; // ＋1 秒
		let text = filetime_to_jst((ticks & 0xFFFF_FFFF) as u32, (ticks >> 32) as u32);
		assert_eq!(text, "1970-01-01 09:00:01");
		assert!(!text.contains('/'), "スラッシュが残っている");
		assert!(!text.contains('.'), "ミリ秒が残っている");
	}

	#[test]
	fn 元期より前は空にする() {
		// 1601 年より前は表せない。空にして、並べ替えで先頭に来るようにする
		assert_eq!(filetime_to_jst(0, 0), "");
	}

	#[test]
	fn UTF16の並びをNULで切る() {
		let codes = [0x41u16, 0x42, 0x00, 0x43];
		assert_eq!(from_utf16(&codes), "AB");
		assert_eq!(from_utf16(&[]), "");
		assert_eq!(from_utf16(&[0x3042, 0]), "あ");
	}

	#[test]
	fn 自分自身のコマンドラインを読める() {
		// 自分が起こしたプロセスは必ず読める。ここが通らなければ FFI が効いていない
		let pid = std::process::id();
		let cmd = command_line_of(pid).expect("自分のコマンドラインが読めない");
		assert!(!cmd.is_empty());
	}

	#[test]
	fn 自分自身の立った時刻を読める() {
		let at = created_at_of(std::process::id());
		assert_eq!(at.len(), 19, "yyyy-MM-dd HH:mm:ss は 19 文字: {}", at);
	}

	#[test]
	fn 一覧に自分が含まれる() {
		let rows = list_processes().expect("一覧を取れない");
		assert!(rows.len() > 10, "プロセスが少なすぎる: {}", rows.len());

		let me = rows.iter().find(|p| p.pid == std::process::id() as i64);
		let me = me.expect("自分が一覧に居ない");
		assert!(!me.name.is_empty(), "名前が空");
		assert!(!me.cmd.is_empty(), "コマンドラインが空");
		assert_eq!(me.at.len(), 19, "立った時刻の書式: {}", me.at);
	}
}

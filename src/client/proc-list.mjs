/*
 * 走っているプロセスの一覧を取る。
 *
 * 【なぜ分けたか】
 * 取り方は 3 通りあり、どれが使えるかは走らせている処理系と OS で変わる。
 * chat.mjs に混ぜると、待受けを選ぶ規則と取り方が同じ場所に並んでしまう。
 *
 * 【Windows では 2 段】
 *   1. Windows の API を直に呼ぶ（bun は bun:ffi、node は koffi。18〜24 ms）
 *   2. PowerShell を起こす（523 ms）
 *
 * **1 は非公開の仕組みに乗っている。**PEB（プロセスの内部構造）の並びは
 * マイクロソフトが公開しておらず、Windows の版が変わると位置がずれうる。
 * ずれたら黙って次の段へ落ちる。waiters は「止めてよい待受けを名指しする」
 * 道具なので、**誤って数えるより遅いほうがよい。**
 *
 * Mac ・ Linux では ps を使う（PowerShell が無い）。
 */
import { spawnSync } from 'node:child_process';

const TH32CS_SNAPPROCESS = 0x02;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

/** PROCESSENTRY32W の大きさ。44 ＋ 520 を 8 バイト境界へ丸めた値 */
const ENTRY_SIZE = 568;

/** 1601-01-01 から 1970-01-01 までの 100 ナノ秒の数 */
const FILETIME_EPOCH_DIFF = 116444736000000000n;

/** いま走っているのが bun か */
const isBun = typeof globalThis.Bun !== 'undefined';

/**
 * FILETIME を JST の `yyyy-MM-dd HH:mm:ss` に直す。
 *
 * **書式は Get-CimInstance に揃える**（ハイフン区切り・ミリ秒なし）。
 * 揃えないと、PowerShell へ落ちたときに並べ替えが食い違う。
 */
export function filetimeToJst(ticks) {
	if (ticks < FILETIME_EPOCH_DIFF) return '';
	const utcMs = Number((ticks - FILETIME_EPOCH_DIFF) / 10000n);
	const jst = new Date(utcMs + 9 * 60 * 60 * 1000);

	const p = (n, w = 2) => String(n).padStart(w, '0');
	return (
		`${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ` +
		`${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`
	);
}

/** bun:ffi で一覧を取る。使えなければ null */
async function listByBunFfi() {
	if (!isBun) return null;

	let dlopen, FFIType, ptr;
	try {
		/*
		 * 名前を組み立ててから渡す。
		 *
		 * bun:ffi は bun にしかないので、node の型定義には無い。直に書くと
		 * tsc が「そんなモジュールは無い」と言う（検査は node の型で走る）。
		 * **実行時に解ければよい**ものなので、検査の目から外す。
		 */
		const mod = 'bun' + ':ffi';
		({ dlopen, FFIType, ptr } = await import(mod));
	} catch {
		return null;
	}

	try {
		const k32 = dlopen('kernel32.dll', {
			CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
			Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			ReadProcessMemory: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
				returns: FFIType.i32,
			},
			GetProcessTimes: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		});
		const ntdll = dlopen('ntdll.dll', {
			NtQueryInformationProcess: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
		});

		const read = (handle, address, size) => {
			const out = new ArrayBuffer(size);
			const got = new ArrayBuffer(8);
			const ok = k32.symbols.ReadProcessMemory(handle, address, ptr(out), BigInt(size), ptr(got));
			return ok ? new DataView(out) : null;
		};

		const openRead = (pid) => k32.symbols.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);

		const commandLineOf = (pid) => {
			const handle = openRead(pid);
			if (!handle) return null;
			try {
				const pbi = new ArrayBuffer(48);
				const len = new ArrayBuffer(4);
				if (ntdll.symbols.NtQueryInformationProcess(handle, 0, ptr(pbi), 48, ptr(len)) !== 0) return null;
				const peb = new DataView(pbi).getBigUint64(8, true);
				if (peb === 0n) return null;
				const pebView = read(handle, Number(peb), 0x30);
				if (!pebView) return null;
				const params = pebView.getBigUint64(0x20, true);
				const pv = read(handle, Number(params), 0x80);
				if (!pv) return null;
				const cmdLen = pv.getUint16(0x70, true);
				const cmdPtr = pv.getBigUint64(0x78, true);
				if (cmdLen === 0 || cmdPtr === 0n) return null;
				const cv = read(handle, Number(cmdPtr), cmdLen);
				if (!cv) return null;
				let text = '';
				for (let i = 0; i < cmdLen; i += 2) text += String.fromCharCode(cv.getUint16(i, true));
				return text;
			} finally {
				k32.symbols.CloseHandle(handle);
			}
		};

		const createdAtOf = (pid) => {
			const handle = openRead(pid);
			if (!handle) return '';
			try {
				const times = new ArrayBuffer(32);
				const ok = k32.symbols.GetProcessTimes(
					handle,
					ptr(times),
					ptr(times, 8),
					ptr(times, 16),
					ptr(times, 24)
				);
				if (!ok) return '';
				return filetimeToJst(new DataView(times).getBigUint64(0, true));
			} finally {
				k32.symbols.CloseHandle(handle);
			}
		};

		const snap = k32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		if (!snap) return null;

		const buf = new ArrayBuffer(ENTRY_SIZE);
		const view = new DataView(buf);
		view.setUint32(0, ENTRY_SIZE, true);

		const rows = [];
		let ok = k32.symbols.Process32FirstW(snap, ptr(buf));
		while (ok) {
			const pid = view.getUint32(8, true);
			const cmd = commandLineOf(pid);
			if (cmd) {
				let name = '';
				for (let i = 44; i < ENTRY_SIZE; i += 2) {
					const c = view.getUint16(i, true);
					if (c === 0) break;
					name += String.fromCharCode(c);
				}
				rows.push({ pid, ppid: view.getUint32(32, true), name, cmd, at: createdAtOf(pid) });
			}
			view.setUint32(0, ENTRY_SIZE, true);
			ok = k32.symbols.Process32NextW(snap, ptr(buf));
		}
		k32.symbols.CloseHandle(snap);
		return rows.length > 0 ? rows : null;
	} catch {
		return null;
	}
}

/** koffi で一覧を取る（node 用）。使えなければ null */
async function listByKoffi() {
	if (isBun) return null;

	let koffi;
	try {
		({ default: koffi } = await import('koffi'));
	} catch {
		return null;
	}

	try {
		const k32 = koffi.load('kernel32.dll');
		const ntdll = koffi.load('ntdll.dll');

		const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
			dwSize: 'uint32',
			cntUsage: 'uint32',
			th32ProcessID: 'uint32',
			th32DefaultHeapID: 'uintptr',
			th32ModuleID: 'uint32',
			cntThreads: 'uint32',
			th32ParentProcessID: 'uint32',
			pcPriClassBase: 'int32',
			dwFlags: 'uint32',
			szExeFile: koffi.array('uint16', 260),
		});

		const CreateToolhelp32Snapshot = k32.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)');
		const Process32FirstW = k32.func('int Process32FirstW(void *snap, _Inout_ PROCESSENTRY32W *entry)');
		const Process32NextW = k32.func('int Process32NextW(void *snap, _Inout_ PROCESSENTRY32W *entry)');
		const OpenProcess = k32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)');
		const ReadProcessMemory = k32.func(
			'int ReadProcessMemory(void *proc, void *addr, _Out_ void *buf, size_t size, _Out_ size_t *read)'
		);
		const GetProcessTimes = k32.func(
			'int GetProcessTimes(void *proc, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)'
		);
		const CloseHandle = k32.func('int CloseHandle(void *handle)');
		const NtQueryInformationProcess = ntdll.func(
			'int NtQueryInformationProcess(void *proc, uint32 kind, _Out_ void *info, uint32 len, _Out_ uint32 *out)'
		);

		const openRead = (pid) => OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);

		const read = (handle, address, size) => {
			const buf = Buffer.alloc(size);
			const got = [0n];
			return ReadProcessMemory(handle, koffi.as(address, 'void *'), buf, size, got) ? buf : null;
		};

		const commandLineOf = (pid) => {
			const handle = openRead(pid);
			if (!handle) return null;
			try {
				const pbi = Buffer.alloc(48);
				const outLen = [0];
				if (NtQueryInformationProcess(handle, 0, pbi, 48, outLen) !== 0) return null;
				const peb = pbi.readBigUInt64LE(8);
				if (peb === 0n) return null;
				const pebBuf = read(handle, peb, 0x30);
				if (!pebBuf) return null;
				const params = pebBuf.readBigUInt64LE(0x20);
				const pv = read(handle, params, 0x80);
				if (!pv) return null;
				const cmdLen = pv.readUInt16LE(0x70);
				const cmdPtr = pv.readBigUInt64LE(0x78);
				if (cmdLen === 0 || cmdPtr === 0n) return null;
				const cv = read(handle, cmdPtr, cmdLen);
				return cv ? cv.toString('utf16le') : null;
			} finally {
				CloseHandle(handle);
			}
		};

		const createdAtOf = (pid) => {
			const handle = openRead(pid);
			if (!handle) return '';
			try {
				const creation = Buffer.alloc(8);
				const other = Buffer.alloc(8);
				if (!GetProcessTimes(handle, creation, other, other, other)) return '';
				return filetimeToJst(creation.readBigUInt64LE(0));
			} finally {
				CloseHandle(handle);
			}
		};

		const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		if (!snap) return null;

		const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
		const rows = [];
		let ok = Process32FirstW(snap, entry);
		while (ok) {
			const pid = entry.th32ProcessID;
			const cmd = commandLineOf(pid);
			if (cmd) {
				let name = '';
				for (const c of entry.szExeFile) {
					if (c === 0) break;
					name += String.fromCharCode(c);
				}
				rows.push({ pid, ppid: entry.th32ParentProcessID, name, cmd, at: createdAtOf(pid) });
			}
			entry.dwSize = koffi.sizeof(PROCESSENTRY32W);
			ok = Process32NextW(snap, entry);
		}
		CloseHandle(snap);
		return rows.length > 0 ? rows : null;
	} catch {
		return null;
	}
}

/**
 * PowerShell で一覧を取る。**最後の砦**。
 *
 * 絞り込みは呼ぶ側で行う。PowerShell に渡す式に ID を入れないので、
 * 子プロセス自身が数に混ざらない。
 */
export function listByPowerShell() {
	/*
	 * 式そのものに wait という並びを置かない。
	 *
	 * 置くと、この PowerShell 自身のコマンドラインが条件に当たり、数えている
	 * プロセスが数に入る。2 つに割って繋げば、子のコマンドラインには
	 * ('* wa' + 'it *') としか残らない。
	 *
	 * 前後に空白を要求するのは waiters に当てないため。wait の直後が e なので
	 * ' wait ' には当たらない。
	 */
	const script =
		'Get-CimInstance Win32_Process | ' +
		"Where-Object { $_.CommandLine -and $_.CommandLine -like ('* wa' + 'it *') } | " +
		'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; ' +
		"cmd = $_.CommandLine; at = $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') } } | " +
		'ConvertTo-Json -Compress -Depth 3';

	const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});
	if (run.status !== 0) {
		throw new Error((run.stderr ?? '').trim() || 'powershell.exe が動きませんでした');
	}

	const text = (run.stdout ?? '').trim();
	if (!text) return [];

	// 1 件のときオブジェクト、複数のとき配列で返る
	const parsed = JSON.parse(text);
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** ps で一覧を取る（Mac ・ Linux） */
export function listByPs() {
	const run = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,comm=,args='], { encoding: 'utf8' });
	if (run.status !== 0) throw new Error('ps が動きませんでした');

	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const rows = [];
	for (const line of (run.stdout ?? '').split('\n')) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 8) continue;
		const [pid, ppid, , mon, day, time, year, name, ...rest] = parts;
		// 並べ替えに使うので、文字列のまま時系列になる形へ直す
		const month = String(months.indexOf(mon) + 1).padStart(2, '0');
		const at = `${year}-${month}-${String(day).padStart(2, '0')} ${time}`;
		const cmd = rest.join(' ');
		if (cmd.includes('wait')) rows.push({ pid: Number(pid), ppid: Number(ppid), name, cmd, at });
	}
	return rows;
}

/**
 * 一覧を取る。使える手のうち、いちばん速いものから試す。
 *
 * @returns {Promise<{pid:number, ppid:number, name:string, cmd:string, at:string}[]>}
 */
export async function listProcesses() {
	if (process.platform !== 'win32') return listByPs();

	// 1. API を直に呼ぶ
	const direct = (await listByBunFfi()) ?? (await listByKoffi());
	if (direct) return direct;

	// 2. PowerShell
	return listByPowerShell();
}

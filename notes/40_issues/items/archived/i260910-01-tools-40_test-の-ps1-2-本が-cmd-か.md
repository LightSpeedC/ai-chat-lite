---
schema: 1
id: i260910-01
title: tools/40_test の ps1 2 本が、cmd から起動できない
group: 開発環境・記録
created: 2026-09-10
---

`run-ui-tests.ps1` と `measure-cli-startup.ps1` の 1 行目に `#Requires -Version 7` が残っていた。どちらも同名の cmd が `powershell.exe`(5.1)で呼ぶ作りなので、**ダブルクリックでは起動時点で `ScriptRequiresUnmatchedPSVersion` になり、一度も動かない**。共通ルールの「ps1 は 5.1 で動くように書く」にも当たる ([i260908-05](#i260908-05) で `build-aichat.cmd` について直したのと同じ形)。

> [!IMPORTANT]
> **2 本で事情が違った。**`run-ui-tests.ps1` は pwsh 7 固有の機能を使っておらず、外すだけで済んだ。`measure-cli-startup.ps1` は**外すと壊れた**ので、`#Requires` には意味があった。

`measure-cli-startup.ps1` は「素の起動」を `node -e ''` で測っていた。**Windows PowerShell 5.1 はネイティブコマンドへ空の引数を渡せない**(pwsh 7 の `PSNativeCommandArgumentPassing` で直った挙動)ため、`node -e` だけが渡って `-e requires an argument` で即座に落ちる。**エラー終了までの時間を「Node 自体の起動」として測っていた**(21.5 ms。直すと 41.1 ms になり、module の読み込み時間の見積もりも 49.0 ms → 16.1 ms へ変わった)。

- [済] `run-ui-tests.ps1` から `#Requires -Version 7` を外した。**5.1 で全 75 件 (74 成功・1 skip)が完走することを実測**
- [済] `measure-cli-startup.ps1` は空文字列を渡さない形 (`node -e '0'`)に直してから `#Requires` を外した。**5.1 ・ pwsh 7 の両方で正しく測れることを実測**。`0` は評価しても何も起きない式なので、測る中身は変わらない
- [済] 残る ps1 4 本 (`log.ps1` ・ `register-backup-tasks.ps1` ・ `backup.ps1` ・ `migrate-backup-layout.ps1`)は `#Requires -Version 5.1` で、問題なし。`restore.ps1` も同じ

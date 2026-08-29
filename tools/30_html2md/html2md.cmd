@echo off
rem HTML から Markdown を生成する。変換の本体は N:\2026\html2md\html2md.exe。
rem
rem --dir .      root 直下も探索する（README.html だけでなく USAGE-FOR-PROJECTS.html も対象にするため）
rem --no-readme  README.html を二重に拾わないようにする（--dir . 側で拾える）
rem
rem 引数はそのまま渡せる。例: html2md.cmd --dry-run

"N:\2026\html2md\html2md.exe" --root "%~dp0..\.." --dir . --no-readme %*

rem 課題一覧は details/summary の開閉が本質で、Markdown にすると
rem グループ名も課題タイトルも落ちてしまう。生成されたものは残さない。
rem （html2md に個別ファイルを除外する機能が無いため、消して対処している）
if exist "%~dp0..\..\notes\40_issues\issues.md" del "%~dp0..\..\notes\40_issues\issues.md"

pause
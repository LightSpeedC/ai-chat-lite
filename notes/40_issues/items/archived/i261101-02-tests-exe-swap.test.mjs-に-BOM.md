---
schema: 1
id: i261101-02
title: tests/exe-swap.test.mjs に BOM が付いていた
group: 開発環境・記録
created: 2026-11-01
---

[品質レビュー (2026-10-31)](../../../80_quality_review/q261031-01-品質レビュー.md) の 4 章の指摘。先頭の 3 バイトが `EF BB BF` だった (2026-11-01 実測)。`.editorconfig` は mjs を BOM 無しとする。

- [済] `convert-encoding --to utf8` で外した。先頭は `/*` (2026-11-01)

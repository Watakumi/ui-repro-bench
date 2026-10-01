# ターゲット

直下にあるものが**計測対象**。サブディレクトリは対象外。

| | 中身 |
| --- | --- |
| `targets/<slug>/` | 計測対象。`pnpm trial targets/<slug>` で回す |
| `targets/_archived/` | 廃止したターゲット。過去の run の再計算のために残す |
| `targets/_fixtures/` | 仕組みの検証用。雛形と自己検証用 |
| `_excluded/`（リポジトリ直下） | 既知性などで意図的に外したもの |

## 廃止の理由

- `newspicks-article-full` — 参照6枚が状態変化を跨いでおり、**満たせる実装が存在しない出題**だった
- `newspicks-article-top` — 1ビューポートのみ。ライブラリ蓄積後は9/9が1ターンで飽和

## 追加

```sh
pnpm target:add <slug> <url> [--dark] [--scroll 0,900,1800]
```

`radix.expected` は空で作られる。要素の棚卸しが別途必要。

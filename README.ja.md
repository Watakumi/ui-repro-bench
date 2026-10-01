# ui-bench

> 日本語版です。英語は [README.md](README.md) にあります。

参照スクリーンショットから UI を再現させ、**できたかどうかを機械で判定する**ベンチマーク。

スクショから UI を作らせるツールは多いが、合否を人が目で決めている。
ここでは判定を5段のゲートに落とし、通らなければ差分を添えてもう一度指示する。
必要だったプロンプト数・費用・品質を記録する。

```
参照スクショ ──▶ brain（差分を読んで指示を出す）
                   │
                   ├─▶ builder（sandbox/src/App.tsx を書く）
                   │
                撮影 ──▶ 5段のゲート ──▶ 通れば収束 / 落ちたらもう1ターン
```

## 判定

| ゲート | 見るもの | 捨てているもの |
| --- | --- | --- |
| ピクセル `layoutDiff` | グレースケール化＋ぼかしの差分 | 字形の差。**色相も捨てる** |
| ピクセル `rawDiff` | 素の差分 | なし（色相の誤りはここだけが拾う） |
| フロー | DOM。内部スクロール容器・ヘッダーの重複・見出しの重複 | — |
| 構造 | 絶対配置の比率 | — |
| 部品 | 期待した Radix primitive を使っているか | — |
| 審査 | LLM が参照と実装を見比べる | — |

ゲートが増えたのは、**1つ前のゲートを満点でくぐり抜ける実装が実際に出たから**。
その経緯は [`harness/knowledge/FAILURES.md`](harness/knowledge/FAILURES.md) に全部ある。

## 使う

```sh
pnpm install
pnpm exec playwright install chromium

# 参照を撮る（第三者サイトのスクショは同梱していないので、各自で撮る）
pnpm target:add my-target https://example.com
pnpm target:add my-target https://example.com --scroll 0,820,1640,2460   # 長いページを断片で
pnpm capture:states my-target                                           # 状態つき（要 states.json）

# どの要素をどの primitive で作れるかを棚卸しする
pnpm extract targets/my-target --write

# 回す
pnpm trial targets/my-target
UI_BENCH_KNOWLEDGE=none pnpm trial targets/my-target   # 蓄積知見なしで

# 見る
pnpm report      # 条件ごとの集計
pnpm gallery     # 参照と成果物を並べた HTML
```

### 条件を指定する環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `UI_BENCH_KNOWLEDGE` | `general` | `none` 蓄積なし / `general` 汎用のみ / `full` 汎用＋そのターゲットの固有 |
| `UI_BENCH_VARIANT` | `A` | `A` 段階分けなし / `B` 構造抽出→骨格→精緻化 |
| `UI_BENCH_MODEL` | `opus` | モデル。解決後のIDが `summary.json` に残る |
| `UI_BENCH_NO_PROBE` | — | `1` で計測道具を渡さない（アブレーション） |
| `UI_BENCH_NO_RADIX` | — | `1` で Radix の指定とゲートを外す |
| `UI_BENCH_NO_ISOLATION` | — | `1` で隔離しない |
| `UI_BENCH_LAYOUT_THRESHOLD` | target.json | `layoutDiff` の閾値を上書き |

## 測定を信じるための仕掛け

このリポジトリで一番時間を使ったのは生成ではなく、**計測が嘘をつかないようにすること**。

- **`pnpm selftest <target> <既知の正解>`** — エージェントを動かさずにハーネス自身を検査する。
  試行本体が読み込めるか、振り返りが溜まっていないか、汎用知見にターゲット名が混ざっていないかも見る
- **隔離** — 試行のあいだ、知見の原本・他ターゲット・抽出結果・過去の成果物をリポジトリの外へ退避する。
  「条件を揃えた」の証明は、消したことではなく**届かないこと**。異常終了時は `pnpm isolate:restore`
- **`pnpm audit:gates`** — どのゲートが実際に何回落としたかを数える。
  数えたら、絶対配置のゲートは312ターンで**発火0回**だった（保険として残している）
- **`pnpm judge:repeat <runId>`** — 同じ成果物を何度も採点させて LLM 審査のぶれを測る。
  実測で平均点が 0.8 ぶれるので、**スコアで条件を比較しない**
- **`pnpm reflect --pending`** — 試行から知見を抽出する。未反映が溜まると selftest が落ちる
- **`pnpm trace`** — 1ターンの内側の往復回数をログから数える。外側のターン数では見えない差が出る

## 知見は汎用と固有を分ける

| | 中身 |
| --- | --- |
| [`harness/knowledge/GENERAL.md`](harness/knowledge/GENERAL.md) | 別のターゲットでも成り立つ手順・技法・失敗の型。**サービス名を書かない**（selftest が検査する） |
| `harness/knowledge/targets/<slug>.md` | その画面の実測値・座標・断片ごとの違い |

混ぜていたときは「知見でターン数が減る」という結論が出たが、
**抽出元のターゲットでしか再現しなかった**。分けて初めて移植性を測れる。

## 分かったこと

- **モデルで結論が変わる**。同条件で Opus 5.5 は1ターン $2、Sonnet 5 は11〜12ターン $89〜165 で未収束
- 蓄積知見は**1ターン目の精度**を上げる（誤差が約半分）。
  手順だけでは届かない画面ではターン削減になり、届く画面では品質の上積みになる
- **無駄になったターンの大半は、エージェントではなく計測側の欠陥だった**（Goodhart 5件に対しハーネス欠陥 30件）

## 参照スクリーンショットを同梱していない理由

第三者の UI は、権利の扱いが1つ1つ違う。`target.json`（撮影条件・閾値・期待 primitive）だけを置き、
画像は `pnpm target:add` で各自が撮り直す構成にしてある。

## 構成

```
harness/        計測と試行のループ
  knowledge/    知見（汎用／ターゲット別）と失敗カタログ
targets/        ターゲットの仕様（画像は gitignore）
sandbox/        実装先。React 19 + Tailwind v4 + Radix UI
packages/ui/    試行をまたいで残す部品ライブラリ
docs/           判断の記録
articles/       書きかけの記事
```

## ライセンス

MIT。ただし `targets/` で参照する第三者サイトの UI 自体は各サイトの権利に従う。

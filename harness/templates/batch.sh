#!/bin/bash
# 試行バッチの雛形。/tmp にコピーして run 行を書き換えて使う。
#
# 最後の reflect は消さないこと。知見の更新は「忘れないようにする」では回らず、
# 4日・30試行ぶん放置した（未反映が溜まると selftest が落ちる仕組みも入れてある）。
# このファイルの2つ上がリポジトリ直下
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SNAP=packages/ui/.snapshots/cold-empty
LOG=runs/_logs; mkdir -p $LOG

# 条件を揃えるため、試行の前にハーネスを確かめる（試行本体が読めるか・振り返りが溜まっていないか）
# ハーネス自身の検査。既知の正解（過去の収束した run の App.final.tsx）を渡す
GOLDEN_TARGET=${GOLDEN_TARGET:-targets/antd-pro-analysis}
GOLDEN_APP=${GOLDEN_APP:-$(ls -d runs/*/App.final.tsx 2>/dev/null | tail -1)}
if [ -n "$GOLDEN_APP" ]; then
  pnpm selftest "$GOLDEN_TARGET" "$GOLDEN_APP" || exit 1
else
  echo "既知の正解がまだありません。selftest を飛ばします"
fi

run() {
  find packages/ui/src -name "*.tsx" -delete; cp "$SNAP/index.ts" packages/ui/src/index.ts
  echo "=========== $1 知見=$2 ($3) ==========="
  UI_BENCH_KNOWLEDGE=$2 UI_BENCH_VARIANT=A pnpm trial targets/$1 2>&1 \
    | tee "$LOG/$(date +%Y%m%dT%H%M%S)_$1_$2.log" \
    | grep -E "── ターン|layoutMad|絶対配置|未使用|期待した|通過|⚠ 1本|^収束|^未収束|累計|✖"
}

# --- ここを書き換える ---
run newspicks-article-reading cold 1
# ------------------------

echo "=========== 振り返り ==========="
pnpm reflect --pending
echo "=========== 完了 ==========="

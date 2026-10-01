import path from 'node:path'
import { ROOT } from './config.ts'
import { pct, score } from './score.ts'

/**
 * 任意の2枚を採点する。閾値の妥当性を確かめたり、
 * 「何も作っていない状態」の下限を測ったりするのに使う。
 *
 *   pnpm score <参照> <実装> [出力先ディレクトリ]
 */
async function main(): Promise<void> {
  const [ref, cand, outDir = path.dirname(path.resolve(ROOT, process.argv[3] ?? '.'))] =
    process.argv.slice(2)
  if (!ref || !cand) {
    console.error('使い方: pnpm score <参照画像> <実装画像> [差分画像の出力先]')
    process.exit(1)
  }
  const base = path.basename(cand).replace(/\.[^.]+$/, '')
  const s = await score({
    referencePath: path.resolve(ROOT, ref),
    candidatePath: path.resolve(ROOT, cand),
    rawDiffPath: path.join(outDir, `${base}.raw-diff.png`),
    layoutDiffPath: path.join(outDir, `${base}.layout-diff.png`),
  })
  console.log(`  rawDiff     ${pct(s.rawDiff)}`)
  console.log(`  layoutDiff  ${pct(s.layoutDiff)}`)
  console.log(`  layoutMad   ${(s.layoutMad * 100).toFixed(4)}%  (飽和しない連続量)`)
  console.log(`  heightRatio ${s.heightRatio.toFixed(3)}`)
  console.log(`  比較領域    ${s.width}x${s.height}`)
}

await main()

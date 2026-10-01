import path from 'node:path'
import type { Browser } from 'playwright'
import { captureResilient } from './capture.ts'
import type { Action, TargetSpec } from './config.ts'
import sharp from 'sharp'
import { score, type Score } from './score.ts'

/**
 * 縦に連なった参照群を、1枚のページとして突き合わせる。
 *
 * 参照は同じページをスクロールしながら撮ったビューポート断片なので、
 * 事前にスクロール量が分からない。実装をフルページで撮り、各断片が
 * 最もよく一致する位置を探索する。
 *
 * 位置が参照の順番どおりに並んでいれば、ページとして正しく繋がっている。
 * 順番が入れ替わっていたら、セクションの順序を間違えている。
 *
 * 採点は二段構え。
 *   1. フルページ撮影で各断片の「だいたいの位置」を探す
 *   2. その位置までスクロールして、参照と同じくビューポート撮影し直して採点する
 *
 * 1だけで採点すると sticky 要素が合わない。参照は実際にスクロールして
 * 撮られているので sticky ヘッダーがどの断片にも写るが、フルページ撮影では
 * 本来の位置に1回しか描画されない。実測では断片02〜06 が
 * 上端100px（ヘッダー高）のぶんだけ永久に不一致になり、5.3%の床を作っていた。
 */

export interface SliceMatch {
  name: string
  /** 実装フルページ上で最も一致した縦位置（デバイスpx） */
  offset: number
  score: Score
}

export interface SliceResult {
  matches: SliceMatch[]
  /** 一致位置が参照の順番どおりに単調増加しているか */
  ordered: boolean
  orderViolations: string[]
  /** 実装フルページの高さ ÷ 参照から推定されるページの高さ */
  heightRatio: number
  worst: SliceMatch
}

/**
 * 全断片の上端で一致している高さ＝sticky で固定されている領域。
 *
 * 参照はスクロールして撮られているので、sticky ヘッダーはどの断片の上端にも
 * 同じ姿で写る。一方フルページ撮影ではヘッダーは先頭に1回しかない。
 * この帯を含めたまま照合すると、断片は必ずページ先頭で最もよく一致してしまい、
 * 全断片が位置0に張り付く（実測）。照合からこの帯を除く。
 */
async function stickyTopHeight(
  slices: { file: string }[],
  width: number,
  pageWidth: number,
): Promise<number> {
  if (slices.length < 2) return 0
  const grays = await Promise.all(slices.map((s) => gray(s.file, width)))
  const w = grays[0]!.width
  const maxRows = Math.min(...grays.map((g) => g.height))

  let row = 0
  for (; row < maxRows; row++) {
    let same = true
    for (let i = 1; i < grays.length && same; i++) {
      let diff = 0
      for (let x = 0; x < w; x += 2) {
        diff += Math.abs(grays[0]!.pixels[row * w + x]! - grays[i]!.pixels[row * w + x]!)
      }
      // 平均の明度差が小さければ「同じ行」とみなす
      if (diff / Math.ceil(w / 2) > 6) same = false
    }
    if (!same) break
  }
  // 縮小前のピクセルに戻す
  return Math.round((row * pageWidth) / w)
}

/** グレースケールの生画素。探索用に縮小して使う。 */
async function gray(file: string, width: number) {
  const { data, info } = await sharp(file)
    .resize({ width })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = new Uint8Array(info.width * info.height)
  for (let i = 0, o = 0; o < out.length; i += info.channels, o++) out[o] = data[i]!
  return { pixels: out, width: info.width, height: info.height }
}

function madAt(
  page: { pixels: Uint8Array; width: number; height: number },
  slice: { pixels: Uint8Array; width: number; height: number },
  offset: number,
  stride: number,
  skipTop = 0,
): number {
  let sum = 0
  let n = 0
  for (let y = skipTop; y < slice.height; y += stride) {
    const py = offset + y
    if (py < 0 || py >= page.height) return Number.POSITIVE_INFINITY
    for (let x = 0; x < slice.width; x += stride) {
      sum += Math.abs(slice.pixels[y * slice.width + x]! - page.pixels[py * page.width + x]!)
      n++
    }
  }
  return n === 0 ? Number.POSITIVE_INFINITY : sum / n
}

/**
 * 各断片の最適な縦位置を探す。
 * 縮小画像で粗く探し、中解像度で詰める（元解像度の総当たりは重すぎる）。
 */
export interface MatchOptions {
  fullPagePath: string
  slices: { name: string; file: string }[]
  diffDir: string
  /** 参照と同じ条件で撮り直すための情報。省略するとフルページの切り出しで採点する */
  rescan?: {
    url: string
    spec: TargetSpec
    browser: Browser
  }
  /** 撮影前に一度だけ行う操作（状態に入るため） */
  enterActions?: Action[]
}

export async function matchSlices(opts: MatchOptions): Promise<SliceResult & { browser?: Browser }> {
  const { fullPagePath, slices, diffDir, rescan, enterActions = [] } = opts
  const pageMeta = await sharp(fullPagePath).metadata()
  const pageWidth = pageMeta.width!
  const pageHeight = pageMeta.height!

  const COARSE = 240
  const FINE = 480
  const coarsePage = await gray(fullPagePath, COARSE)
  const finePage = await gray(fullPagePath, FINE)
  const coarseScale = coarsePage.width / pageWidth
  const fineScale = finePage.width / pageWidth

  let currentBrowser = rescan?.browser
  // sticky 帯を照合から除く。これを含めると全断片がページ先頭に張り付く。
  const stickyTop = await stickyTopHeight(slices, COARSE, pageWidth)
  const skipCoarse = Math.round((stickyTop * coarsePage.width) / pageWidth)
  const skipFine = Math.round((stickyTop * finePage.width) / pageWidth)

  const matches: SliceMatch[] = []
  for (const s of slices) {
    const sliceHeight = (await sharp(s.file).metadata()).height!
    const coarseSlice = await gray(s.file, COARSE)
    const fineSlice = await gray(s.file, FINE)

    let bestCoarse = 0
    let bestMad = Number.POSITIVE_INFINITY
    for (let o = 0; o <= Math.max(0, coarsePage.height - coarseSlice.height); o++) {
      const mad = madAt(coarsePage, coarseSlice, o, 3, skipCoarse)
      if (mad < bestMad) {
        bestMad = mad
        bestCoarse = o
      }
    }

    const center = Math.round(bestCoarse / coarseScale)
    const window = Math.ceil(2 / coarseScale)
    let best = center
    let bestFine = Number.POSITIVE_INFINITY
    for (let o = center - window; o <= center + window; o++) {
      if (o < 0 || o + sliceHeight > pageHeight) continue
      const mad = madAt(finePage, fineSlice, Math.round(o * fineScale), 2, skipFine)
      if (mad < bestFine) {
        bestFine = mad
        best = o
      }
    }
    best = Math.max(0, Math.min(best, Math.max(0, pageHeight - 1)))

    const cropPath = path.join(diffDir, `slice-${s.name}.png`)

    if (rescan) {
      // 参照と同じ条件で撮り直す。スクロール量は CSS ピクセルなので DPR で割る。
      currentBrowser = await captureResilient({
        url: rescan.url,
        outPath: cropPath,
        spec: { ...rescan.spec, fullPage: false },
        browser: currentBrowser!,
        actions: [
          ...enterActions,
          { type: 'scroll', y: Math.round(best / rescan.spec.deviceScaleFactor) },
        ],
      })
    } else {
      const height = Math.min(sliceHeight, pageHeight - best)
      await sharp(fullPagePath)
        .extract({ left: 0, top: best, width: pageWidth, height })
        .png()
        .toFile(cropPath)
    }

    matches.push({
      name: s.name,
      offset: best,
      score: await score({
        referencePath: s.file,
        candidatePath: cropPath,
        rawDiffPath: path.join(diffDir, `slice-${s.name}.raw-diff.png`),
        layoutDiffPath: path.join(diffDir, `slice-${s.name}.layout-diff.png`),
      }),
    })
  }

  const orderViolations: string[] = []
  for (let i = 1; i < matches.length; i++) {
    if (matches[i]!.offset <= matches[i - 1]!.offset) {
      orderViolations.push(
        `${matches[i - 1]!.name}(${matches[i - 1]!.offset}) → ${matches[i]!.name}(${matches[i]!.offset})`,
      )
    }
  }

  if (stickyTop > 0) {
    console.log(`    sticky 帯 ${stickyTop}px を照合から除外`)
  }
  const lastSliceHeight = (await sharp(slices.at(-1)!.file).metadata()).height!
  const expectedHeight = (matches.at(-1)?.offset ?? 0) + lastSliceHeight
  const worst = matches.reduce((a, b) => (b.score.layoutMad > a.score.layoutMad ? b : a))

  return {
    matches,
    ordered: orderViolations.length === 0,
    orderViolations,
    heightRatio: pageHeight / Math.max(1, expectedHeight),
    worst,
    browser: currentBrowser,
  }
}

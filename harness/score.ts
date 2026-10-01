import { writeFile } from 'node:fs/promises'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import sharp from 'sharp'

export interface Score {
  /** 比較に使った共通ラスタのサイズ */
  width: number
  height: number
  referenceSize: { width: number; height: number }
  candidateSize: { width: number; height: number }
  /**
   * 参照の高さを 1 としたときの、実装側の高さの比。
   * rawDiff が小さくてもこれが 1 から離れていれば、下端が切れているだけで再現できていない。
   */
  heightRatio: number
  /** 正規化後の素のピクセル差分率 (0-1) */
  rawDiff: number
  /** グレースケール+ぼかし後の差分率 (0-1)。フォントレンダリングの揺れを潰した値 */
  layoutDiff: number
  /**
   * ぼかし後の平均絶対差 (0-1)。閾値を持たないので飽和しない。
   *
   * layoutDiff は pixelmatch の閾値を超えた画素を数えるので、再現がよくなると
   * ある時点で厳密に 0 になり、そこから先を測れなくなる（実測: run 08-50-16 が 0.000000）。
   * こちらは差の平均そのものなので、良い実装どうしの優劣も残る。
   */
  layoutMad: number
  rawDiffPath: string
  layoutDiffPath: string
}

type Mode = 'raw' | 'layout'

/**
 * layoutDiff のぼかし半径。
 * これより細かいずれは「同じ」とみなされる。2940px幅なら約29px
 * （CSSピクセルでは約15px相当）。
 */
export function layoutBlurRadius(width: number): number {
  return Math.max(3, Math.round(width / 100))
}

/**
 * 参照と実装を同一サイズの RGBA ラスタに揃える。
 * 参照は画像ファイル（png/webp/jpg）、実装は Playwright の png。
 * 幅を参照に合わせて等比縮小し、共通の高さで上端から切り出す。
 */
async function rasterize(
  file: string,
  width: number,
  height: number,
  mode: Mode,
): Promise<Buffer> {
  let pipeline = sharp(file)
    .resize({ width, fit: 'inside', withoutEnlargement: false })
    .extract({ left: 0, top: 0, width, height })

  if (mode === 'layout') {
    // ぼかしでグリフの差を潰し、配置と寸法の差だけを残す。
    //
    // 半径は画像幅に比例させる。固定値にすると、参照が大きいほど相対的に
    // 効かなくなる。実測では 2940px 幅の参照に半径3を当てたとき、文字が
    // ほぼ全部差分として残り、レイアウトの改善が指標に現れなかった
    // （ターン1→4で -0.008pt。実際には4割改善していた）。
    // 幅の1/100（2940pxなら約29）で、日本語の本文が塊として潰れる。
    pipeline = pipeline.grayscale().blur(layoutBlurRadius(width))
  }

  // sharp の raw 出力のチャンネル数は経路によって変わる（grayscale を通すと1chになり、
  // ensureAlpha でも4chにならない）。pixelmatch は RGBA 固定なので、実際のチャンネル数を
  // 受け取ってから自分で RGBA に展開する。
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
  return toRGBA(data, info.channels, width, height)
}

/** 1/2/3/4 チャンネルの raw を RGBA に展開する。 */
function toRGBA(data: Buffer, channels: number, width: number, height: number): Buffer {
  if (channels === 4) return data

  const out = Buffer.allocUnsafe(width * height * 4)
  for (let i = 0, o = 0; o < out.length; i += channels, o += 4) {
    const r = data[i]!
    if (channels === 1) {
      out[o] = r
      out[o + 1] = r
      out[o + 2] = r
      out[o + 3] = 255
    } else if (channels === 2) {
      out[o] = r
      out[o + 1] = r
      out[o + 2] = r
      out[o + 3] = data[i + 1]!
    } else {
      out[o] = r
      out[o + 1] = data[i + 1]!
      out[o + 2] = data[i + 2]!
      out[o + 3] = 255
    }
  }
  return out
}

async function sizeOf(file: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(file).metadata()
  if (!meta.width || !meta.height) throw new Error(`画像サイズを取得できません: ${file}`)
  return { width: meta.width, height: meta.height }
}

/** ぼかし後の平均絶対差。RGBAのうちRチャンネルだけ見る（グレースケール化済みのため）。 */
function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i]! - b[i]!)
    n++
  }
  return sum / n / 255
}

async function diff(
  refRaw: Buffer,
  candRaw: Buffer,
  width: number,
  height: number,
  threshold: number,
  outPath: string,
): Promise<number> {
  const out = new PNG({ width, height })
  const mismatched = pixelmatch(refRaw, candRaw, out.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.1,
    diffColor: [255, 0, 128],
  })
  await writeFile(outPath, PNG.sync.write(out))
  return mismatched / (width * height)
}

export interface ScoreOptions {
  referencePath: string
  candidatePath: string
  rawDiffPath: string
  layoutDiffPath: string
}

export async function score({
  referencePath,
  candidatePath,
  rawDiffPath,
  layoutDiffPath,
}: ScoreOptions): Promise<Score> {
  const referenceSize = await sizeOf(referencePath)
  const candidateSize = await sizeOf(candidatePath)

  const width = referenceSize.width
  // 実装側を参照の幅に合わせたときの高さ
  const candidateScaledHeight = Math.round((candidateSize.height * width) / candidateSize.width)
  const height = Math.min(referenceSize.height, candidateScaledHeight)
  if (height < 1) throw new Error('比較できる共通領域がありません')

  const [refRaw, candRaw, refLayout, candLayout] = await Promise.all([
    rasterize(referencePath, width, height, 'raw'),
    rasterize(candidatePath, width, height, 'raw'),
    rasterize(referencePath, width, height, 'layout'),
    rasterize(candidatePath, width, height, 'layout'),
  ])

  const rawDiff = await diff(refRaw, candRaw, width, height, 0.1, rawDiffPath)
  const layoutDiff = await diff(refLayout, candLayout, width, height, 0.2, layoutDiffPath)
  const layoutMad = meanAbsDiff(refLayout, candLayout)

  return {
    width,
    height,
    referenceSize,
    candidateSize,
    heightRatio: candidateScaledHeight / referenceSize.height,
    rawDiff,
    layoutDiff,
    layoutMad,
    rawDiffPath,
    layoutDiffPath,
  }
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

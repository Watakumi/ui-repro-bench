import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ROOT, RUNS_DIR } from './config.ts'

/**
 * 参照画像を「測る」ためのツール。
 *
 * エージェントは参照をスクショとして目で見るしかなく、寸法や色を推測で決めている。
 * 実測した judge の指摘も「約4%拡大」「約6pxずれ」のように全部が概算だった。
 * ここが再現精度の天井になるので、測る手段を与える。
 *
 *   pnpm probe size  <画像>
 *   pnpm probe color <画像> <x> <y> [--r 4]
 *   pnpm probe crop  <画像> <x> <y> <w> <h> [--scale 2] [--out path]
 *   pnpm probe pair  <参照> <実装> <x> <y> <w> <h> [--scale 2] [--out path]
 *   pnpm probe grid  <画像> [--step 100] [--out path]
 *
 * 座標は画像そのもののピクセル。CSSピクセルは値の横に併記する。
 */

const PROBE_DIR = path.join(RUNS_DIR, '_probe')

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function resolve(p: string): string {
  return path.resolve(ROOT, p)
}

async function outPath(name: string): Promise<string> {
  const given = flag('out')
  if (given) return resolve(given)
  await mkdir(PROBE_DIR, { recursive: true })
  return path.join(PROBE_DIR, name)
}

async function meta(file: string) {
  const m = await sharp(resolve(file)).metadata()
  if (!m.width || !m.height) throw new Error(`画像を読めません: ${file}`)
  return { width: m.width, height: m.height }
}

/** 画像ピクセル → CSSピクセル。参照は @2x なので半分になる、といった換算の併記用。 */
function cssNote(px: number, dpr: number): string {
  return dpr === 1 ? '' : ` (CSS ${(px / dpr).toFixed(1)}px)`
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

async function cmdSize(file: string): Promise<void> {
  const { width, height } = await meta(file)
  console.log(`${width}x${height}`)
  console.log(`  @2x とすると CSS ${width / 2}x${height / 2}`)
  console.log(`  @3x とすると CSS ${(width / 3).toFixed(1)}x${(height / 3).toFixed(1)}`)
}

/** 指定座標の色。アンチエイリアスに引きずられないよう半径 r の平均を取る。 */
async function cmdColor(file: string, x: number, y: number): Promise<void> {
  const r = Number(flag('r', '4'))
  const { width, height } = await meta(file)
  const left = Math.max(0, x - r)
  const top = Math.max(0, y - r)
  const w = Math.min(r * 2 + 1, width - left)
  const h = Math.min(r * 2 + 1, height - top)

  const { data, info } = await sharp(resolve(file))
    .extract({ left, top, width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const ch = info.channels
  const n = w * h
  let sr = 0
  let sg = 0
  let sb = 0
  for (let i = 0; i < n * ch; i += ch) {
    sr += data[i]!
    sg += data[i + 1] ?? data[i]!
    sb += data[i + 2] ?? data[i]!
  }
  const [R, G, B] = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]
  console.log(`(${x}, ${y}) 半径${r}の平均`)
  console.log(`  ${hex(R!, G!, B!)}   rgb(${R}, ${G}, ${B})`)
}

async function cmdCrop(file: string, x: number, y: number, w: number, h: number): Promise<void> {
  const scale = Number(flag('scale', '2'))
  const out = await outPath(`crop-${path.basename(file, path.extname(file))}-${x}_${y}_${w}_${h}.png`)
  await sharp(resolve(file))
    .extract({ left: x, top: y, width: w, height: h })
    .resize({ width: Math.round(w * scale), kernel: 'nearest' })
    .png()
    .toFile(out)
  console.log(`${out}`)
  console.log(`  範囲 (${x}, ${y}) から ${w}x${h} を ${scale}倍`)
}

/** 参照と実装の同じ領域を縦に並べて拡大する。ずれを目で確かめるため。 */
async function cmdPair(
  ref: string,
  impl: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  const scale = Number(flag('scale', '2'))
  const out = await outPath(`pair-${x}_${y}_${w}_${h}.png`)
  const W = Math.round(w * scale)
  const H = Math.round(h * scale)
  const label = 28

  const tiles = await Promise.all(
    [ref, impl].map((f) =>
      sharp(resolve(f))
        .extract({ left: x, top: y, width: w, height: h })
        .resize({ width: W, kernel: 'nearest' })
        .png()
        .toBuffer(),
    ),
  )

  const svg = Buffer.from(
    `<svg width="${W}" height="${(H + label) * 2}">
      <rect width="100%" height="100%" fill="#111"/>
      <text x="8" y="20" fill="#0f0" font-family="monospace" font-size="16">参照</text>
      <text x="8" y="${H + label + 20}" fill="#f0f" font-family="monospace" font-size="16">実装</text>
    </svg>`,
  )

  await sharp(svg)
    .composite([
      { input: tiles[0]!, left: 0, top: label },
      { input: tiles[1]!, left: 0, top: H + label * 2 },
    ])
    .png()
    .toFile(out)
  console.log(`${out}`)
  console.log(`  上=参照 / 下=実装、範囲 (${x}, ${y}) から ${w}x${h} を ${scale}倍`)
}

/** 座標グリッドを重ねる。寸法を目盛りから読めるようにするため。 */
async function cmdGrid(file: string): Promise<void> {
  const step = Number(flag('step', '100'))
  const { width, height } = await meta(file)
  const out = await outPath(`grid-${path.basename(file, path.extname(file))}.png`)

  const lines: string[] = []
  for (let x = 0; x <= width; x += step) {
    const major = x % (step * 5) === 0
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${major ? '#f0f' : '#f0f'}" stroke-width="${major ? 2 : 1}" stroke-opacity="${major ? 0.8 : 0.3}"/>`,
    )
    if (major) {
      lines.push(
        `<text x="${x + 4}" y="18" fill="#f0f" font-family="monospace" font-size="20" font-weight="bold">${x}</text>`,
      )
    }
  }
  for (let y = 0; y <= height; y += step) {
    const major = y % (step * 5) === 0
    lines.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#0ff" stroke-width="${major ? 2 : 1}" stroke-opacity="${major ? 0.8 : 0.3}"/>`,
    )
    if (major) {
      lines.push(
        `<text x="4" y="${y + 22}" fill="#0ff" font-family="monospace" font-size="20" font-weight="bold">${y}</text>`,
      )
    }
  }

  await sharp(resolve(file))
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}">${lines.join('')}</svg>`) }])
    .png()
    .toFile(out)
  console.log(`${out}`)
  console.log(`  ${step}px ごと（太線は ${step * 5}px ごと）。縦線=マゼンタ/X、横線=シアン/Y`)
  console.log(`  画像 ${width}x${height}${cssNote(width, 2)}`)
}

/**
 * 直線上を走査して、同じ明度が続く区間（ラン）を並べる。
 * 罫線の太さ、余白の幅、要素の高さが直接読める。
 *
 * 1px の CSS 罫線が何デバイスピクセルで描かれているかを見れば、
 * 参照画像の DPR が確定する（2px なら @2x）。
 */
async function cmdScan(file: string): Promise<void> {
  const x = flag('x')
  const y = flag('y')
  const from = Number(flag('from', '0'))
  const to = flag('to')
  const tolerance = Number(flag('tolerance', '6'))
  const minRun = Number(flag('min', '1'))

  if ((x === undefined) === (y === undefined)) {
    console.error('--x（縦スキャン）か --y（横スキャン）のどちらか一方を指定してください')
    process.exit(1)
  }

  const { width, height } = await meta(file)
  const vertical = x !== undefined
  const fixed = Number(vertical ? x : y)
  const end = to === undefined ? (vertical ? height : width) : Number(to)

  const region = vertical
    ? { left: fixed, top: from, width: 1, height: end - from }
    : { left: from, top: fixed, width: end - from, height: 1 }

  const { data, info } = await sharp(resolve(file))
    .extract(region)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const lum: number[] = []
  for (let i = 0; i < data.length; i += info.channels) lum.push(data[i]!)

  // 明度が tolerance 以内で続く区間をまとめる
  const runs: { start: number; length: number; value: number }[] = []
  let s0 = 0
  let sum = lum[0] ?? 0
  for (let i = 1; i <= lum.length; i++) {
    const mean = sum / (i - s0)
    if (i === lum.length || Math.abs(lum[i]! - mean) > tolerance) {
      runs.push({ start: from + s0, length: i - s0, value: Math.round(mean) })
      s0 = i
      sum = lum[i] ?? 0
    } else {
      sum += lum[i]!
    }
  }

  const shown = runs.filter((r) => r.length >= minRun)
  console.log(`${vertical ? '縦' : '横'}スキャン ${vertical ? 'x' : 'y'}=${fixed}, ${from}→${end}`)
  console.log(`  ${runs.length}区間（${minRun}px以上を表示）`)
  console.log('  位置      太さ   明度')
  for (const r of shown.slice(0, 50)) {
    console.log(`  ${String(r.start).padStart(6)}  ${String(r.length).padStart(4)}  ${String(r.value).padStart(4)}`)
  }
  if (shown.length > 50) console.log(`  … 他 ${shown.length - 50} 区間`)
}

/**
 * 2枚の縦ずれを探す。同じページをスクロール位置違いで撮ったスクショから、
 * スクロール量を割り出すために使う。
 *
 * 固定ヘッダーは動かないので、既定では上部を除いた領域だけを突き合わせる。
 */
async function cmdOffset(a: string, b: string): Promise<void> {
  const top = Number(flag('top', '250'))
  const range = Number(flag('range', '3000'))
  const step = Number(flag('step', '2'))
  const bandHeight = Number(flag('band', '400'))

  const sizeA = await meta(a)
  const sizeB = await meta(b)
  if (sizeA.width !== sizeB.width) throw new Error('幅が違う画像は比較できません')

  const gray = async (file: string, y: number, h: number) => {
    const { data, info } = await sharp(resolve(file))
      .extract({ left: 0, top: y, width: sizeA.width, height: h })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const out: number[] = []
    for (let i = 0; i < data.length; i += info.channels) out.push(data[i]!)
    return out
  }

  // b の上部の帯を、a の中から探す
  const band = await gray(b, top, bandHeight)
  const searchTop = top
  const searchBottom = Math.min(sizeA.height - bandHeight, top + range)

  let bestDy = 0
  let bestMad = Number.POSITIVE_INFINITY
  for (let dy = searchTop; dy <= searchBottom; dy += step) {
    const candidate = await gray(a, dy, bandHeight)
    let sum = 0
    // 帯全体を舐めると遅いので、行方向に間引いて比べる
    for (let i = 0; i < band.length; i += 37) sum += Math.abs(band[i]! - candidate[i]!)
    const mad = sum / Math.ceil(band.length / 37)
    if (mad < bestMad) {
      bestMad = mad
      bestDy = dy
    }
  }

  const deviceShift = bestDy - top
  console.log(`${path.basename(b)} は ${path.basename(a)} より ${deviceShift} デバイスpx 下`)
  console.log(`  一致度（平均絶対差、小さいほど良い）: ${bestMad.toFixed(2)}`)
  console.log(`  CSSピクセル換算（@2x）: scroll ${deviceShift / 2}`)
  if (bestMad > 25) {
    console.log('  ⚠ 一致度が低いです。スクロール違いではなく別の状態かもしれません。')
  }
}

const USAGE = `使い方:
  pnpm probe size  <画像>
  pnpm probe color <画像> <x> <y> [--r 4]
  pnpm probe crop  <画像> <x> <y> <w> <h> [--scale 2] [--out path]
  pnpm probe pair  <参照> <実装> <x> <y> <w> <h> [--scale 2] [--out path]
  pnpm probe grid  <画像> [--step 100] [--out path]
  pnpm probe scan  <画像> --x <x> [--from a] [--to b] [--tolerance 6] [--min 1]
  pnpm probe scan  <画像> --y <y> [--from a] [--to b]
  pnpm probe offset <基準画像> <対象画像> [--top 250] [--range 3000] [--band 400]
      同じページのスクロール位置違いから、ずれ量を割り出す
      直線上の「同じ明度が続く区間」を並べる。罫線の太さ・余白の幅が直接読める

座標は画像そのもののピクセル。参照が @2x なら CSS ピクセルはその半分。`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const n = (i: number) => Number(rest[i])
  switch (cmd) {
    case 'size':
      return cmdSize(rest[0]!)
    case 'color':
      return cmdColor(rest[0]!, n(1), n(2))
    case 'crop':
      return cmdCrop(rest[0]!, n(1), n(2), n(3), n(4))
    case 'pair':
      return cmdPair(rest[0]!, rest[1]!, n(2), n(3), n(4), n(5))
    case 'grid':
      return cmdGrid(rest[0]!)
    case 'scan':
      return cmdScan(rest[0]!)
    case 'offset':
      return cmdOffset(rest[0]!, rest[1]!)
    default:
      console.error(USAGE)
      process.exit(1)
  }
}

await main()

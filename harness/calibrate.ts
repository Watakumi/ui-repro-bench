import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { capture, withBrowser } from './capture.ts'
import { RUNS_DIR, makeRunId, type TargetSpec } from './config.ts'
import { startDevServer } from './devserver.ts'
import { pct, score } from './score.ts'

/**
 * 計測系そのものを検証する。実際の試行を1回も回さずに、
 * 「このスコアは信用できるのか」「閾値をどこに置けばいいのか」を先に確かめる。
 *
 * 前提: 参照はスクリーンショット画像なので、レンダリング環境が実装側と一致しない。
 * 生ピクセル差分0%は原理的に到達しない。だから閾値は勘ではなく、
 * 「環境差だけで出るノイズ」を実測して決める。
 */

type Baseline = Pick<
  TargetSpec,
  'route' | 'viewport' | 'deviceScaleFactor' | 'colorScheme'
> & { fullPage: boolean }

// 較正は「実際に使う撮影条件」で行う。条件が違うとノイズの見積もりが外れる。
// ここは最初のターゲット（NewsPicks 記事詳細 = デスクトップWeb・ライト）に合わせてある。
const BASELINE: Baseline = {
  route: '/',
  viewport: { width: 1470, height: 956 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  fullPage: false,
}

interface Step {
  name: string
  rawDiff: number
  layoutDiff: number
  note: string
}

async function main(): Promise<void> {
  const runId = makeRunId('calib')
  const runDir = path.join(RUNS_DIR, runId)
  await mkdir(runDir, { recursive: true })

  const p = (name: string) => path.join(runDir, name)
  const steps: Step[] = []

  const server = await startDevServer()
  try {
    await withBrowser(async (browser) => {
      // 基準。この1枚を「参照」に見立てる。
      await capture({ url: server.url, outPath: p('base.png'), spec: BASELINE, browser })

      // 1. 自己整合性 — 同条件で撮り直す。0 でなければ撮影が非決定的で、計測が成立しない。
      await capture({ url: server.url, outPath: p('same.png'), spec: BASELINE, browser })
      const self = await score({
        referencePath: p('base.png'),
        candidatePath: p('same.png'),
        rawDiffPath: p('same.raw-diff.png'),
        layoutDiffPath: p('same.layout-diff.png'),
      })
      steps.push({
        name: 'self-consistency',
        rawDiff: self.rawDiff,
        layoutDiff: self.layoutDiff,
        note: '同条件で撮り直し。0でなければ撮影が非決定的で計測が成立しない',
      })

      // 2. webp 往復 — UI Pocket の書き出しは webp。形式変換だけで乗る損失を測る。
      await sharp(p('base.png')).webp({ quality: 90 }).toFile(p('base.webp'))
      const webp = await score({
        referencePath: p('base.webp'),
        candidatePath: p('same.png'),
        rawDiffPath: p('webp.raw-diff.png'),
        layoutDiffPath: p('webp.layout-diff.png'),
      })
      steps.push({
        name: 'webp-roundtrip',
        rawDiff: webp.rawDiff,
        layoutDiff: webp.layoutDiff,
        note: '参照をwebp経由にしたときの損失。UI Pocketの書き出しと同じ経路',
      })

      // 3. 環境差 — DPR を変えて撮る。参照が別端末のスクショであることの代理。
      await capture({
        url: server.url,
        outPath: p('dpr2.png'),
        spec: { ...BASELINE, deviceScaleFactor: 1 },
        browser,
      })
      const dpr = await score({
        referencePath: p('base.png'),
        candidatePath: p('dpr2.png'),
        rawDiffPath: p('dpr.raw-diff.png'),
        layoutDiffPath: p('dpr.layout-diff.png'),
      })
      steps.push({
        name: 'dpr-shift',
        rawDiff: dpr.rawDiff,
        layoutDiff: dpr.layoutDiff,
        note: 'DPR 2→1。参照が別環境のスクショであることによるノイズ下限',
      })

      // 4. 感度 — 意図的に 1px ずらす。これを検出できないなら閾値が緩すぎる。
      await capture({
        url: server.url,
        outPath: p('nudge.png'),
        spec: BASELINE,
        browser,
        extraCss: 'section { padding: 25px !important; }',
      })
      const nudge = await score({
        referencePath: p('base.png'),
        candidatePath: p('nudge.png'),
        rawDiffPath: p('nudge.raw-diff.png'),
        layoutDiffPath: p('nudge.layout-diff.png'),
      })
      steps.push({
        name: 'nudge-1px',
        rawDiff: nudge.rawDiff,
        layoutDiff: nudge.layoutDiff,
        note: 'カードの padding を 24px→25px。検出できる最小の変化',
      })
    })
  } finally {
    await server.stop()
  }

  // 閾値は「ノイズの上」かつ「感度の下」に置く。両者が近いほど余裕がない。
  const sensitivity = steps.find((s) => s.name === 'nudge-1px')!
  const noise = steps.filter((s) => s.name !== 'nudge-1px')
  const rawNoise = Math.max(...noise.map((s) => s.rawDiff))
  const layoutNoise = Math.max(...noise.map((s) => s.layoutDiff))

  const rawPick = pickThreshold(rawNoise, sensitivity.rawDiff)
  const layoutPick = pickThreshold(layoutNoise, sensitivity.layoutDiff)
  const recommendedThresholds = { rawDiff: rawPick.value, layoutDiff: layoutPick.value }

  await writeFile(
    path.join(runDir, 'calibration.json'),
    `${JSON.stringify(
      {
        runId,
        ranAt: new Date().toISOString(),
        baseline: BASELINE,
        steps,
        separation: { rawDiff: rawPick.separation, layoutDiff: layoutPick.separation },
        recommendedThresholds,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`\n較正結果 (${runDir})\n`)
  console.log('  ステップ            rawDiff    layoutDiff')
  for (const s of steps) {
    console.log(
      `  ${s.name.padEnd(18)} ${pct(s.rawDiff).padStart(8)}  ${pct(s.layoutDiff).padStart(10)}`,
    )
  }
  console.log('')

  if (steps[0]!.rawDiff > 0) {
    console.log('⚠ 自己整合性が0ではありません。撮影が非決定的で、このままでは計測が信用できません。')
    console.log('  FREEZE_CSS で止めきれていない動きがないか確認してください。')
  }

  report('rawDiff', rawPick)
  report('layoutDiff', layoutPick)

  console.log('')
  console.log(
    `推奨閾値: rawDiff ${fmt(recommendedThresholds.rawDiff)} / layoutDiff ${fmt(recommendedThresholds.layoutDiff)}`,
  )
  console.log('target.json の thresholds にこの値を入れてください。')
  console.log('')
  console.log('注意: この較正はサンドボックス同士の比較なので、ノイズを楽観的に見積もっています。')
  console.log('      実際の参照は別端末・別フォント環境のスクショなので、ノイズはこれより大きくなります。')
  console.log('      最初の試行を回したあと、実測の差分を見て閾値を引き直してください。')
}

interface ThresholdPick {
  value: number | null
  /** 感度 / ノイズ。大きいほど「本物の差」と「環境差」を区別しやすい */
  separation: number | null
  usable: boolean
}

/**
 * ノイズと感度の間に閾値を置く。
 * ノイズ以下だと環境差で永久に収束せず、感度以上だと1pxのずれを見逃す。
 */
function pickThreshold(noise: number, sensitivity: number): ThresholdPick {
  if (sensitivity <= noise) {
    return { value: null, separation: noise > 0 ? sensitivity / noise : null, usable: false }
  }
  // ノイズが0なら感度の1/4。0ではないなら両者の中間（ただしノイズの1.5倍を上限）。
  const value = noise > 0 ? Math.min(noise * 1.5, (noise + sensitivity) / 2) : sensitivity / 4
  return {
    value: Number(value.toFixed(5)),
    separation: noise > 0 ? Number((sensitivity / noise).toFixed(2)) : null,
    usable: true,
  }
}

function fmt(v: number | null): string {
  return v === null ? '使用不可' : pct(v)
}

function report(name: string, p: ThresholdPick): void {
  if (!p.usable) {
    console.log(`⚠ ${name}: ノイズが感度以上です。この指標では1pxのずれを検出できません。`)
    return
  }
  if (p.separation === null) {
    console.log(`  ${name}: ノイズ0。感度の1/4を閾値にしました。`)
    return
  }
  if (p.separation < 2) {
    console.log(
      `⚠ ${name}: 感度がノイズの ${p.separation} 倍しかありません。収束判定がノイズに埋もれます。`,
    )
    console.log(`  この指標を主軸にせず、余裕のある方の指標で判定してください。`)
  } else {
    console.log(`  ${name}: 感度はノイズの ${p.separation} 倍。分離できています。`)
  }
}

await main()

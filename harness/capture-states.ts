import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { ROOT, isEntrypoint, type Action } from './config.ts'

/**
 * 実サイトから「状態つき」の参照を撮る。
 *
 * 既定状態だけのターゲットは1ターンで飽和した。難しいのは静止画ではなく、
 * 既定状態に写っていない要素（開いたメニュー、モーダル、選択行）で、
 * それらは実装側で本当に開けないと合わない。
 *
 *   pnpm capture:states <slug>
 *
 * 状態の定義は targets/<slug>/states.json に書く（target.json とは別にしておき、
 * 撮り直しのたびに target.json を壊さない）。
 */
interface StateSpec {
  name: string
  note?: string
  /** 既定状態からこの状態にするための操作 */
  actions?: Action[]
  /** 既定状態に戻すための操作。読み直さずに戻すので、データが変わらない */
  undo?: Action[]
}

async function run(page: Page, actions: Action[]): Promise<void> {
  for (const a of actions) {
    if (a.type === 'click' || a.type === 'hover') {
      const t = a.selector ? page.locator(a.selector).first() : page.getByText(a.text ?? '', { exact: false }).first()
      if ((await t.count()) === 0) {
        console.warn(`    操作対象が見つかりません: ${a.selector ?? a.text}`)
        continue
      }
      if (a.type === 'click') await t.click({ timeout: 8000 }).catch(() => {})
      else await t.hover({ timeout: 8000 }).catch(() => {})
    } else if (a.type === 'press') {
      await page.keyboard.press(a.key)
    } else if (a.type === 'scroll') {
      await page.evaluate((y) => window.scrollTo(0, y), a.y)
    } else if (a.type === 'wait') {
      await page.waitForTimeout(a.ms)
    }
    await page.waitForTimeout(150)
  }
}

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) {
    console.error('使い方: pnpm capture:states <slug>')
    process.exit(1)
  }
  const dir = path.join(ROOT, 'targets', slug)
  const target = JSON.parse(await readFile(path.join(dir, 'target.json'), 'utf8')) as {
    source?: string
    viewport: { width: number; height: number }
    deviceScaleFactor?: number
    colorScheme?: string
  }
  const states = JSON.parse(await readFile(path.join(dir, 'states.json'), 'utf8')) as StateSpec[]
  const url = target.source
  if (!url) throw new Error('target.json に source（撮影元URL）がありません')

  // 状態ごとに読み直すと、乱数で作られた表の中身が状態ごとに変わる。
  // そうなると「全状態を満たす実装」が存在しない出題になる（廃止した
  // newspicks-article-full と同じ罠）。1回の読み込みの中で状態を移し、
  // 撮り終えたら undo で既定状態に戻す。
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: target.viewport,
      deviceScaleFactor: target.deviceScaleFactor ?? 2,
      colorScheme: (target.colorScheme ?? 'light') as 'light' | 'dark',
    })
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(600)

    for (const st of states) {
      await run(page, st.actions ?? [])
      const out = path.join(dir, st.name === 'default' ? 'reference.png' : `reference-${st.name}.png`)
      await page.screenshot({ path: out })
      console.log(`  ${st.name.padEnd(18)} → ${path.relative(ROOT, out)}${st.note ? `  （${st.note}）` : ''}`)
      await run(page, st.undo ?? [])
      await page.waitForTimeout(200)
    }
  } finally {
    await browser.close()
  }

  const tj = JSON.parse(await readFile(path.join(dir, 'target.json'), 'utf8')) as Record<string, unknown>
  tj.states = states.map((s) => ({
    name: s.name,
    ...(s.note ? { note: s.note } : {}),
    ...(s.actions ? { actions: s.actions } : {}),
  }))
  await writeFile(path.join(dir, 'target.json'), `${JSON.stringify(tj, null, 2)}\n`, 'utf8')
  console.log(`\n${states.length} 状態を1回の読み込みで撮りました（データは全状態で同じ）`)
}

if (isEntrypoint(import.meta.url)) await main()

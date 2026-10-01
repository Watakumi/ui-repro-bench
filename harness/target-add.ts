import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { ROOT, TARGETS_DIR, isEntrypoint } from './config.ts'

/**
 * 実在する公開ページから新しいターゲットを起こす。
 *
 * これまで新ターゲットの追加は全部手作業だった（参照を見て radix.expected や
 * states を書く）。それが増やせない原因であり、同時に「どの要素をどの primitive で
 * 作るか」という設計判断を私が渡してしまう経路でもあった。
 *
 * ここでは参照の採取と雛形の生成までを自動化する。
 * 要素の抽出（radix.expected 等）は別途エージェントにやらせる。
 *
 *   pnpm target:add <slug> <url> [--width 1470] [--height 956] [--dpr 2] [--dark]
 *   pnpm target:add <slug> <url> --scroll 0,900,1800,2700   # 断片として複数位置を撮る
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`

async function main(): Promise<void> {
  const [slug, url] = process.argv.slice(2)
  if (!slug || !url || slug.startsWith('--')) {
    console.error('使い方: pnpm target:add <slug> <url> [--width 1470] [--height 956] [--dpr 2] [--dark] [--scroll 0,900,1800]')
    process.exit(1)
  }

  const viewport = {
    width: Number(flag('width') ?? 1470),
    height: Number(flag('height') ?? 956),
  }
  const deviceScaleFactor = Number(flag('dpr') ?? 2)
  const colorScheme = (process.argv.includes('--dark') ? 'dark' : 'light') as 'dark' | 'light'
  const scrolls = (flag('scroll') ?? '0').split(',').map((n) => Number(n.trim()))

  const dir = path.join(TARGETS_DIR, slug)
  await mkdir(dir, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    colorScheme,
    reducedMotion: 'reduce',
  })

  try {
    const page = await context.newPage()
    console.log(`▶ ${url} を採取します`)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.addStyleTag({ content: FREEZE_CSS })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)

    const files: string[] = []
    for (const [i, y] of scrolls.entries()) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y)
      await page.waitForTimeout(300)
      const name = scrolls.length === 1 ? 'reference.png' : `slice-${String(i + 1).padStart(2, '0')}.png`
      await page.screenshot({ path: path.join(dir, name), animations: 'disabled' })
      files.push(name)
      console.log(`  ${name}  (scroll ${y})`)
    }

    // 断片モードでは1枚目を reference にもする（既定状態の参照として使う）
    if (scrolls.length > 1) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(dir, 'reference.png'), animations: 'disabled' })
    }

    const title = await page.title()
    const spec = {
      slug,
      title,
      notes: `${url} から採取。要素の棚卸しと radix.expected は未記入（pnpm extract で埋める）。`,
      source: url,
      capturedAt: new Date().toISOString(),
      route: '/',
      viewport,
      deviceScaleFactor,
      colorScheme,
      fullPage: scrolls.length > 1,
      ...(scrolls.length > 1 ? { slices: files } : {}),
      thresholds: { rawDiff: 0.3, layoutDiff: 0.01 },
      maxTurns: 12,
      maxBudgetUsd: 6,
      structure: { maxAbsoluteRatio: 0.4 },
      radix: { expected: [] as { element: string; primitive: string }[] },
    }
    await writeFile(
      path.join(dir, 'target.json'),
      `${JSON.stringify(spec, null, 2)}\n`,
      'utf8',
    )

    console.log(`\n作成: ${path.relative(ROOT, dir)}`)
    console.log(`  タイトル: ${title}`)
    console.log(`  参照 ${files.length}枚 / ${viewport.width}x${viewport.height} @${deviceScaleFactor}x / ${colorScheme}`)
    console.log('\n次: radix.expected が空です。要素の棚卸しが要ります。')
  } finally {
    await context.close()
    await browser.close()
  }
}

if (isEntrypoint(import.meta.url)) await main()

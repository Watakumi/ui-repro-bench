import { chromium, type Browser, type Page } from 'playwright'
import type { Action, TargetSpec } from './config.ts'

export interface CaptureOptions {
  url: string
  outPath: string
  spec: Pick<TargetSpec, 'viewport' | 'deviceScaleFactor' | 'colorScheme' | 'route'> &
    Pick<Partial<TargetSpec>, 'fullPage'>
  browser?: Browser
  /** 較正で「意図的な微小変更」を当てるための追加CSS。試行では使わない。 */
  extraCss?: string
  /** 撮影前に行う操作。状態を作るために使う。 */
  actions?: Action[]
}

/**
 * 撮影条件を固定する CSS。アニメーション・トランジション・caret を止めないと、
 * 同じUIを撮り直しただけで差分が出て、計測系が信用できなくなる。
 */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
    transition-delay: -1ms !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`

/**
 * 操作を実行する。
 *
 * 要素の指定は selector か text のどちらか。参照UIを再現した実装は
 * クラス名まで同じとは限らないので、text（表示文字列）で指定できるようにしてある。
 */
async function runActions(page: Page, actions: Action[]): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case 'scroll':
        // CSS ピクセルでの絶対位置。参照がスクロール位置違いのとき使う
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), action.y)
        await page.waitForTimeout(80)
        break
      case 'click':
      case 'hover': {
        const target = action.selector
          ? page.locator(action.selector).first()
          : page.getByText(action.text ?? '', { exact: false }).first()
        // 要素が無い実装でも試行を止めない。差分として現れるほうが情報になる。
        const found = await target.count()
        if (found === 0) {
          console.warn(`    操作対象が見つかりません: ${action.selector ?? action.text}`)
          break
        }
        if (action.type === 'click') await target.click({ timeout: 5000 }).catch(() => {})
        else await target.hover({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(150)
        break
      }
      case 'press':
        await page.keyboard.press(action.key)
        await page.waitForTimeout(150)
        break
      case 'wait':
        await page.waitForTimeout(action.ms)
        break
    }
  }
}

export async function capture({
  url,
  outPath,
  spec,
  browser,
  extraCss,
  actions,
}: CaptureOptions): Promise<void> {
  const ownBrowser = browser ?? (await chromium.launch())
  const context = await ownBrowser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: spec.deviceScaleFactor,
    colorScheme: spec.colorScheme,
    reducedMotion: 'reduce',
    // 参照がモバイルスクショのときに、ホバー前提のスタイルが当たらないようにする
    hasTouch: spec.viewport.width < 600,
    isMobile: spec.viewport.width < 600,
  })

  try {
    const page = await context.newPage()
    await page.goto(new URL(spec.route, url).toString(), { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: FREEZE_CSS })
    if (extraCss) await page.addStyleTag({ content: extraCss })
    await page.evaluate(() => document.fonts.ready)
    // フォント適用後の再レイアウトが落ち着くまで待つ
    await page.waitForTimeout(250)
    if (actions?.length) await runActions(page, actions)
    await page.screenshot({ path: outPath, fullPage: spec.fullPage ?? false, animations: 'disabled' })
  } finally {
    await context.close()
    if (!browser) await ownBrowser.close()
  }
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch()
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

/**
 * ブラウザが落ちていたら立て直して1度だけやり直す。
 *
 * builder が自分で確認のためにブラウザを立てることがあり、
 * 資源の取り合いでハーネス側の chromium が落ちることがある。
 * 90分の実行が撮影1回の失敗で全損するのは割に合わない。
 */
export async function captureResilient(
  opts: CaptureOptions & { browser: Browser },
): Promise<Browser> {
  try {
    await capture(opts)
    return opts.browser
  } catch (error) {
    console.warn(`    撮影に失敗、ブラウザを立て直します: ${String(error).slice(0, 120)}`)
    await opts.browser.close().catch(() => {})
    const fresh = await chromium.launch()
    await capture({ ...opts, browser: fresh })
    return fresh
  }
}

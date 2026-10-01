import { chromium, type Browser } from 'playwright'
import type { Action, TargetSpec } from './config.ts'

/**
 * ページが「1本のドキュメントフロー」になっているかを、描画結果のDOMで検査する。
 *
 * 実測（run 2026-09-18T00-05-31）で、参照6枚を満たす最小の構成として
 * `h-[956px] overflow-y-auto` の容器を6個縦に並べ、それぞれを JS で
 * 別の位置までスクロールさせた実装が出てきた。フルページ撮影では
 * 各断片が等間隔・単調増加で完全一致するので、断片の指標では検出できない。
 * 実際にスクロールするとヘッダーが6回現れ、要素が途中で切断される。
 *
 * ソースの grep ではなく DOM を見るのは、書き方を変えれば避けられてしまうため。
 */

export interface FlowCheck {
  /** ビューポート高に近い高さを持つスクロール容器の数。1本のページなら0 */
  innerScrollers: number
  /** 同一文面または sticky/fixed の header の最大重複数。1本のページなら1 */
  headers: number
  /** ドキュメント自身がスクロールするか */
  documentScrolls: boolean
  /** ページ全体の高さ（CSSピクセル） */
  documentHeight: number
  /** 高さがビューポート高のほぼ整数倍か。画面を並べた構成の兆候 */
  viewportMultiple: number | null
  /**
   * 同じ文言の見出しが複数回現れているもの。
   *
   * 参照の状態を縦に積むと、「コメント」「この記事の著者 / 編集者」のような
   * 見出しが1ページに2回出る。実測では judge がこれを4ターン指摘しながら
   * 5ターン目に見逃した。機械的に判定できるものを LLM に任せない。
   */
  duplicateHeadings: { text: string; count: number }[]
  ok: boolean
  issues: string[]
}

export async function inspectFlow(
  url: string,
  spec: Pick<TargetSpec, 'viewport' | 'deviceScaleFactor' | 'colorScheme' | 'route'>,
  browser?: Browser,
  /**
   * 参照の状態に入るための操作。
   * これを適用しないと、操作前のページを測ってしまう。
   * 実測では「続きを読む」前の高さ 2193px を報告し続け、
   * 実際の 5467px と食い違っていた。
   */
  enterActions: Action[] = [],
): Promise<FlowCheck> {
  const own = browser ?? (await chromium.launch())
  const context = await own.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: spec.deviceScaleFactor,
    colorScheme: spec.colorScheme,
    reducedMotion: 'reduce',
  })
  try {
    const page = await context.newPage()
    await page.goto(new URL(spec.route, url).toString(), { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)

    for (const action of enterActions) {
      if (action.type === 'click' || action.type === 'hover') {
        const target = action.selector
          ? page.locator(action.selector).first()
          : page.getByText(action.text ?? '', { exact: false }).first()
        if ((await target.count()) === 0) {
          console.warn(`    フロー検査: 操作対象が見つかりません: ${action.selector ?? action.text}`)
          continue
        }
        if (action.type === 'click') await target.click({ timeout: 5000 }).catch(() => {})
        else await target.hover({ timeout: 5000 }).catch(() => {})
      } else if (action.type === 'press') {
        await page.keyboard.press(action.key)
      } else if (action.type === 'wait') {
        await page.waitForTimeout(action.ms)
      }
      await page.waitForTimeout(120)
    }
    if (enterActions.length > 0) await page.waitForTimeout(200)

    const raw = await page.evaluate(() => {
      const vh = window.innerHeight
      const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => {
        const s = getComputedStyle(el)
        const scrolls = s.overflowY === 'auto' || s.overflowY === 'scroll'
        // ビューポートの8割以上の高さを持つ内部スクロール容器だけを問題にする。
        // コメント欄のような部分的なスクロール領域は正当なので除く。
        return scrolls && el.clientHeight >= vh * 0.8
      }).length
      // 見出しの重複を数える。装飾や空文字は除く。
      const headingCounts = new Map<string, number>()
      for (const el of Array.from(document.querySelectorAll('h1, h2, h3'))) {
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
        if (text.length < 2 || text.length > 40) continue
        headingCounts.set(text, (headingCounts.get(text) ?? 0) + 1)
      }
      const duplicates = Array.from(headingCounts.entries())
        .filter(([, n]) => n > 1)
        .map(([text, count]) => ({ text, count }))

      const doc = document.documentElement
      return {
        duplicateHeadings: duplicates,
        innerScrollers: scrollers,
        // 「画面の複製」を見たいのであって、<header> の数そのものに意味はない。
        // パネルやカードの見出し帯を <header> にするのは正当な HTML で、
        // ダッシュボードでもフォームでも幅は広い（幅の閾値では誤検知した。2回）。
        // 複製なら同じ文面のヘッダーが繰り返し現れるので、文面の重複と sticky/fixed の重複だけを数える
        headers: (() => {
          const els = Array.from(document.querySelectorAll('header'))
          const byText = new Map<string, number>()
          let pinned = 0
          for (const el of els) {
            const pos = getComputedStyle(el).position
            if (pos === 'sticky' || pos === 'fixed') pinned++
            const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
            if (text) byText.set(text, (byText.get(text) ?? 0) + 1)
          }
          const dup = Math.max(0, ...Array.from(byText.values()))
          return Math.max(1, dup, pinned)
        })(),
        documentScrolls: doc.scrollHeight > doc.clientHeight + 1,
        documentHeight: doc.scrollHeight,
        viewportHeight: vh,
      }
    })

    const ratio = raw.documentHeight / raw.viewportHeight
    const nearInteger = Math.abs(ratio - Math.round(ratio)) < 0.02 && Math.round(ratio) >= 2

    const issues: string[] = []
    if (raw.innerScrollers > 0) {
      issues.push(
        `ビューポート高に近い内部スクロール容器が ${raw.innerScrollers} 個あります。` +
          'ページはブラウザ自身がスクロールする1本の流れにしてください。',
      )
    }
    if (raw.headers > 1) {
      issues.push(
        `同じヘッダーが ${raw.headers} 回現れます（同じ文面、または sticky/fixed の header が複数）。画面全体のヘッダーは1つだけにしてください。`,
      )
    }
    // 参照が1ビューポートに収まる画面なら、ドキュメントがスクロールしないのは正しい。
    // 高さがぴったり 956px の設定画面で「スクロールしない」と落とし、ターンを1つ無駄にした。
    // 問題なのは「中身が内部の容器に閉じ込められている」ときだけ
    if (!raw.documentScrolls && raw.innerScrollers > 0) {
      issues.push('ドキュメント自身がスクロールしません。中身が内部の容器に閉じ込められています。')
    }
    if (raw.duplicateHeadings.length > 0) {
      issues.push(
        '同じ見出しが複数回出ています: ' +
          raw.duplicateHeadings.map((d) => `「${d.text}」×${d.count}`).join('、') +
          '。参照の状態やスクロール位置ごとにセクションを複製している兆候です。',
      )
    }
    if (nearInteger) {
      issues.push(
        `ページ高さ ${raw.documentHeight}px がビューポート高 ${raw.viewportHeight}px の` +
          `ちょうど ${Math.round(ratio)} 倍です。画面を並べた構成の兆候です。`,
      )
    }

    return {
      innerScrollers: raw.innerScrollers,
      headers: raw.headers,
      documentScrolls: raw.documentScrolls,
      documentHeight: raw.documentHeight,
      viewportMultiple: nearInteger ? Math.round(ratio) : null,
      duplicateHeadings: raw.duplicateHeadings,
      ok: issues.length === 0,
      issues,
    }
  } finally {
    await context.close()
    if (!browser) await own.close()
  }
}

export function describeFlow(f: FlowCheck): string {
  return [
    `高さ ${f.documentHeight}px`,
    `内部スクロール容器 ${f.innerScrollers}`,
    `header ${f.headers}`,
    f.duplicateHeadings.length ? `重複見出し ${f.duplicateHeadings.length}` : '',
    f.ok ? '1本の流れ' : '⚠ 1本の流れになっていない',
  ]
    .filter(Boolean)
    .join(' · ')
}

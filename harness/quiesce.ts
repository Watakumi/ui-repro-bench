import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { SANDBOX_DIR, UI_PACKAGE_SRC } from './config.ts'

/**
 * 実装のファイルが書き換わらなくなるまで待つ。
 *
 * Agent SDK のサブエージェントは既定でバックグラウンド実行されるため、
 * ブレインの query() が返った時点では builder がまだ書いていることがある。
 * 実測（run 2026-09-18T01-07-57）では、ターン5の撮影の98秒後に App.tsx が
 * 更新されており、毎ターン1つ前の状態を測っていた。
 *
 * background: false でも塞いでいるが、SDK の解釈に依存したくないので
 * 撮影の直前にファイルの静止も確認する。
 */

async function latestMtime(dir: string): Promise<number> {
  let latest = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) latest = Math.max(latest, await latestMtime(full))
    else if (/\.(tsx?|css)$/.test(e.name)) {
      latest = Math.max(latest, (await stat(full)).mtimeMs)
    }
  }
  return latest
}

export interface QuiesceResult {
  /** 静止するまでに待った時間(ms) */
  waitedMs: number
  /** 待っている間にファイルが書き換わったか */
  changed: boolean
  /** 上限まで待っても静止しなかったか */
  timedOut: boolean
}

export async function waitForQuiet(
  stableMs = 4000,
  timeoutMs = 180_000,
): Promise<QuiesceResult> {
  const started = Date.now()
  let last = Math.max(
    await latestMtime(path.join(SANDBOX_DIR, 'src')),
    await latestMtime(UI_PACKAGE_SRC),
  )
  let stableSince = Date.now()
  let changed = false

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500))
    const now = Math.max(
      await latestMtime(path.join(SANDBOX_DIR, 'src')),
      await latestMtime(UI_PACKAGE_SRC),
    )
    if (now !== last) {
      last = now
      stableSince = Date.now()
      changed = true
    } else if (Date.now() - stableSince >= stableMs) {
      return { waitedMs: Date.now() - started, changed, timedOut: false }
    }
  }
  return { waitedMs: Date.now() - started, changed, timedOut: true }
}

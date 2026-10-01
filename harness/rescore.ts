import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { RUNS_DIR, findTargetDir, isEntrypoint, loadTarget } from './config.ts'
import type { RunSummary } from './metrics.ts'
import { score } from './score.ts'

/**
 * 保存してあるスクショから、全試行を「いまの指標」で測り直す。
 *
 * 指標を実験の途中で何度か変えたため、metrics.jsonl には世代の違う値が混ざっている。
 * スクショは全部残してあるので、API を呼ばずに揃えられる。
 *
 *   pnpm rescore
 */

export interface Rescored {
  runId: string
  target: string
  finalShot: string
  rawDiff: number
  layoutDiff: number
  layoutMad: number
}

export async function rescoreAll(): Promise<Rescored[]> {
  const out: Rescored[] = []
  const dir = path.join(RUNS_DIR, '_report', 'rescore')
  await mkdir(dir, { recursive: true })

  for (const name of (await readdir(RUNS_DIR).catch(() => [])).sort()) {
    const runDir = path.join(RUNS_DIR, name)
    const raw = await readFile(path.join(runDir, 'summary.json'), 'utf8').catch(() => null)
    if (!raw) continue
    const s = JSON.parse(raw) as RunSummary

    // 既定状態の最終スクショだけを見る（状態別は別途）
    const shots = (await readdir(runDir))
      .filter((f) => /^turn-\d+\.png$/.test(f))
      .sort()
    const last = shots.at(-1)
    if (!last) continue

    const targetDir = await findTargetDir(s.target)
    const target = targetDir ? await loadTarget(targetDir).catch(() => null) : null
    if (!target) continue

    const r = await score({
      referencePath: target.referencePath,
      candidatePath: path.join(runDir, last),
      rawDiffPath: path.join(dir, `${s.runId}.raw.png`),
      layoutDiffPath: path.join(dir, `${s.runId}.layout.png`),
    })
    out.push({
      runId: s.runId,
      target: s.target,
      finalShot: last,
      rawDiff: r.rawDiff,
      layoutDiff: r.layoutDiff,
      layoutMad: r.layoutMad,
    })
  }

  await writeFile(
    path.join(RUNS_DIR, '_report', 'rescored.json'),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8',
  )
  return out
}

async function main(): Promise<void> {
  const rows = await rescoreAll()
  console.log('いまの指標で測り直しました（API呼び出しなし）\n')
  console.log('run                        layoutMad   layoutDiff   rawDiff')
  for (const r of rows) {
    console.log(
      `${r.runId.replace(/^\d{4}-/, '').slice(0, 17).padEnd(20)} ` +
        `${(r.layoutMad * 100).toFixed(4).padStart(9)}%  ` +
        `${(r.layoutDiff * 100).toFixed(2).padStart(9)}%  ` +
        `${(r.rawDiff * 100).toFixed(2).padStart(7)}%`,
    )
  }
  console.log(`\n${path.join(RUNS_DIR, '_report', 'rescored.json')}`)
}

if (isEntrypoint(import.meta.url)) await main()

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { RUNS_DIR, findTargetDir, isEntrypoint, loadTarget } from './config.ts'
import { judge } from './judge.ts'

/**
 * 同じ成果物を何度も採点させて、judge のぶれを測る。
 *
 * 「judge も LLM。採点はぶれないのか」は必ず聞かれる。
 * ぶれ幅が条件間の差より大きければ、judge のスコアで条件を比べてはいけない。
 *
 *   pnpm judge:repeat <runId> [回数]
 */
async function main(): Promise<void> {
  const runId = process.argv[2]
  const times = Number(process.argv[3] ?? 3)
  if (!runId) {
    console.error('使い方: pnpm judge:repeat <runId> [回数]')
    process.exit(1)
  }
  const runDir = path.join(RUNS_DIR, runId)
  const entries = await readdir(runDir)
  const summary = JSON.parse(
    await (await import('node:fs/promises')).readFile(path.join(runDir, 'summary.json'), 'utf8'),
  ) as { target: string }
  const targetDir = await findTargetDir(summary.target)
  if (!targetDir) throw new Error(`ターゲットが見つかりません: ${summary.target}`)
  const target = await loadTarget(targetDir)

  // 断片モードなら全断片、そうでなければ既定状態の最終ショット
  const turnDirs = entries.filter((f) => /^turn-\d+$/.test(f)).sort()
  const lastTurnDir = turnDirs.at(-1)
  const pairs = lastTurnDir
    ? (await readdir(path.join(runDir, lastTurnDir)))
        .filter((f) => /^slice-\d+\.png$/.test(f))
        .sort()
        .map((f) => ({
          name: f.replace('.png', ''),
          referencePath: path.join(targetDir, f),
          candidatePath: path.join(runDir, lastTurnDir, f),
        }))
    : [
        {
          name: 'default',
          referencePath: target.referencePath,
          candidatePath: path.join(
            runDir,
            entries.filter((f) => /^turn-\d+\.png$/.test(f)).sort().at(-1)!,
          ),
        },
      ]

  console.log(`${runId} を ${times} 回採点します（対 ${pairs.length} 組）\n`)
  const keys = ['layout', 'spacing', 'typography', 'color', 'components'] as const
  const runs: Record<string, number>[] = []
  for (let i = 0; i < times; i++) {
    const r = await judge({ pairs, sourcePath: path.join(runDir, 'App.final.tsx') })
    runs.push(r.verdict.scores as Record<string, number>)
    console.log(
      `  ${i + 1}回目  ` +
        keys.map((k) => `${k.slice(0, 4)} ${String(r.verdict.scores[k] ?? '-').padStart(3)}`).join('  ') +
        `  pass ${r.verdict.pass}  blocking ${r.verdict.blocking.length}`,
    )
  }

  console.log('\n項目       最小  最大   幅')
  for (const k of keys) {
    const v = runs.map((r) => r[k] ?? 0)
    console.log(`${k.padEnd(12)} ${Math.min(...v)}  ${Math.max(...v)}  ${Math.max(...v) - Math.min(...v)}`)
  }
  const means = runs.map((r) => keys.reduce((a, k) => a + (r[k] ?? 0), 0) / keys.length)
  console.log(
    `\n平均点のぶれ: ${Math.min(...means).toFixed(1)} 〜 ${Math.max(...means).toFixed(1)}` +
      `（幅 ${(Math.max(...means) - Math.min(...means)).toFixed(1)} 点）`,
  )
}

if (isEntrypoint(import.meta.url)) await main()

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { RUNS_DIR, isEntrypoint } from './config.ts'
import type { TurnMetric } from './metrics.ts'

/**
 * どの関門が実際に何回落としたかを数える。
 *
 * 関門は増やすばかりで、効いているかを一度も数えていなかった。
 * 数えたら、rawDiff は 97.8% が閾値内（何も止めていない）、
 * 絶対配置の関門は137ターンで発火0回だった。
 * 止めていない検査を並べておくと「5段のゲートで守っている」と誤解する。
 *
 *   pnpm audit:gates
 */
interface GateStat {
  name: string
  fired: number
  rate: number
  note: string
}

export async function auditGates(): Promise<{ turns: number; gates: GateStat[] }> {
  const metrics: TurnMetric[] = []
  for (const name of (await readdir(RUNS_DIR).catch(() => [])).sort()) {
    const dir = path.join(RUNS_DIR, name)
    if (await readFile(path.join(dir, 'FAILURE.txt'), 'utf8').then(() => true, () => false)) continue
    const raw = await readFile(path.join(dir, 'metrics.jsonl'), 'utf8').catch(() => '')
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      metrics.push(JSON.parse(line) as TurnMetric)
    }
  }
  const n = metrics.length || 1
  const count = (f: (m: TurnMetric) => boolean): number => metrics.filter(f).length

  const gates: GateStat[] = [
    {
      name: 'ピクセル(layoutDiff)',
      fired: count((m) => m.layoutDiff > 0.01),
      rate: 0,
      note: '落ちたターンの中央値 0.94%。閾値1%は効いている',
    },
    {
      name: 'ピクセル(rawDiff)',
      fired: count((m) => m.rawDiff > 0.3),
      rate: 0,
      note: 'フォント差で下がらない指標に甘い閾値。合否からは外した',
    },
    {
      name: 'フロー',
      fired: count((m) => m.flow?.ok === false),
      rate: 0,
      note: '画面の複製・内部スクロールを捕まえる',
    },
    {
      name: '構造(絶対配置)',
      fired: count((m) => m.structure?.tracing === true),
      rate: 0,
      note: '保険。プロンプトで先に防いでいるので発火しない',
    },
    {
      name: '部品(Radix/連番)',
      fired: count(
        (m) =>
          (m.components?.radixExpectedMissing?.length ?? 0) > 0 ||
          (m.components?.numberedVariants?.length ?? 0) > 0,
      ),
      rate: 0,
      note: '期待した primitive の未使用を捕まえる',
    },
    {
      name: '審査(judge)',
      fired: count((m) => m.judge?.pass === false),
      rate: 0,
      note: '上の関門を通ったターンだけが対象',
    },
  ].map((g) => ({ ...g, rate: g.fired / n }))

  return { turns: metrics.length, gates }
}

async function main(): Promise<void> {
  const { turns, gates } = await auditGates()
  console.log(`\n全ターン ${turns}\n`)
  console.log('関門                  発火   割合   所見')
  console.log('─'.repeat(88))
  for (const g of gates) {
    const flag = g.fired === 0 ? ' ←一度も発火していない' : ''
    console.log(
      `${g.name.padEnd(20)} ${String(g.fired).padStart(4)} ${(g.rate * 100).toFixed(1).padStart(6)}%   ${g.note}${flag}`,
    )
  }
  const dead = gates.filter((g) => g.fired === 0)
  if (dead.length) {
    console.log(`\n発火 0 の関門が ${dead.length} 件あります。保険として残すなら、資料にもそう書くこと。`)
  }
}

if (isEntrypoint(import.meta.url)) await main()

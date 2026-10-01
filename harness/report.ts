import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, RUNS_DIR, isEntrypoint } from './config.ts'
import type { RunSummary, TurnMetric } from './metrics.ts'
import { loadTrace } from './trace.ts'

/**
 * 試行を横断して並べる。知見の版ごとに何が変わったかを見るためのもの。
 *
 *   pnpm report [--target <slug>] [--json <出力先>]
 */

export interface RunRow {
  runId: string
  target: string
  promptVersion: string
  startedAt: string
  converged: boolean
  turnsToConverge: number | null
  turnsRun: number
  bestLayoutDiff: number
  firstTurnLayoutDiff: number | null
  /** 1ターン目の layoutMad（飽和しない指標） */
  firstTurnMad: number | null
  /** 最良の layoutMad */
  bestLayoutMad: number | null
  outputTokens: number
  cacheReadTokens: number
  estCostUsd: number
  judgeScores: Record<string, number> | null
  durationMin: number
  libraryBefore: number
  libraryAfter: number
  libraryVersion: string
  knowledge: string
  variant: string
  /** 過去の試行・知見原本・他ターゲットから隔離して回したか（H-20 以降） */
  isolated: boolean
  /** ハーネス側の失敗（FAILURE.txt の本文）。エージェントの未収束とは区別する */
  harnessFailure: string | null
  /** 1ターン目の内側で brain と builder がやりとりした回数（SDK の num_turns） */
  innerTurnsFirst: number | null
  /** 全ターンの内側のやりとりの合計 */
  innerTurnsTotal: number
  /** builder への呼び出し回数（SDKログ由来。作業量の代理） */
  builderCalls: number | null
  /** Bash の起動回数（probe/capture/scan の代理） */
  bashCalls: number | null
}

export async function collectRuns(targetFilter?: string): Promise<RunRow[]> {
  const entries = await readdir(RUNS_DIR).catch(() => [])
  const trace = await loadTrace()
  const rows: RunRow[] = []

  for (const name of entries) {
    const dir = path.join(RUNS_DIR, name)
    const raw = await readFile(path.join(dir, 'summary.json'), 'utf8').catch(() => null)
    if (!raw) continue
    const s = JSON.parse(raw) as RunSummary
    if (targetFilter && s.target !== targetFilter) continue

    const failure = await readFile(path.join(dir, 'FAILURE.txt'), 'utf8').catch(() => null)
    const metricsRaw = await readFile(path.join(dir, 'metrics.jsonl'), 'utf8').catch(() => '')
    const metrics = metricsRaw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TurnMetric)

    rows.push({
      runId: s.runId,
      target: s.target,
      // 版を記録する前の試行があるので、無い場合は明示する
      promptVersion: s.promptVersion ?? '(記録なし)',
      startedAt: s.startedAt,
      converged: s.converged,
      turnsToConverge: s.turnsToConverge,
      turnsRun: s.turnsRun,
      bestLayoutDiff: s.best.layoutDiff,
      firstTurnLayoutDiff: metrics[0]?.layoutDiff ?? null,
      firstTurnMad: metrics[0]?.layoutMad ?? null,
      bestLayoutMad: metrics.reduce<number | null>((a, m) => (a === null || m.layoutMad < a ? m.layoutMad : a), null),
      // usage は brain の主ループだけで builder を含まない（SDK の仕様）。
      // modelUsage がある試行はそちらの合計を使う
      outputTokens: metrics.some((m) => m.modelUsage)
        ? metrics.reduce(
            (a, m) => a + Object.values(m.modelUsage ?? {}).reduce((b, v) => b + v.outputTokens, 0),
            0,
          )
        : s.totals.output_tokens,
      cacheReadTokens: s.totals.cache_read_input_tokens,
      estCostUsd: s.totals.total_cost_usd + (s.judgeTotals?.total_cost_usd ?? 0),
      judgeScores: metrics.find((m) => m.judge)?.judge?.scores ?? null,
      durationMin: (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 60000,
      libraryBefore: s.libraryComponentsBefore ?? 0,
      libraryAfter: s.libraryComponentsAfter ?? 0,
      libraryVersion: s.libraryVersionAfter ?? '-',
      harnessFailure: failure ? failure.trim().split('\n').filter(Boolean).at(-1) ?? '失敗' : null,
      innerTurnsFirst: metrics[0]?.num_turns ?? null,
      innerTurnsTotal: metrics.reduce((a, m) => a + (m.num_turns ?? 0), 0),
      builderCalls: trace[name]?.builderCalls ?? null,
      bashCalls: trace[name]?.bashCalls ?? null,
      // 条件を記録する前の試行は、プロンプト版から推定できる範囲だけ埋める
      knowledge: s.conditions?.knowledge ?? (s.promptVersion === '76c4982430d9' ? 'none' : '?'),
      variant: s.conditions?.variant ?? '?',
      isolated: s.conditions?.isolated ?? false,
    })
  }

  return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}


export interface ConditionStat {
  target: string
  knowledge: string
  variant: string
  isolated: boolean
  libraryBefore: number
  n: number
  converged: number
  turns: number[]
  median: number | null
  avgCostUsd: number
  /** 収束した試行の builder 呼び出しの平均（作業量） */
  avgBuilderCalls: number | null
  /** 1ターン目の layoutMad の平均。知見が「初手の精度」を上げるかを見る */
  avgFirstMad: number | null
  /** 最終 layoutMad の平均。収束後の品質 */
  avgFinalMad: number | null
  /** judge の5項目の平均 */
  avgJudge: number | null
  broken: number
}

/**
 * ターゲットごと・条件ごとに集計する。
 * 規模も難易度も違う別問題なので、ターゲットをまたいだターン数の比較は成立しない。
 * ハーネスの失敗（スリープ・ハング・サーバ落ち）はエージェントの成績に入れない。
 */
/** null を除いた平均。1件も無ければ null */
function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

export function aggregate(rows: RunRow[]): ConditionStat[] {
  const out: ConditionStat[] = []
  const byTarget = new Map<string, RunRow[]>()
  for (const r of rows) byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r])
  for (const [target, list] of byTarget) {
    const byCondition = new Map<string, RunRow[]>()
    for (const r of list) {
      const key = `${r.knowledge}|${r.variant}|${r.libraryBefore}|${r.isolated}`
      byCondition.set(key, [...(byCondition.get(key) ?? []), r])
    }
    for (const allRuns of byCondition.values()) {
      const broken = allRuns.filter((r) => r.harnessFailure)
      const group = allRuns.filter((r) => !r.harnessFailure)
      const conv = group.filter((r) => r.converged)
      const turns = conv.map((r) => r.turnsToConverge ?? r.turnsRun).sort((a, b) => a - b)
      const median = turns.length
        ? turns.length % 2
          ? turns[(turns.length - 1) / 2]!
          : (turns[turns.length / 2 - 1]! + turns[turns.length / 2]!) / 2
        : null
      const first = allRuns[0]!
      out.push({
        target,
        knowledge: first.knowledge,
        variant: first.variant,
        isolated: first.isolated,
        libraryBefore: first.libraryBefore,
        n: group.length,
        converged: conv.length,
        turns,
        median,
        avgCostUsd: conv.reduce((a, r) => a + r.estCostUsd, 0) / (conv.length || 1),
        avgBuilderCalls: conv.some((r) => r.builderCalls !== null)
          ? conv.reduce((a, r) => a + (r.builderCalls ?? 0), 0) / conv.length
          : null,
        avgFirstMad: mean(conv.map((r) => r.firstTurnMad)),
        avgFinalMad: mean(conv.map((r) => r.bestLayoutMad)),
        avgJudge: mean(
          conv.map((r) =>
            r.judgeScores ? Object.values(r.judgeScores).reduce((a, b) => a + b, 0) / Object.values(r.judgeScores).length : null,
          ),
        ),
        broken: broken.length,
      })
    }
  }
  return out
}

function pct(v: number | null): string {
  return v === null ? '   -  ' : `${(v * 100).toFixed(2)}%`
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main(): Promise<void> {
  const rows = await collectRuns(flag('target'))
  if (rows.length === 0) {
    console.log('試行がまだありません。')
    return
  }

  console.log('')
  console.log('run                  版            部品     収束  ターン  1回目→最良      出力tok   推定$   分')
  console.log('─'.repeat(104))
  for (const r of rows) {
    const shortId = r.runId.replace(/^\d{4}-/, '').slice(0, 17)
    console.log(
      `${shortId.padEnd(19)} ${r.promptVersion.slice(0, 12).padEnd(13)} ` +
        `${`${r.libraryBefore}→${r.libraryAfter}`.padStart(6)}   ` +
        `${(r.converged ? '✔' : '✖').padEnd(4)} ` +
        `${String(r.turnsToConverge ?? r.turnsRun).padStart(4)}   ` +
        `${pct(r.firstTurnLayoutDiff)}→${pct(r.bestLayoutDiff)}  ` +
        `${String(r.outputTokens).padStart(7)}  ` +
        `${r.estCostUsd.toFixed(2).padStart(6)}  ${r.durationMin.toFixed(0).padStart(3)}`,
    )
  }

  // ターゲットごと・条件ごとの集計
  let current = ''
  for (const c of aggregate(rows)) {
    if (c.target !== current) {
      current = c.target
      console.log('')
      console.log(`■ ${c.target}（${rows.filter((r) => r.target === c.target).length}件）`)
      console.log('─'.repeat(104))
    }
    const cond = `知見=${c.knowledge} 変種=${c.variant} 隔離=${c.isolated ? 'あり' : 'なし'}`
    console.log(
      `  ${cond.padEnd(34)} n=${c.n}  収束 ${c.converged}/${c.n}  ` +
        `ターン ${c.turns.length ? c.turns.join(',') : '-'}  ` +
        `中央値 ${c.median ?? '-'}  ` +
        `平均 $${c.avgCostUsd.toFixed(2)}  ` +
        `builder ${c.avgBuilderCalls === null ? '-' : c.avgBuilderCalls.toFixed(0)}回  ` +
        `初手 ${c.avgFirstMad === null ? '-' : `${(c.avgFirstMad * 100).toFixed(2)}%`} → ` +
        `最終 ${c.avgFinalMad === null ? '-' : `${(c.avgFinalMad * 100).toFixed(2)}%`}  ` +
        `judge ${c.avgJudge === null ? '-' : c.avgJudge.toFixed(1)}` +
        (c.broken ? `  （ほかにハーネス失敗 ${c.broken}）` : ''),
    )
  }

  console.log('')

  const jsonOut = flag('json')
  if (jsonOut) {
    await writeFile(path.resolve(ROOT, jsonOut), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
    console.log(`JSON: ${path.resolve(ROOT, jsonOut)}`)
  }
}

if (isEntrypoint(import.meta.url)) await main()

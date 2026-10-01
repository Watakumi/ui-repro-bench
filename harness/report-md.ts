import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, isEntrypoint } from './config.ts'
import { auditGates } from './audit-gates.ts'
import { aggregate, collectRuns, type ConditionStat } from './report.ts'

/**
 * 結果を Markdown で書き出す。
 *
 * 画像つきの資料は別にあるが、参照スクリーンショットは第三者の UI なので
 * リポジトリでは配布しない。こちらは数値と表だけで、GitHub 上でそのまま読めて
 * 差分も追える。数字は資料と同じ集計関数から取るので食い違わない。
 *
 *   pnpm report:md
 */
const OUT = path.join(ROOT, 'docs', 'RESULTS.md')

const KNOWLEDGE_LABEL: Record<string, string> = {
  none: 'なし',
  general: '汎用のみ',
  full: '汎用＋固有',
  cold: '汎用のみ(旧称)',
  hot: '汎用＋固有(旧称)',
  '?': '記録なし',
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`)

function conditionTable(stats: ConditionStat[]): string {
  const head =
    '| 知見 | 隔離 | n | 収束 | ターン | 中央値 | 初手の誤差 | 最終の誤差 | 平均$ | builder |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  const rows = stats.map((c) => {
    const cells = [
      KNOWLEDGE_LABEL[c.knowledge] ?? c.knowledge,
      c.isolated ? 'あり' : 'なし',
      String(c.n),
      `${c.converged}/${c.n}`,
      c.turns.join(', ') || '—',
      c.median === null ? '—' : String(c.median),
      pct(c.avgFirstMad),
      pct(c.avgFinalMad),
      `$${c.avgCostUsd.toFixed(2)}`,
      c.avgBuilderCalls === null ? '—' : c.avgBuilderCalls.toFixed(0),
    ]
    return `| ${cells.join(' | ')} |`
  })
  return [head, ...rows].join('\n')
}

export async function buildMarkdownReport(): Promise<string> {
  const rows = await collectRuns()
  const stats = aggregate(rows)
  const { turns, gates } = await auditGates()

  const scored = rows.filter((r) => !r.harnessFailure)
  const converged = scored.filter((r) => r.converged)
  const broken = rows.length - scored.length
  const targets = [...new Set(rows.map((r) => r.target))]

  const byTarget = targets
    .map((t) => ({
      target: t,
      n: scored.filter((r) => r.target === t).length,
      stats: stats.filter((c) => c.target === t),
    }))
    .sort((a, b) => b.n - a.n)

  const lines: string[] = [
    '# 結果',
    '',
    '`pnpm report:md` が生成する。手で書き換えない。',
    '',
    `生成日 ${new Date().toISOString().slice(0, 10)} ／ 試行 ${scored.length}（ハーネス失敗 ${broken} 件を除く）` +
      ` ／ 収束 ${converged.length} ／ ターゲット ${targets.length}`,
    '',
    '参照UIと成果物を並べた画像つきの資料は別にある。ここは数値だけ。',
    '',
    '## 読み方',
    '',
    '- **ターン**はハーネスが差分を突き返した回数。LLM の呼び出し回数ではない',
    '- **初手の誤差 / 最終の誤差**は `layoutMad`（グレースケール化＋ぼかしの平均絶対差）',
    '- **builder** は1試行あたりの builder 呼び出し回数。外側のターン数では見えない作業量が出る',
    '- **$** は SDK 内蔵の定価による推定で、請求額ではない。試行間の相対比較にだけ使う',
    '- 比較が成立するのは**同じターゲット・同じ隔離状態・同じプロンプト世代・同じモデル**の中だけ',
    '- 隔離なしの行は、エージェントが過去の試行や抽出結果に届き得た状態で回したもの（参考）',
    '',
    '## ターゲット別',
    '',
  ]

  for (const { target, n, stats: s } of byTarget) {
    lines.push(`### ${target}（${n} 試行）`, '', conditionTable(s), '')
  }

  lines.push(
    '## 関門の効き',
    '',
    `全 ${turns} ターンで、どの関門が何回落としたか。`,
    '',
    '| 関門 | 発火 | 割合 | 所見 |',
    '| --- | --- | --- | --- |',
    ...gates.map(
      (g) =>
        `| ${g.name} | ${g.fired} | ${(g.rate * 100).toFixed(1)}% | ${g.note}` +
        `${g.fired === 0 ? ' **（一度も発火していない）**' : ''} |`,
    ),
    '',
    '関門を増やすばかりで効きを数えていなかった、というのが失敗カタログの H-28。',
    '発火が少ないことは外す理由にならない。外してよいのは、',
    'ほかの関門と守備範囲が重なっていると示せたときだけで、',
    'それは発火回数ではなく「その指標が何を捨てているか」で決まる。',
    '',
    '## 失敗カタログ',
    '',
    '[`harness/knowledge/FAILURES.md`](../harness/knowledge/FAILURES.md) に全文がある。',
    'G はエージェントが指標をすり抜けた事例、H は計測する側の欠陥。',
    '',
  )

  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(OUT, `${lines.join('\n')}\n`, 'utf8')
  return OUT
}

async function main(): Promise<void> {
  const out = await buildMarkdownReport()
  console.log(path.relative(ROOT, out))
}

if (isEntrypoint(import.meta.url)) await main()

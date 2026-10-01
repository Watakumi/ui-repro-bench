import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadLearnings, buildAgents, promptVersion } from './agents.ts'
import { RUNS_DIR, isEntrypoint } from './config.ts'
import { reflectOnRun } from './reflect.ts'
import { runTrial } from './run.ts'

/**
 * 試行 → 振り返り → 試行 …… を繰り返す。
 * 知見が増えるにつれて必要ターン数がどう変わるかを見るためのもの。
 *
 *   pnpm campaign targets/<slug> [周回数] [--repeat 3]
 *
 * --repeat を付けると、同じ知見の版で複数回まわしてから振り返る。
 * n=1 だとターン数の差が効果なのか偶然なのか区別できないため、
 * ばらつきを測るにはこれが要る。
 *
 * 各試行は、その時点の知見の版で走る。版は summary.json に記録されるので、
 * あとから `pnpm report` で推移を並べられる。
 */

interface Iteration {
  index: number
  runDirs: string[]
  turns: number[]
  promptVersionUsed: string
  promptVersionAfter: string
  knowledgeChanged: boolean
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

async function turnsOf(runDir: string): Promise<number> {
  const raw = await readFile(path.join(runDir, 'summary.json'), 'utf8').catch(() => null)
  if (!raw) return Number.NaN
  const s = JSON.parse(raw) as { turnsToConverge: number | null; turnsRun: number }
  return s.turnsToConverge ?? s.turnsRun
}

async function main(): Promise<void> {
  const target = process.argv[2]
  const rounds = Number(process.argv[3] ?? 3)
  const repeat = Number(flag('repeat', '1'))
  if (!target) {
    console.error('使い方: pnpm campaign targets/<slug> [回数]')
    process.exit(1)
  }

  const campaignId = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const iterations: Iteration[] = []

  for (let i = 1; i <= rounds; i++) {
    const used = promptVersion(buildAgents(await loadLearnings()))
    console.log(`\n${'='.repeat(70)}`)
    console.log(`周回 ${i}/${rounds}   知見の版: ${used}`)
    console.log('='.repeat(70))

    // 同じ版で repeat 回まわす。ばらつきを見るため。
    const runDirs: string[] = []
    const turns: number[] = []
    for (let r = 1; r <= repeat; r++) {
      if (repeat > 1) console.log(`\n-- 反復 ${r}/${repeat} --`)
      try {
        const dir = await runTrial(target)
        runDirs.push(dir)
        turns.push(await turnsOf(dir))
      } catch (error) {
        // 1回の失敗でキャンペーン全体を落とさない。
        // 90分の実行が撮影1回の失敗で全損するのは割に合わない。
        console.error(`  ! 反復 ${r} が失敗しました: ${String(error).slice(0, 160)}`)
        turns.push(Number.NaN)
      }
    }

    if (repeat > 1) {
      const valid = turns.filter((t) => Number.isFinite(t))
      const mean = valid.reduce((a, b) => a + b, 0) / (valid.length || 1)
      console.log(
        `\n周回 ${i} のターン数: ${turns.join(', ')}  平均 ${mean.toFixed(1)} / 最小 ${Math.min(...valid)} / 最大 ${Math.max(...valid)}`,
      )
    }

    if (runDirs.length === 0) {
      console.error(`  ! 周回 ${i} は全反復が失敗しました。振り返りを飛ばします。`)
      iterations.push({
        index: i,
        runDirs: [],
        turns,
        promptVersionUsed: used,
        promptVersionAfter: used,
        knowledgeChanged: false,
      })
      continue
    }

    console.log(`\n${'-'.repeat(70)}`)
    console.log(`周回 ${i}/${rounds} の振り返り`)
    console.log('-'.repeat(70))
    // 最もターンを要した試行を振り返る。そこに学ぶものが多いため。
    const finite = turns.filter(Number.isFinite)
    const hardestIndex = finite.length ? turns.indexOf(Math.max(...finite)) : 0
    const hardest = runDirs[Math.min(hardestIndex, runDirs.length - 1)] ?? runDirs[0]!
    const reflected = await reflectOnRun(hardest).catch((e) => {
      console.error(`  ! 振り返りが失敗しました: ${String(e).slice(0, 160)}`)
      return { before: used, after: used, changed: false }
    })

    iterations.push({
      index: i,
      runDirs: runDirs.map((d) => path.relative(RUNS_DIR, d)),
      turns,
      promptVersionUsed: used,
      promptVersionAfter: reflected.after,
      knowledgeChanged: reflected.changed,
    })
  }

  const outDir = path.join(RUNS_DIR, '_campaigns')
  await mkdir(outDir, { recursive: true })
  const outFile = path.join(outDir, `${campaignId}.json`)
  await writeFile(outFile, `${JSON.stringify({ campaignId, target, iterations }, null, 2)}\n`, 'utf8')

  console.log(`\n${'='.repeat(70)}`)
  console.log('周回の記録')
  for (const it of iterations) {
    console.log(
      `  ${it.index}: ターン ${it.turns.join('/')}  ${it.promptVersionUsed} → ${it.promptVersionAfter}${it.knowledgeChanged ? '' : ' (知見に変化なし)'}`,
    )
  }
  console.log(`\n${outFile}`)
  console.log('推移を見る: pnpm report')
}

if (isEntrypoint(import.meta.url)) await main()

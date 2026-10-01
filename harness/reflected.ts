import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, RUNS_DIR } from './config.ts'

/**
 * どの試行をまだ振り返っていないかを覚えておく。
 *
 * 失敗カタログ（FAILURES.md）は毎回書き足していたのに、エージェントに渡す知見
 * （LEARNINGS.md）は4日間・約30試行ぶん放置されていた。cold 条件が測っていたのは
 * 「4日前の知見」で、そのあいだ judge の指摘は誰にも読まれずに捨てられていた。
 *
 * 忘れないようにする、ではなく、忘れられないようにする。
 * 未反映が溜まると selftest が落ちるので、バッチを始める前に必ず気づく。
 */
const STATE = path.join(ROOT, 'harness', 'knowledge', 'reflected.json')

/** これ以上溜まったら selftest を通さない */
export const PENDING_LIMIT = 12

interface State {
  runIds: string[]
}

async function load(): Promise<State> {
  const raw = await readFile(STATE, 'utf8').catch(() => null)
  return raw ? (JSON.parse(raw) as State) : { runIds: [] }
}

export async function markReflected(runId: string): Promise<void> {
  const s = await load()
  if (!s.runIds.includes(runId)) s.runIds.push(runId)
  await writeFile(STATE, `${JSON.stringify(s, null, 2)}\n`, 'utf8')
}

/**
 * 振り返るべきなのに、まだ振り返っていない試行。
 * 収束したものだけを見る（ハーネスが落ちた試行から学べることは FAILURES.md 側の話）。
 */
export async function pendingRuns(): Promise<string[]> {
  const done = new Set((await load()).runIds)
  const out: string[] = []
  for (const name of (await readdir(RUNS_DIR).catch(() => [])).sort()) {
    if (name.startsWith('_') || done.has(name)) continue
    const dir = path.join(RUNS_DIR, name)
    const raw = await readFile(path.join(dir, 'summary.json'), 'utf8').catch(() => null)
    if (!raw) continue
    const failed = await readFile(path.join(dir, 'FAILURE.txt'), 'utf8').catch(() => null)
    if (failed) continue
    if (!(JSON.parse(raw) as { converged?: boolean }).converged) continue
    out.push(name)
  }
  return out
}

/**
 * 仕組みを入れる前の試行まで遡って振り返るのは現実的でないので、
 * 導入時点より古いものは「済み」として畳む。
 */
export async function seedReflected(before: string): Promise<number> {
  const s = await load()
  let n = 0
  for (const name of (await readdir(RUNS_DIR).catch(() => [])).sort()) {
    if (name.startsWith('_') || name >= before || s.runIds.includes(name)) continue
    s.runIds.push(name)
    n++
  }
  await writeFile(STATE, `${JSON.stringify(s, null, 2)}\n`, 'utf8')
  return n
}

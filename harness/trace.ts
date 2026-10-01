import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { RUNS_DIR, isEntrypoint } from './config.ts'

/**
 * 1ターンの内側で何回やりとりしたかを、SDK のデバッグログから数える。
 *
 * ハーネスが数える「ターン」は差分を突き返した回数（外側）で、
 * 実際の作業量は1ターンの内側にある。内側は brain → builder → Bash（probe/capture/scan）の
 * 繰り返しなので、builder への呼び出し回数と Bash の起動回数が作業量の代理になる。
 *
 * ログは1試行あたり数MBあるので、毎回の集計では読まずにここで1度だけ数えて JSON に落とす。
 *
 *   pnpm trace
 */
export interface Trace {
  brainCalls: number
  builderCalls: number
  bashCalls: number
}

export async function buildTrace(): Promise<Record<string, Trace>> {
  const out: Record<string, Trace> = {}
  for (const name of (await readdir(RUNS_DIR).catch(() => [])).sort()) {
    const log = path.join(RUNS_DIR, name, 'sdk-debug.log')
    const txt = await readFile(log, 'utf8').catch(() => null)
    if (!txt) continue
    let brainCalls = 0
    let builderCalls = 0
    for (const m of txt.matchAll(/\[API REQUEST\].*?source=(\S+)/g)) {
      if (m[1] === 'sdk') brainCalls++
      else if (m[1] === 'agent:custom:builder') builderCalls++
    }
    // Bash ツールの実行ごとにシェルが立つ。probe / capture / scan の回数の代理
    const bashCalls = (txt.match(/Spawning shell/g) ?? []).length
    out[name] = { brainCalls, builderCalls, bashCalls }
  }
  await mkdir(path.join(RUNS_DIR, '_report'), { recursive: true })
  await writeFile(
    path.join(RUNS_DIR, '_report', 'trace.json'),
    `${JSON.stringify(out, null, 2)}\n`,
    'utf8',
  )
  return out
}

export async function loadTrace(): Promise<Record<string, Trace>> {
  const raw = await readFile(path.join(RUNS_DIR, '_report', 'trace.json'), 'utf8').catch(() => null)
  return raw ? (JSON.parse(raw) as Record<string, Trace>) : {}
}

async function main(): Promise<void> {
  const t = await buildTrace()
  const n = Object.keys(t).length
  console.log(`${n} 試行のログを数えました → ${path.join(RUNS_DIR, '_report', 'trace.json')}`)
}

if (isEntrypoint(import.meta.url)) await main()

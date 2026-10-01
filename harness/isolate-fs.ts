import { mkdirSync, readdirSync, renameSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, RUNS_DIR, isEntrypoint } from './config.ts'

/**
 * 試行のあいだだけ、見せたくないものをリポジトリの外へ移す。
 *
 * PreToolUse フックでの隔離は成立しなかった。brain のエンジンターンが終わると
 * 制御ストリームが閉じ、まだ動いている builder のツール呼び出しが
 * 「許可済みのパスまで」拒否される（H-26）。Opus では8本中1本、
 * Sonnet では3本中3本が死んだ。拒否の可否以前の問題なので、フックでは直せない。
 *
 * 代わりに、**そもそも存在しない状態**にする。移動なので取り消せる。
 * 何をどこへ移したかは manifest に書き、異常終了しても
 * `pnpm isolate:restore` で戻せるようにしてある。
 */
const HIDDEN_ROOT = path.join(os.tmpdir(), 'ui-bench-hidden')
const MANIFEST = path.join(HIDDEN_ROOT, 'manifest.json')

interface Moved {
  from: string
  to: string
}

function collect(slug: string, currentRunId: string): string[] {
  const out: string[] = []
  const add = (p: string): void => {
    if (existsSync(p)) out.push(p)
  }

  // 知見の原本（渡す分はすでにメモリに読んである）
  add(path.join(ROOT, 'harness', 'knowledge'))
  // 部品ライブラリのスナップショット
  add(path.join(ROOT, 'packages', 'ui', '.snapshots'))

  // ほかのターゲット一式と、このターゲットの抽出結果（答案）
  const targetsDir = path.join(ROOT, 'targets')
  for (const name of readdirSync(targetsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    if (name.name === slug) {
      add(path.join(targetsDir, slug, 'extracted.json'))
      continue
    }
    add(path.join(targetsDir, name.name))
  }

  // 過去の試行の成果物。summary / metrics は集計に要るので残し、
  // 「答え」になるものだけ隠す
  for (const name of readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name === currentRunId || name.name.startsWith('_')) continue
    add(path.join(RUNS_DIR, name.name, 'App.final.tsx'))
    add(path.join(RUNS_DIR, name.name, 'lib'))
  }
  return out
}

/** 隠す。戻す関数を返す */
export function hideSecrets(slug: string, currentRunId: string): () => void {
  const moved: Moved[] = []
  mkdirSync(HIDDEN_ROOT, { recursive: true })

  for (const from of collect(slug, currentRunId)) {
    const to = path.join(HIDDEN_ROOT, path.relative(ROOT, from))
    mkdirSync(path.dirname(to), { recursive: true })
    try {
      renameSync(from, to)
      moved.push({ from, to })
    } catch {
      // 移せないものは諦める。隠せた分だけでも減らす
    }
  }
  writeFileSync(MANIFEST, `${JSON.stringify(moved, null, 2)}\n`, 'utf8')

  let done = false
  const restore = (): void => {
    if (done) return
    done = true
    for (const m of [...moved].reverse()) {
      try {
        mkdirSync(path.dirname(m.from), { recursive: true })
        renameSync(m.to, m.from)
      } catch {
        // 個別の失敗は握りつぶす。manifest が残るので手で戻せる
      }
    }
    try {
      rmSync(MANIFEST, { force: true })
    } catch {
      /* noop */
    }
  }

  // 異常終了でも戻す。戻し忘れるとリポジトリが壊れたように見える
  process.once('exit', restore)
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      restore()
      process.exit(130)
    })
  process.once('uncaughtException', (e) => {
    restore()
    throw e
  })
  return restore
}

/** 異常終了で戻らなかったものを手で戻す */
export function restoreFromManifest(): number {
  if (!existsSync(MANIFEST)) return 0
  const moved = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Moved[]
  let n = 0
  for (const m of [...moved].reverse()) {
    if (!existsSync(m.to)) continue
    mkdirSync(path.dirname(m.from), { recursive: true })
    renameSync(m.to, m.from)
    n++
  }
  rmSync(MANIFEST, { force: true })
  return n
}

if (isEntrypoint(import.meta.url)) {
  const n = restoreFromManifest()
  console.log(n ? `${n} 件を戻しました` : '戻すものはありません')
}

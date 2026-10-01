import { spawn, type ChildProcess } from 'node:child_process'
import { SANDBOX_DIR } from './config.ts'

export interface DevServer {
  url: string
  /** 死んでいたら立て直す。立て直したら true */
  ensureAlive: () => Promise<boolean>
  stop: () => Promise<void>
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`dev server が ${timeoutMs}ms 以内に応答しませんでした: ${url} (${String(lastError)})`)
}

/**
 * サンドボックスの Vite dev server を起動する。
 * ポートは strictPort で固定し、黙って別ポートに逃げるのを防ぐ
 * （逃げられると撮影先が変わり、計測が静かに壊れる）。
 */
async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(500) })
    return false
  } catch {
    return true
  }
}

/**
 * 空いているポートを探す。
 * builder エージェントが自分で確認のために dev server を立てることがあり、
 * ハーネスと同じポートを取り合うと計測が落ちる（実際に一度落ちた）。
 */
export async function findFreePort(from: number, tries = 20): Promise<number> {
  for (let p = from; p < from + tries; p++) if (await portFree(p)) return p
  throw new Error(`${from} から ${tries} 個のポートがすべて塞がっています`)
}

export async function startDevServer(port = 5199): Promise<DevServer> {
  const url = `http://localhost:${port}`
  const child: ChildProcess = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(port), '--strictPort'],
    { cwd: SANDBOX_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let restarted: DevServer | null = null
  const logs: string[] = []
  child.stdout?.on('data', (d: Buffer) => logs.push(d.toString()))
  child.stderr?.on('data', (d: Buffer) => logs.push(d.toString()))

  const exited = new Promise<never>((_, reject) => {
    child.on('exit', (code) =>
      reject(new Error(`dev server が終了しました (code=${code})\n${logs.join('')}`)),
    )
  })

  try {
    await Promise.race([waitForReady(url, 60_000), exited])
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }

  return {
    url,
    /**
     * 生きているか確認し、死んでいたら立て直す。
     *
     * builder が Bash で色々動かすため、dev server が巻き込まれて落ちることがある。
     * 実測で20試行中2件が ERR_CONNECTION_REFUSED で失敗した。
     * ブラウザ側の再試行では救えないので、サーバ自身の復旧を持たせる。
     */
    ensureAlive: async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (res.ok) return false
      } catch {
        // 落ちている
      }
      console.warn('    dev server が落ちています。立て直します')
      child.kill('SIGKILL')
      const revived = await startDevServer(port)
      Object.assign(revived, { url })
      restarted = revived
      return true
    },
    stop: async () => {
      if (restarted) await restarted.stop()
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

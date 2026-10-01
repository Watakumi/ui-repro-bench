import path from 'node:path'
import { capture, withBrowser } from './capture.ts'
import { ROOT } from './config.ts'
import { findFreePort, startDevServer } from './devserver.ts'

/**
 * サンドボックスを1枚撮るだけのコマンド。
 * 参照画像を自作するときや、撮影条件をいじって効きを見るときに使う。
 *
 *   pnpm capture out.png --width 390 --height 844 --dpr 3 --light --full
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main(): Promise<void> {
  const out = process.argv[2]
  if (!out || out.startsWith('--')) {
    console.error(
      '使い方: pnpm capture <出力パス> [--width 1280] [--height 800] [--dpr 2] [--route /] [--light] [--full]',
    )
    process.exit(1)
  }

  const spec = {
    route: flag('route') ?? '/',
    viewport: {
      width: Number(flag('width') ?? 1280),
      height: Number(flag('height') ?? 800),
    },
    deviceScaleFactor: Number(flag('dpr') ?? 2),
    colorScheme: (process.argv.includes('--light') ? 'light' : 'dark') as 'light' | 'dark',
    fullPage: process.argv.includes('--full'),
  }

  // ハーネスの計測用サーバ(5199)と取り合わないよう、別の空きポートを使う
  const server = await startDevServer(await findFreePort(5400))
  try {
    await withBrowser((browser) =>
      capture({ url: server.url, outPath: path.resolve(ROOT, out), spec, browser }),
    )
  } finally {
    await server.stop()
  }

  console.log(`撮影: ${path.resolve(ROOT, out)}`)
  console.log(
    `  ${spec.viewport.width}x${spec.viewport.height} @${spec.deviceScaleFactor}x / ${spec.colorScheme}${spec.fullPage ? ' / fullPage' : ''}`,
  )
}

await main()

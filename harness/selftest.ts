import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { captureResilient, withBrowser } from './capture.ts'
import {
  ROOT,
  RUNS_DIR,
  SANDBOX_APP,
  UI_PACKAGE_SRC,
  isEntrypoint,
  loadTarget,
  type Target,
} from './config.ts'
import { analyzeComponents } from './components.ts'
import { findFreePort, startDevServer } from './devserver.ts'
import { describeFlow, inspectFlow } from './flow.ts'
import { matchSlices } from './slices.ts'
import { analyzeStructure } from './structure.ts'
import { PENDING_LIMIT, pendingRuns } from './reflected.ts'

/**
 * 汎用の知見に、ターゲット固有の名前が混ざっていないか。
 *
 * 混ざったまま測っていたせいで、「知見でターン数が減る」が抽出元の
 * ターゲットでしか成り立たない結論になっていた。分離は目視では保てない。
 */
async function checkGeneralKnowledgeIsGeneral(): Promise<Check> {
  const p = path.join(ROOT, 'harness', 'knowledge', 'GENERAL.md')
  const text = await readFile(p, 'utf8').catch(() => '')
  const forbidden = /newspicks|ant\s*design|antd|grafana|github|Picks/i
  const leaks = text.split('\n').filter((l) => forbidden.test(l))
  return {
    name: '汎用の知見にターゲット名が混ざっていない',
    ok: text.length > 0 && leaks.length === 0,
    detail:
      text.length === 0
        ? 'GENERAL.md が空です'
        : leaks.length === 0
          ? `${text.split('\n').length}行を検査。混入なし`
          : `${leaks.length}行に混入: ${leaks[0]?.trim().slice(0, 60)}`,
  }
}

/**
 * 振り返りが溜まっていないか。
 *
 * 知見の更新は「忘れないようにする」では回らなかった（4日・30試行ぶん放置した）。
 * 溜まったらバッチを始める前に止める。
 */
async function checkReflectionBacklog(): Promise<Check> {
  const pending = await pendingRuns()
  return {
    name: '振り返りが溜まっていない',
    ok: pending.length < PENDING_LIMIT,
    detail:
      pending.length < PENDING_LIMIT
        ? `未反映 ${pending.length} 件（上限 ${PENDING_LIMIT}）`
        : `未反映 ${pending.length} 件。pnpm reflect --pending を先に回してください`,
  }
}

/**
 * 試行本体（run.ts）が読み込めるか。
 *
 * selftest は計測部品だけを呼んでいたので、run.ts のモジュール初期化で落ちる欠陥
 * （SDK の package.json を require して ERR_PACKAGE_PATH_NOT_EXPORTED）を
 * 素通りさせ、6試行ぶんのバッチが全部即死した。起動できることを最初に確かめる。
 */
async function checkEntrypointLoads(): Promise<Check> {
  try {
    const m = (await import('./run.ts')) as { runTrial?: unknown }
    return {
      name: '試行本体（run.ts）が読み込める',
      ok: typeof m.runTrial === 'function',
      detail: typeof m.runTrial === 'function' ? 'runTrial を公開している' : 'runTrial が見つからない',
    }
  } catch (error) {
    return { name: '試行本体（run.ts）が読み込める', ok: false, detail: String(error).slice(0, 200) }
  }
}

/**
 * 既知の正解をハーネスに通し、ハーネス自身が壊れていないかを確かめる。
 *
 * エージェントを1回も動かさずに済むので速く、交絡もない。
 * 「エージェントが失敗した」のか「ハーネスが壊れている」のかを切り分けられる。
 *
 * これまでに見つかった欠陥のうち、次はこの検証で事前に捕まえられた:
 *   - 撮影条件が参照と違う（sticky が写らず 5.3% の床）
 *   - judge に参照を1枚しか渡していない
 *   - フロー検査が状態変化前のページを測る
 *   - 位置探索が sticky 帯を除外せず、全断片が位置0に張り付く
 *
 *   pnpm selftest <target> <既知の正解の App.tsx>
 */

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function runChecks(target: Target, serverUrl: string): Promise<Check[]> {
  const checks: Check[] = [
    await checkEntrypointLoads(),
    await checkReflectionBacklog(),
    await checkGeneralKnowledgeIsGeneral(),
  ]
  const dir = path.join(RUNS_DIR, '_selftest')
  await mkdir(dir, { recursive: true })
  const enter = target.spec.enterActions ?? []

  await withBrowser(async (browser) => {
    // 1. フロー検査が状態変化を反映しているか
    const flow = await inspectFlow(serverUrl, target.spec, browser, enter)
    const full = path.join(dir, 'full.png')
    await captureResilient({
      url: serverUrl,
      outPath: full,
      spec: { ...target.spec, fullPage: true },
      browser,
      actions: enter,
    })
    const sharp = (await import('sharp')).default
    const meta = await sharp(full).metadata()
    const capturedCss = Math.round(meta.height! / target.spec.deviceScaleFactor)
    const gap = Math.abs(capturedCss - flow.documentHeight)
    checks.push({
      name: 'フロー検査の高さが実際の撮影と一致する',
      ok: gap <= Math.max(20, capturedCss * 0.02),
      detail: `フロー ${flow.documentHeight}px / 撮影 ${capturedCss}px（差 ${gap}px）`,
    })
    checks.push({
      name: 'フロー検査が1本の流れと判定する',
      ok: flow.ok,
      detail: describeFlow(flow),
    })

    // 2. 断片が別々の位置に、順番どおりに並ぶか
    if (target.slices.length > 0) {
      const r = await matchSlices({
        fullPagePath: full,
        slices: target.slices,
        diffDir: dir,
        rescan: { url: serverUrl, spec: target.spec, browser },
        enterActions: enter,
      })
      const positions = r.matches.map((m) => m.offset)
      checks.push({
        name: '断片が参照の順番どおりに並ぶ',
        ok: r.ordered,
        detail: positions.join(' → '),
      })
      checks.push({
        name: '断片が別々の位置にマッチする（0に張り付かない）',
        ok: new Set(positions).size === positions.length,
        detail: `${new Set(positions).size} / ${positions.length} 箇所`,
      })
      const worst = Math.max(...r.matches.map((m) => m.score.layoutDiff))
      checks.push({
        name: '既知の正解が閾値を満たす',
        ok: worst <= target.spec.thresholds.layoutDiff,
        detail: `最悪 ${(worst * 100).toFixed(2)}% / 閾値 ${(target.spec.thresholds.layoutDiff * 100).toFixed(2)}%`,
      })
    }

    // 3. 構造と部品
    const components = await analyzeComponents(target.spec.radix)
    const source = await readFile(SANDBOX_APP, 'utf8')
    const structure = analyzeStructure(source, target.spec.structure.maxAbsoluteRatio)
    checks.push({
      name: '絶対配置でなぞっていないと判定する',
      ok: !structure.tracing,
      detail: `絶対配置 ${(structure.absoluteRatio * 100).toFixed(0)}%`,
    })
    // 既知の正解は「当時の要求」で作られたもの。要求を増やしたあとに落ちるのは
    // ハーネスの故障ではなく正しい判定なので、検査ではなく情報として出す。
    checks.push({
      name: 'Radix の判定が動作する（既知の正解の充足は参考値）',
      ok: components.radixExpectedUsed.length > 0,
      detail:
        `充足 ${components.radixExpectedUsed.length}/${components.radixExpectedUsed.length + components.radixExpectedMissing.length}` +
        (components.radixExpectedMissing.length
          ? `　未使用: ${components.radixExpectedMissing.join(', ')}（要求を増やした場合は正常）`
          : ''),
    })
  })

  return checks
}

async function main(): Promise<void> {
  const [targetArg, goldenApp] = process.argv.slice(2)
  if (!targetArg || !goldenApp) {
    console.error('使い方: pnpm selftest targets/<slug> <既知の正解の App.tsx>')
    process.exit(1)
  }

  const target = await loadTarget(targetArg)
  await copyFile(path.resolve(ROOT, goldenApp), SANDBOX_APP)

  // 既知の正解は当時のライブラリに依存している。同じ run に残っている
  // lib/ のスナップショットも戻さないと、import が解決できず全項目が落ちる。
  const libSnapshot = path.join(path.dirname(path.resolve(ROOT, goldenApp)), 'lib')
  const restored = await cp(libSnapshot, UI_PACKAGE_SRC, { recursive: true, force: true })
    .then(() => true)
    .catch(() => false)

  console.log(`▶ 通し検証: ${target.spec.title}`)
  console.log(`  既知の正解: ${goldenApp}`)
  console.log(`  ライブラリ: ${restored ? `${libSnapshot} から復元` : '（スナップショットなし）'}\n`)

  const server = await startDevServer(await findFreePort(5900))
  let checks: Check[] = []
  try {
    checks = await runChecks(target, server.url)
  } finally {
    await server.stop()
  }

  for (const c of checks) {
    console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}`)
    console.log(`      ${c.detail}`)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    failed.length === 0
      ? '\n✔ ハーネスは正常です。失敗したらエージェント側の問題です。'
      : `\n✖ ハーネスに ${failed.length} 件の問題があります。試行を回す前に直してください。`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

if (isEntrypoint(import.meta.url)) await main()

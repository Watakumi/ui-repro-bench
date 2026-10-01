import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  LEARNINGS_PATH,
  buildAgents,
  promptVersion,
  type Agents,
} from './agents.ts'
import { loadKnowledge, type KnowledgeMode } from './knowledge.ts'
import { ABLATIONS } from './agents.ts'
import { hideSecrets } from './isolate-fs.ts'
import { readFileSync } from 'node:fs'

// SDK の版は条件の一部（ハング・課金集計・hook の挙動が版で変わった）。summary に残す。
// パッケージの exports に package.json が無いので require では取れない。直接読む
const SDK_VERSION: string = (() => {
  try {
    const raw = readFileSync(
      path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
      'utf8',
    )
    return (JSON.parse(raw) as { version: string }).version
  } catch {
    return 'unknown'
  }
})()
import { captureResilient, withBrowser } from './capture.ts'
import type { Browser } from 'playwright'
import {
  APP_PLACEHOLDER,
  isEntrypoint,
  loadTarget,
  makeRunId,
  ROOT,
  RUNS_DIR,
  SANDBOX_APP,
  UI_PACKAGE_SRC,
  type Target,
} from './config.ts'
import { startDevServer } from './devserver.ts'
import { describeFlow, inspectFlow, type FlowCheck } from './flow.ts'
import { judge, type JudgePair, type JudgeVerdict } from './judge.ts'
import {
  ZERO_USAGE,
  addUsage,
  appendMetric,
  writeSummary,
  type StateMetric,
  type TurnMetric,
  type Usage,
} from './metrics.ts'
import { waitForQuiet } from './quiesce.ts'
import { pct, score, type Score } from './score.ts'
import { matchSlices, type SliceResult } from './slices.ts'
import { analyzeComponents, describeComponents, type ComponentScore } from './components.ts'
import { analyzeStructure, describeStructure, type StructureScore } from './structure.ts'

/**
 * 全状態を撮って採点する。
 * 収束判定は「最も悪い状態」で行う。どれか1つでも合っていなければ再現できていない。
 */
async function captureStates(
  target: Target,
  serverUrl: string,
  browser: Browser,
  runDir: string,
  turn: number,
): Promise<{ states: StateMetric[]; worst: StateMetric; worstScore: Score; browser: Browser }> {
  let current = browser
  const pad = String(turn).padStart(2, '0')
  const results: { metric: StateMetric; score: Score }[] = []

  for (const state of target.states) {
    const suffix = state.name === 'default' ? '' : `.${state.name}`
    const shotPath = path.join(runDir, `turn-${pad}${suffix}.png`)
    current = await captureResilient({
      url: serverUrl,
      outPath: shotPath,
      spec: target.spec,
      browser: current,
      actions: state.actions,
    })

    const s = await score({
      referencePath: state.referencePath,
      candidatePath: shotPath,
      rawDiffPath: path.join(runDir, `turn-${pad}${suffix}.raw-diff.png`),
      layoutDiffPath: path.join(runDir, `turn-${pad}${suffix}.layout-diff.png`),
    })

    results.push({
      metric: {
        name: state.name,
        rawDiff: s.rawDiff,
        layoutDiff: s.layoutDiff,
        layoutMad: s.layoutMad,
        heightRatio: s.heightRatio,
        shotPath,
      },
      score: s,
    })
  }

  // 飽和しない layoutMad で最悪を選ぶ
  const worst = results.reduce((a, b) => (b.metric.layoutMad > a.metric.layoutMad ? b : a))
  return {
    states: results.map((r) => r.metric),
    worst: worst.metric,
    worstScore: worst.score,
    browser: current,
  }
}

/** lib/ 配下の .tsx をすべて読む。構造の測定に含めるため。 */
async function readLibSources(): Promise<string[]> {
  const entries = await readdir(UI_PACKAGE_SRC, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.tsx')) {
      out.push(await readFile(path.join(UI_PACKAGE_SRC, e.name), 'utf8'))
    }
  }
  return out
}

/**
 * まだ閾値に達していない最初の断片。ここだけを次のターンの対象にする。
 *
 * ページ全体を毎ターン作り直させると、1ターンで5万トークンを使い、
 * 予算上限で途中で切られる（実測）。上から順に1画面ずつ固めていくほうが
 * ターンあたりの作業量が安定し、計測としても読みやすい。
 * 上のセクションが動くと下の位置も動くので、順番に固めるのが理にかなっている。
 */
/**
 * 作業の段階。
 *
 * 骨格が無いのに断片ごとの細部を指示すると、エージェントは細部に引っ張られ、
 * ページが伸びない（実測: 3ターン連続でページ高 2193px のまま、
 * 参照は約4800px 必要）。骨格ができるまでは断片の指示を出さない。
 */
export type Phase = 'structure' | 'skeleton' | 'refine'

export function phaseOf(slices: SliceResult | null, threshold: number): Phase {
  if (!slices) return 'refine'
  // 比較用のA条件では段階を分けず、常に断片ごとの指示を出す
  // 既定は A。実験はすべて A で回してきたのに、環境変数を忘れた1本が
  // 黙って B になり、比較できない結果を作った。忘れたら既定側に倒す
  if ((process.env.UI_BENCH_VARIANT ?? 'A') === 'A') return 'refine'
  // 断片が別々の位置に、順番どおりに並んでいれば骨格はできている
  if (!slices.ordered) return 'skeleton'
  return 'refine'
}

function frontierIndex(slices: SliceResult, threshold: number): number {
  const i = slices.matches.findIndex((m) => m.score.layoutDiff > threshold)
  return i === -1 ? slices.matches.length : i
}

/**
 * 断片モード。実装をフルページで1枚撮り、各参照断片の位置を探索する。
 * 参照は同じページのスクロール違いなので、事前に位置が分からない。
 */
async function captureFullPage(
  target: Target,
  serverUrl: string,
  initialBrowser: Browser,
  runDir: string,
  turn: number,
): Promise<{
  result: SliceResult
  shotPath: string
  browser: Browser
  seams: { label: string; path: string }[]
}> {
  const pad = String(turn).padStart(2, '0')
  const shotPath = path.join(runDir, `turn-${pad}.full.png`)
  const enter = target.spec.enterActions ?? []
  const next = await captureResilient({
    url: serverUrl,
    outPath: shotPath,
    spec: { ...target.spec, fullPage: true },
    browser: initialBrowser,
    actions: enter,
  })
  const diffDir = path.join(runDir, `turn-${pad}`)
  await mkdir(diffDir, { recursive: true })

  // 位置はフルページ撮影で探し、採点は参照と同じ条件（スクロールしてビューポート撮影）で行う。
  const result = await matchSlices({
    fullPagePath: shotPath,
    slices: target.slices,
    diffDir,
    rescan: { url: serverUrl, spec: target.spec, browser: next },
    enterActions: enter,
  })
  // 断片と断片の「あいだ」を撮る。採点していない位置にこそ手抜きが出るため。
  // 実測では、断片ごとに画面を並べた実装が全断片で完璧に一致しながら、
  // 継ぎ目にヘッダーが再出現していた。
  let browser = result.browser ?? next
  const seams: { label: string; path: string }[] = []
  const offsets = result.matches.map((m) => m.offset)
  for (let i = 1; i < offsets.length; i++) {
    const mid = Math.round((offsets[i - 1]! + offsets[i]!) / 2)
    if (mid === offsets[i - 1] || mid === offsets[i]) continue
    const seamPath = path.join(diffDir, `seam-${i}.png`)
    browser = await captureResilient({
      url: serverUrl,
      outPath: seamPath,
      spec: { ...target.spec, fullPage: false },
      browser,
      actions: [...enter, { type: 'scroll', y: Math.round(mid / target.spec.deviceScaleFactor) }],
    })
    seams.push({
      label: `断片${result.matches[i - 1]!.name}と${result.matches[i]!.name}のあいだ`,
      path: seamPath,
    })
  }

  return { result, shotPath, browser, seams }
}

interface TurnOutcome {
  usage: Usage | null
  total_cost_usd: number | null
  num_turns: number | null
  duration_ms: number | null
  subtype: string
  sessionId: string | undefined
  /** ブレインの最終発言。何も変わらなかったターンの原因を後から追うために残す */
  resultText: string | null
  /** モデル別の使用量と推定額。usage は brain だけで builder を含まないので、こちらが正 */
  modelUsage: TurnMetric["modelUsage"] | null
}

async function runBrainTurn(
  prompt: string,
  target: Target,
  agents: Agents,
  sessionId: string | undefined,
  runDir: string,
): Promise<TurnOutcome> {
  const outcome: TurnOutcome = {
    usage: null,
    total_cost_usd: null,
    resultText: null,
    modelUsage: null,
    num_turns: null,
    duration_ms: null,
    subtype: 'unknown',
    sessionId,
  }

  // ブレインの query() が起動直後に固まり、CPU 0% のまま25分待った実測がある
  // （サブプロセスも会話ログも生成されず、エラーにもならない）。上限を切る。
  const abort = new AbortController()
  const turnTimeoutMs = Number(process.env.UI_BENCH_TURN_TIMEOUT_MS ?? 20 * 60_000)
  const firstMessageTimeoutMs = Number(process.env.UI_BENCH_FIRST_MESSAGE_TIMEOUT_MS ?? 120_000)
  let gotFirstMessage = false
  let hungAtStart = false

  // 無応答時間は「起きている間」だけ数える。
  //
  // 壁時計の setTimeout はスリープ中も進むので、蓋を閉じて寝ると起きた瞬間に発火する。
  // 実測では API が正常に応答していた試行が3件、スリープ明けに偽のタイムアウトで落ちた。
  // 5秒ごとのティックが30秒以上飛んでいたら停止していたとみなし、その分を除外する。
  const TICK_MS = 5_000
  let lastActivity = Date.now()
  let lastTick = Date.now()
  const checker = setInterval(() => {
    const now = Date.now()
    const gap = now - lastTick - TICK_MS
    if (gap > 30_000) {
      lastActivity += gap
      console.log(`    停止していた ${Math.round(gap / 1000)}秒 を無応答時間から除外（スリープ等）`)
    }
    lastTick = now
    const idle = now - lastActivity
    if (!gotFirstMessage && idle > firstMessageTimeoutMs) {
      // 健全な query は数秒で最初のメッセージを返す。来なければ短く見切って呼び出し側でやり直す
      hungAtStart = true
      abort.abort()
    } else if (idle > turnTimeoutMs) {
      abort.abort()
    }
  }, TICK_MS)

  try {
    for await (const message of query({
      prompt,
      options: {
        abortController: abort,
        // 固まったときに SDK 側で何が起きていたかを残す
        debug: true,
        debugFile: path.join(runDir, 'sdk-debug.log'),
        agent: 'brain',
        agents: { brain: agents.brain, builder: agents.builder },
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Agent'],
        // 過去の試行・知見の原本・他ターゲットに届かないようにする（H-20）
        cwd: ROOT,
        model: process.env.UI_BENCH_MODEL ?? 'opus',
        // 個人のグローバル設定やCLAUDE.mdが混ざると試行間で条件が揃わなくなるため読まない
        settingSources: [],
        // 個人のMCPコネクタが混ざるとツール定義が試行ごとに変わり、入力トークンがぶれる
        mcpServers: {},
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxBudgetUsd: target.spec.maxBudgetUsd,
        env: {
          ...process.env,
          // 将来 ANTHROPIC_API_KEY を環境に入れたとき、黙ってAPIキー課金に
          // 切り替わらないようにここで落とす。計測は常にサブスク経由で揃える。
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
        },
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      gotFirstMessage = true
      lastActivity = Date.now()
      if ('session_id' in message && typeof message.session_id === 'string') {
        outcome.sessionId = message.session_id
      }
      if (message.type === 'result') {
        outcome.usage = (message.usage as Usage | undefined) ?? null
        outcome.total_cost_usd = message.total_cost_usd ?? null
        outcome.num_turns = message.num_turns ?? null
        outcome.duration_ms = message.duration_ms ?? null
        outcome.subtype = message.subtype
        if ('result' in message && typeof message.result === 'string') outcome.resultText = message.result
        if ('modelUsage' in message && message.modelUsage) outcome.modelUsage = message.modelUsage as TurnMetric["modelUsage"]
      }
    }
  } catch (error) {
    if (abort.signal.aborted && hungAtStart) {
      outcome.subtype = 'hang-at-start'
      console.error(
        `  ! ブレインが起動後 ${firstMessageTimeoutMs / 1000}秒 一度も応答しませんでした（起動時ハング）`,
      )
    } else if (abort.signal.aborted) {
      outcome.subtype = 'timeout'
      console.error(`  ! ブレインが ${turnTimeoutMs / 60_000}分 応答せず中断しました`)
    } else {
      // query() は error 系の result を yield した直後に throw する。
      // 上のループで outcome は埋まっているので、記録を残して続行判断は呼び出し側に任せる。
      console.error(`  ! query がエラーで終了: ${String(error)}`)
      if (outcome.subtype === 'unknown') outcome.subtype = 'error'
    }
  } finally {
    clearInterval(checker)
  }

  // SDK はネットワーク断でも subtype=success で返し、本文に "API Error: ..." を入れてくる。
  // これを普通のターンとして数えると、何も書かれていない placeholder を採点して
  // 「3ターン変化なし」で未収束になる（スリープ復帰直後に2試行が壊れた）。
  if (outcome.resultText && /429|rate.?limit|usage limit/i.test(outcome.resultText)) {
    // レート制限は「つながらない」のとは別。待てば必ず戻るので、長く待つ
    outcome.subtype = 'rate-limit'
    console.error(`  ! 利用上限に当たりました: ${outcome.resultText.slice(0, 80)}`)
  } else if (outcome.resultText && /^API Error:|ENOTFOUND|Connection error/.test(outcome.resultText)) {
    outcome.subtype = 'network'
    console.error(`  ! ネットワーク断: ${outcome.resultText.slice(0, 80)}`)
  }

  return outcome
}

/**
 * SDK のフックが中断された回数。
 *
 * PreToolUse フックが AbortError で落ちると、SDK はそれを拒否として扱う。
 * 許可・禁止の判断以前なので、フックのロジックでは防げない（H-26）。
 * ログから数えて、増えていたらそのターンをやり直す。
 */
async function countHookAborts(runDir: string): Promise<number> {
  const log = await readFile(path.join(runDir, 'sdk-debug.log'), 'utf8').catch(() => '')
  return (log.match(/hooks chain failed: errorKind=AbortError/g) ?? []).length
}

async function networkUp(): Promise<boolean> {
  try {
    await fetch('https://api.anthropic.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    return true
  } catch {
    return false
  }
}

/**
 * ネットワークが届くまで待つ。ノートPCがスリープから戻った直後は Wi-Fi の再接続まで
 * 数十秒〜数分 API に届かない。その間に query を投げると上の "API Error" になる。
 */
async function waitForNetwork(
  maxMs = Number(process.env.UI_BENCH_NETWORK_WAIT_MS ?? 2 * 60 * 60_000),
): Promise<boolean> {
  const start = Date.now()
  let warned = false
  while (!(await networkUp())) {
    if (!warned) {
      console.log('    ネットワークが届きません。復帰を待ちます')
      warned = true
    }
    if (Date.now() - start > maxMs) return false
    await new Promise((r) => setTimeout(r, 15_000))
  }
  if (warned) console.log('    ネットワーク復帰')
  return true
}

function firstPrompt(target: Target, runDir: string): string {
  const { spec } = target
  return `参照UIをサンドボックス上で再現してください。

参照画像: ${target.referencePath}
撮影条件: ${spec.viewport.width}x${spec.viewport.height} @${spec.deviceScaleFactor}x / ${spec.colorScheme}
実装対象: sandbox/src/App.tsx （ルート ${spec.route}）
再利用部品: @ui-bench/ui（packages/ui/）— 試行をまたいで残る。App.tsx は毎回リセットされる
${
    spec.enterActions?.length
      ? `
### この参照は「操作したあとの状態」です

参照を撮る前に、次の操作が行われます。

${spec.enterActions
  .map((a) =>
    a.type === 'click'
      ? `  - 「${a.text ?? a.selector}」をクリック`
      : a.type === 'hover'
        ? `  - 「${a.text ?? a.selector}」にホバー`
        : a.type === 'scroll'
          ? `  - ${a.y}px までスクロール`
          : a.type === 'press'
            ? `  - キー ${a.key} を押す`
            : `  - ${a.ms}ms 待つ`,
  )
  .join('\n')}

つまり実装は、**操作する前の状態から始まり、操作するとこの参照の状態に変わる**
必要があります。参照の状態を初期表示にしてはいけません。操作しても何も起きなければ
撮影は操作前の状態になり、参照と一致しません。
`
      : ''
  }
### 構造の要求（撮影条件から決まるもの）

- **ヘッダーは1つだけ。sticky で追従させる。**
  参照はスクロールして撮られているので、どの位置のスクショにもヘッダーが写る。
  だが置いてよいヘッダーは1つ。参照の枚数ぶん複製してはいけない
- **同じ見出しを2回出さない。** DOM の h1/h2/h3 を集計して重複を検出する
- **ビューポート高の内部スクロール容器を作らない。** スクロールは body が持つ
- **採点していない位置も撮られて審査される。** 参照と突き合わせる位置だけでなく、
  そのあいだの位置とページ全体の縦長1枚も見られる${
    target.slices.length > 0
      ? `\n\n参照は ${target.slices.length} 枚あり、同じ1ページを上から順にスクロールして撮った断片です。
${target.slices.map((s) => `  ${s.file}`).join('\n')}
参照は1本のページをスクロールしながら撮ったものです。断片ごとに画面を用意して
縦に並べると撮影結果だけは一致しますが、不合格です（DOMを検査して落とします）。
**scrollTop をコードから書き換えない**こと。

${(process.env.UI_BENCH_VARIANT ?? "A") === "A" ? "" : `## 進め方（この順で進みます）

### 第1段階: 構造の抽出（このターンで最初にやること）

細部を作る前に、参照 ${target.slices.length}枚すべてを Read で見て、**ページの構造を書き出して**ください。

- セクションが上から順に何があるか（見出しの文言をそのまま並べる）
- カラム構成（左・中央・右にそれぞれ何があるか。sticky で留まるのはどれか）
- 繰り返し要素（同じ形で中身が違うものは何か。何件あるか）
- 参照どうしで重なっている範囲はどこか

これを builder への指示の冒頭に含めてください。**この一覧が、作るべきものの全量です。**

### 第2段階: 骨格

抽出した全セクションを、正しい順序で置きます。中身の作り込みは不要で、
見出しとだいたいの高さと順序だけでよい。**先に全量を置くこと**が重要です。

参照は5画面ぶんの長さがあります。1画面ぶんだけ作って細部を詰めても、
残りが存在しないかぎり一致しません（実測: ページ高が参照の半分で止まり、
断片が全部同じ位置に張り付いた）。

### 第3段階: 精緻化

骨格ができたら、こちらから断片を1枚ずつ指定します。そこだけを直してください。
骨格ができるまで、断片ごとの指示は出しません。

`}
実装はフルページで撮影され、各断片がどこに一致したかを探索して採点します。
断片が参照の順番どおりに並んでいないと収束しません。`
      : ''
  }${
    target.states.length > 1
      ? `\n撮影する状態: ${target.states.map((st) => `${st.name}${st.note ? `（${st.note}）` : ''}`).join(' / ')}\n  すべての状態で参照に合っている必要があります。参照画像は状態ごとに別ファイルです。`
      : ''
  }
成果物の置き場: ${runDir}
${spec.notes ? `\n補足: ${spec.notes}\n` : ''}
まず参照画像を Read で見てください。そのうえで builder に実装を指示してください。
このターンで完璧を狙う必要はありません。骨格と配置を合わせることを優先してください。`
}

function feedbackPrompt(
  turn: number,
  s: Score,
  target: Target,
  shotPath: string,
  verdict: JudgeVerdict | null,
  structure: StructureScore,
  states: StateMetric[],
  components: ComponentScore,
  slices: SliceResult | null,
  flow: FlowCheck | null,
): string {
  const { thresholds } = target.spec
  const worst = states.reduce((a, b) => (b.layoutMad > a.layoutMad ? b : a))
  const byName = new Map(target.states.map((st) => [st.name, st]))

  const lines = [`ターン${turn - 1} の結果です。`, '']

  if (slices) {
    const th = target.spec.thresholds.layoutDiff
    const phase = phaseOf(slices, th)
    const frontier = frontierIndex(slices, th)
    const done = slices.matches.slice(0, frontier)

    lines.push(
      '参照は同じ1ページを上から順にスクロールして撮った断片です。',
      '実装をフルページで1枚撮り、各断片がどこに一致したかを探索しています。',
      '',
      '断片   一致位置    layoutDiff',
    )
    for (const m of slices.matches) {
      lines.push(
        `  ${m.name}   ${String(m.offset).padStart(7)}   ${pct(m.score.layoutDiff).padStart(7)}`,
      )
    }
    lines.push('', `実装フルページの高さ比: ${slices.heightRatio.toFixed(3)}（1.0で参照と同じ長さ）`)

    if (phase === 'skeleton') {
      const collapsed = new Map<number, string[]>()
      for (const m of slices.matches) {
        collapsed.set(m.offset, [...(collapsed.get(m.offset) ?? []), m.name])
      }
      const stacked = [...collapsed.entries()].filter(([, names]) => names.length > 1)

      lines.push(
        '',
        '## このターンは骨格だけを作ります（細部は見ません）',
        '',
        '断片が別々の位置に、参照の順番どおりに並んでいません。',
        ...stacked.map(
          ([offset, names]) =>
            `- 断片 ${names.join(', ')} が同じ位置 ${offset} に張り付いています＝**その範囲がまだ存在しません**`,
        ),
        '',
        `実装の高さは参照の ${(slices.heightRatio * 100).toFixed(0)}% です。`,
        '',
        '**やること: 参照 ' +
          `${target.slices.length}枚すべてを Read で見て、そこに写っているセクションを` +
          '上から順に全部、正しい順序で置いてください。**',
        '',
        '- 中身の作り込みは不要です。見出しと、だいたいの高さと、正しい順序だけでよい',
        '- 空の箱で埋めず、参照に写っている要素（見出し・本文・カード・リスト）を置く',
        '- このターンで細部を合わせにいかないこと。細部は骨格ができてから直します',
        '',
        '骨格ができて断片が順番どおりに並ぶまで、細部の指示は出しません。',
      )
    } else if (frontier < slices.matches.length) {
      const m = slices.matches[frontier]!
      const sliceSpec = target.slices[frontier]!
      lines.push(
        '',
        '## このターンの対象（骨格はできています）',
        '',
        `断片 ${m.name} だけを直してください。閾値は layoutDiff ${pct(th)} です。`,
        `  参照: ${sliceSpec.file}`,
        `  実装の該当箇所: ${path.join(path.dirname(m.score.layoutDiffPath), `slice-${m.name}.png`)}`,
        `  差分: ${m.score.layoutDiffPath}`,
      )
      if (done.length > 0) {
        lines.push(
          '',
          `断片 ${done.map((d) => d.name).join(', ')} は既に達成しています。そこには手を入れないでください。`,
          '手を入れると位置がずれて、達成済みの断片が未達に戻ります。',
        )
      }
      if (frontier + 1 < slices.matches.length) {
        lines.push(
          '',
          `断片 ${slices.matches.slice(frontier + 1).map((d) => d.name).join(', ')} は次のターン以降です。今回は作り込まなくて構いません。`,
        )
      }
    }
    lines.push('')
  } else if (states.length > 1) {
    lines.push('状態ごとの結果（layoutMad が大きいほど参照から遠い）:')
    for (const st of states) {
      const spec = byName.get(st.name)
      lines.push(
        `- ${st.name}${st.name === worst.name ? ' ← 最も悪い' : ''}: ` +
          `layoutMad ${(st.layoutMad * 100).toFixed(3)}% / layoutDiff ${pct(st.layoutDiff)}` +
          `${spec?.note ? `（${spec.note}）` : ''}`,
      )
      lines.push(`    参照 ${spec?.referencePath ?? '-'}`)
      lines.push(`    実装 ${st.shotPath}`)
    }
    lines.push('', `以下は最も悪い状態「${worst.name}」の詳細です。`, '')
  }

  lines.push(
    `- rawDiff:     ${pct(s.rawDiff)}  (閾値 ${pct(thresholds.rawDiff)})`,
    `- layoutDiff:  ${pct(s.layoutDiff)}  (閾値 ${pct(thresholds.layoutDiff)})`,
    `- layoutMad:   ${(s.layoutMad * 100).toFixed(3)}%  (飽和しない連続量。これを下げる)`,
    `- heightRatio: ${s.heightRatio.toFixed(3)}  (1.000 なら参照と同じ高さ)`,
    '',
    `参照画像:       ${byName.get(worst.name)?.referencePath ?? target.referencePath}`,
    `実装スクショ:   ${shotPath}`,
    `差分(raw):      ${s.rawDiffPath}`,
    `差分(layout):   ${s.layoutDiffPath}`,
    '',
    '差分画像でマゼンタに着色されている領域が不一致箇所です。',
    'heightRatio が 1 から離れている場合は、まず全体の高さ（縦の余白か要素の欠落）を疑ってください。',
  )

  if (verdict) {
    lines.push(
      '',
      'ピクセル差分は閾値を通りましたが、審査で不合格でした。',
      '',
      '直さないと収束させない指摘（blocking）:',
      ...(verdict.blocking.length ? verdict.blocking : ['(なし)']).map((i) => `- ${i}`),
      '',
      '参考の指摘（minor。直せるなら直す。これだけなら収束を妨げない）:',
      ...verdict.issues.filter((i) => !verdict.blocking.includes(i)).map((i) => `- ${i}`),
      '',
      `審査スコア（参考値）: ${JSON.stringify(verdict.scores)}`,
    )
    if (verdict.seamIssues.length > 0) {
      lines.push(
        '',
        '採点していない位置（断片と断片のあいだ、ページ全体）で問題が見つかりました。',
        '採点対象の位置だけ作り込んで、あいだが破綻している状態です:',
        ...verdict.seamIssues.map((d) => `- ${d}`),
      )
    }
    if (verdict.dropped.length > 0) {
      lines.push(
        '',
        '参照にあるのに実装で落とされている中身があります。単色ブロックで潰さず描いてください:',
        ...verdict.dropped.map((d) => `- ${d}`),
      )
    }
  }

  lines.push(
    '',
    `実装の構造: ${describeStructure(structure, target.spec.structure.maxAbsoluteRatio)}`,
  )
  if (structure.tracing) {
    lines.push(
      '',
      '⚠ 絶対配置の比率が上限を超えています。座標を直接指定して参照をなぞっている状態です。',
      'これはピクセル差分だけは下がりますが、UIとして成立していないので収束させません。',
      'flex / grid でレイアウトを組み直すよう builder に指示してください。',
      '位置合わせは、親の余白・gap・サイズで表現します。',
    )
  }

  if (flow && !flow.ok) {
    lines.push(
      '',
      '## ⚠ ページが1本の流れになっていません（最優先で直す）',
      '',
      ...flow.issues.map((i) => `- ${i}`),
      '',
      '参照は1つの画面を（複数断片なら、スクロールしながら）撮ったものです。',
      '断片や領域ごとに別の画面を用意して並べると、撮影結果は一致しても',
      '実際にスクロールするとヘッダーが何度も現れ、要素が途中で切断されます。',
      '',
      '守ること:',
      '- 画面全体のヘッダーは1つだけ。sticky で追従させる（パネル内の見出し帯は別）',
      '- ビューポート高の内部スクロール容器を作らない。スクロールはブラウザ（body）が持つ',
      '- scrollTop をコードから書き換えない',
      '- 領域ごとにセクションを複製しない。1つの画面を上から下まで通して書く',
    )
  }

  lines.push('', `部品の状況: ${describeComponents(components)}`)
  if (components.radixExpectedMissing.length > 0) {
    const missing = (target.spec.radix?.expected ?? []).filter((e) =>
      components.radixExpectedMissing.includes(e.primitive),
    )
    lines.push(
      '',
      '⚠ Radix UI で作れるはずの要素が、素のマークアップのままです。',
      'この画面を Radix のコンポーネントで作れるかを測っているので、ここが残ると収束しません:',
      ...missing.map((e) => `- ${e.element} → ${e.primitive}${e.note ? `（${e.note}）` : ''}`),
      '',
      '見た目が変わらなくても置き換えてください。閉じた状態のスクショでは差が出ませんが、',
      'キーボード操作・フォーカス・ARIA が付くかどうかが変わります。',
    )
  }
  if (components.numberedVariants.length > 0) {
    lines.push(
      '',
      `⚠ 連番の部品があります: ${components.numberedVariants.join(', ')}`,
      'props で差し替えるべきものをコピーして増やした形です。1つにまとめるまで収束しません。',
    )
  }

  lines.push('', '最も効く修正を3〜5件に絞って builder に指示してください。')
  return lines.join('\n')
}

export async function runTrial(targetArg: string): Promise<string> {
  const target = await loadTarget(targetArg)

  // 「閾値が甘いのでは」に答えるための上書き。
  // 既定より厳しくして、手順だけで届く画面が本当に届いているのかを見る。
  const strict = process.env.UI_BENCH_LAYOUT_THRESHOLD
  if (strict) {
    target.spec.thresholds.layoutDiff = Number(strict)
    console.log(`  閾値を上書き: layoutDiff ${strict}`)
  }
  const { spec } = target
  const runId = makeRunId(spec.slug)
  const runDir = path.join(RUNS_DIR, runId)
  await mkdir(runDir, { recursive: true })

  // 前の試行の成果を持ち越さない。リセットしないと2回目以降が
  // 「すでに作られた状態」から始まり、必要プロンプト量を過少評価する。
  await copyFile(APP_PLACEHOLDER, SANDBOX_APP)

  // ライブラリはリセットしない。試行をまたいで育てるのが目的なので。
  // ただし何を持った状態で始めたかは記録しておく。
  const libraryBefore = await analyzeComponents(target.spec.radix)

  // 知見の量を環境変数で切り替える。none=素の実力 / cold=一般知見のみ / hot=固有値込み
  const knowledgeMode = (process.env.UI_BENCH_KNOWLEDGE ?? 'cold') as KnowledgeMode
  const knowledge = await loadKnowledge(spec.slug, knowledgeMode)
  const agents = buildAgents(knowledge.text)
  const version = promptVersion(agents)
  // この試行が実際に見た知見を残す。残さないと、後から足した知見を
  // 「与えたのに守られなかった」と誤読してしまう（実際に一度起きた）。
  // 記録には「実際に渡した文字列」を残す。原本のコピーだと cold のマスク前の色コードが
  // 記録に残り、あとから「答えを渡していたのでは」と疑ったときに切り分けられない
  await writeFile(path.join(runDir, 'LEARNINGS.used.md'), knowledge.text, 'utf8').catch(() => {})

  const metricsFile = path.join(runDir, 'metrics.jsonl')
  const startedAt = new Date().toISOString()

  console.log(`▶ ${spec.title} (${spec.slug})`)
  console.log(`  run: ${runDir}`)
  console.log(`  プロンプト版: ${version} / 知見 ${knowledgeMode}（${knowledge.text.length}文字）`)
  console.log(
    `  ライブラリ: ${libraryBefore.library.length}個（版 ${libraryBefore.libraryVersion}）`,
  )
  console.log(
    `  閾値: rawDiff ${pct(spec.thresholds.rawDiff)} / layoutDiff ${pct(spec.thresholds.layoutDiff)} / 最大 ${spec.maxTurns} ターン`,
  )

  // 隠すのは「渡す知見をメモリに読んだあと」。ここから先はディスク上に無い。
  // フックでの拒否は制御ストリームが閉じると効かなくなるが、
  // 存在しないものは読めない（H-26 の置き換え）
  const restoreSecrets = ABLATIONS.noIsolation
    ? () => {}
    : hideSecrets(target.spec.slug, path.basename(runDir))

  // 失敗したときに原因を run に残す。シェルのパイプで grep すると
  // エラー行が落ちて、何が起きたか分からなくなる（実測で1件見失った）。
  const failurePath = path.join(runDir, 'FAILURE.txt')
  const recordFailure = async (error: unknown) => {
    const detail =
      error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error)
    await writeFile(failurePath, `${new Date().toISOString()}\n\n${detail}\n`, 'utf8').catch(
      () => {},
    )
    console.error(`\n✖ 試行が失敗しました。詳細: ${failurePath}\n${detail.slice(0, 400)}`)
  }

  const server = await startDevServer()
  let totals = ZERO_USAGE
  let totalCost = 0
  let judgeTotals = ZERO_USAGE
  let judgeCostTotal = 0
  let hookAbortsSeen = 0
  let hookRetries = 0
  let resolvedModel: string | null = null
  let sessionId: string | undefined
  let converged = false
  let turnsToConverge: number | null = null
  let best = { turn: 0, rawDiff: 1, layoutDiff: 1, layoutMad: 1 }
  let lastScore: Score | null = null
  let lastShot = ''
  let lastVerdict: JudgeVerdict | null = null
  let lastStructure: StructureScore | null = null
  let lastComponents: ComponentScore | null = null
  let lastStates: StateMetric[] | null = null
  let lastSlices: SliceResult | null = null
  let lastFlow: FlowCheck | null = null
  // 空回りの検出。実測で、ブレインが14ターン連続でほぼ何も出力せず
  // （内部ターン1・出力400トークン）スコアも動かない、という状態が起きた。
  // 反復学習させるなら、こういう周回を早く切って次の周回に回したほうがよい。
  let stalledTurns = 0
  let previousSignature = ''
  let turn = 0

  try {
    await withBrowser(async (initialBrowser) => {
      let browser = initialBrowser
      for (turn = 1; turn <= spec.maxTurns; turn++) {
        const prompt =
          turn === 1
            ? firstPrompt(target, runDir)
            : feedbackPrompt(
                turn,
                lastScore!,
                target,
                lastShot,
                lastVerdict,
                lastStructure!,
                lastStates!,
                lastComponents!,
                lastSlices,
                lastFlow,
              )

        console.log(`\n── ターン ${turn} ──`)
        if (!(await waitForNetwork())) {
          throw new Error(`ターン ${turn}: ネットワークが復帰しませんでした（network）`)
        }
        let outcome = await runBrainTurn(prompt, target, agents, sessionId, runDir)
        if (outcome.subtype === 'rate-limit') {
          // 上限は時間で戻る。試行を捨てるより待つほうが安い（1本 $2〜37）
          sessionId = outcome.sessionId ?? sessionId
          const waitMs = Number(process.env.UI_BENCH_RATE_LIMIT_WAIT_MS ?? 20 * 60_000)
          console.log(`  利用上限のため ${waitMs / 60_000}分 待ってやり直します`)
          await new Promise((r) => setTimeout(r, waitMs))
          outcome = await runBrainTurn(prompt, target, agents, sessionId, runDir)
        }
        if (outcome.subtype === 'network') {
          // 途中で切れた場合はセッションを引き継いで同じ指示をもう1回
          sessionId = outcome.sessionId ?? sessionId
          if (!(await waitForNetwork())) {
            throw new Error(`ターン ${turn}: ネットワークが復帰しませんでした（network）`)
          }
          console.log('  ネットワーク断で途切れました。同じ指示をやり直します')
          outcome = await runBrainTurn(prompt, target, agents, sessionId, runDir)
          if (outcome.subtype === 'network' || outcome.subtype === 'rate-limit') {
            throw new Error(`ターン ${turn}: 通信が戻りません（${outcome.subtype}）`)
          }
        }
        if (outcome.subtype === 'hang-at-start') {
          // 起動時ハングは次の起動では通ることが多い。1回だけやり直す。
          console.log('  起動時ハング。1回だけやり直します')
          outcome = await runBrainTurn(prompt, target, agents, sessionId, runDir)
        }
        sessionId = outcome.sessionId

        // フックの中断はターン単位で回復できる。
        // 中断されると builder のツール呼び出しが全部拒否され、
        // builder は停止指示と受け取って手を止める（H-26）。
        // 6試行中2件で起きたので、検出して同じ指示をやり直す。
        const aborted = await countHookAborts(runDir)
        if (aborted > hookAbortsSeen) {
          hookAbortsSeen = aborted
          if (hookRetries < 2) {
            hookRetries++
            console.log(
              `  ! フックが中断されました（累計${aborted}回）。同じ指示でやり直します（${hookRetries}/2）`,
            )
            outcome = await runBrainTurn(prompt, target, agents, sessionId, runDir)
            sessionId = outcome.sessionId ?? sessionId
            hookAbortsSeen = await countHookAborts(runDir)
          }
        }

        // ブレインが何を判断したかは SDK のデバッグログに残らない。
        // 「10分動いて何も変わらなかったターン」を後から読めるように発言を残す
        if (outcome.modelUsage) {
          // 一番使ったモデルを「この試行のモデル」とする
          const top = Object.entries(outcome.modelUsage).sort(
            (a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0),
          )[0]
          if (top) resolvedModel = top[0]
        }
        await writeFile(
          path.join(runDir, `turn-${String(turn).padStart(2, '0')}.brain.md`),
          `${outcome.resultText ?? '(発言なし)'}\n`,
          'utf8',
        )
        if (outcome.subtype === 'timeout' || outcome.subtype === 'hang-at-start') {
          // 固まった query を続けても回復しない。FAILURE.txt に残して試行を終える。
          throw new Error(`ターン ${turn}: ブレインが応答しませんでした（${outcome.subtype}）`)
        }

        // ブレインが返っても builder がまだ書いていることがある。
        // 撮る前にファイルが静止するまで待つ。
        // builder の作業で dev server が巻き込まれて落ちることがある
        if (await server.ensureAlive()) {
          console.log('    dev server を立て直しました')
        }

        const quiet = await waitForQuiet()
        if (quiet.changed) {
          console.log(
            `  query 後も ${(quiet.waitedMs / 1000).toFixed(1)}秒 書き換えが続きました（待機して撮影）`,
          )
        }
        if (quiet.timedOut) {
          console.log('  ⚠ 書き換えが止まらないまま上限に達しました。撮影結果が不完全な可能性があります')
        }

        let sliceResult: SliceResult | null = null
        let s: Score
        let shotPath: string
        let states: StateMetric[]
        let judgePairs: JudgePair[] = []
        let unscored: { label: string; path: string }[] = []

        if (target.slices.length > 0) {
          const full = await captureFullPage(target, server.url, browser, runDir, turn)
          browser = full.browser
          sliceResult = full.result
          s = full.result.worst.score
          shotPath = full.shotPath
          judgePairs = full.result.matches.map((m) => ({
            name: `断片 ${m.name}`,
            referencePath: target.slices.find((sl) => sl.name === m.name)!.file,
            candidatePath: path.join(
              runDir,
              `turn-${String(turn).padStart(2, '0')}`,
              `slice-${m.name}.png`,
            ),
          }))
          unscored = [
            ...full.seams,
            { label: 'ページ全体（縦に長い1枚）', path: full.shotPath },
          ]
          states = full.result.matches.map((m) => ({
            name: m.name,
            rawDiff: m.score.rawDiff,
            layoutDiff: m.score.layoutDiff,
            layoutMad: m.score.layoutMad,
            heightRatio: m.score.heightRatio,
            shotPath: path.join(runDir, `turn-${String(turn).padStart(2, '0')}`, `slice-${m.name}.png`),
          }))
        } else {
          const shot = await captureStates(target, server.url, browser, runDir, turn)
          browser = shot.browser
          s = shot.worstScore
          shotPath = shot.worst.shotPath
          states = shot.states
          judgePairs = shot.states.map((st) => ({
            name: st.name === 'default' ? '既定状態' : st.name,
            referencePath:
              target.states.find((t) => t.name === st.name)?.referencePath ?? target.referencePath,
            candidatePath: st.shotPath,
          }))
        }

        // 構造は App.tsx だけでなく lib/ も含めて測る。
        // App.tsx だけを見ていたため、lib に移した Radix の使用を
        // 「Radix 0箇所」と誤って報告していた。
        const components = await analyzeComponents(spec.radix)
        // 描画結果のDOMで「1本のドキュメントフローか」を見る。
        // 断片の一致だけを見ていると、画面を並べた構成が最適解になってしまう。
        const flow = await inspectFlow(server.url, spec, browser, spec.enterActions ?? [])
        const source = await readFile(SANDBOX_APP, 'utf8')
        const libSources = await readLibSources()
        const structure = analyzeStructure(
          [source, ...libSources].join('\n'),
          spec.structure.maxAbsoluteRatio,
        )

        const flowPassed = flow.ok
        // 断片モードでは、全断片が閾値内で、かつ順番どおりに並んでいること
        // rawDiff も合否に使う。
        //
        // 実績では単独で止めた例はゼロ（3件とも layoutDiff も落ちていた）。
        // それでも外さないのは、**守備範囲が違う**から。
        // layoutDiff はグレースケール化してぼかすので色相の誤りを捨てる。
        // レイアウトが合っていて色だけ違う実装は layoutDiff を通ってしまい、
        // それを拾えるのは rawDiff だけである。
        //
        // 閾値は 30% では甘すぎた（正常ターンの最大が 12.7%）。
        // 他の関門を通った180ターンの分布から 15% に締める。
        // 正常ターンで 15% を超えたものは 0 件なので、誤検知は増やさない。
        const pixelPassed =
          s.rawDiff <= spec.thresholds.rawDiff &&
          s.layoutDiff <= spec.thresholds.layoutDiff &&
          (sliceResult?.ordered ?? true)
        // 絶対配置でなぞっている実装は、ピクセルが合っていても通さない
        const structurePassed = !structure.tracing
        // いまの主眼は「Radix UI のコンポーネントでこの画面を作れるか」。
        // 期待した primitive がすべて使われていることを収束条件にする。
        // 連番の部品は部品ライブラリ側（軸2）の話なので、警告にとどめる。
        // 連番コピペ（Thumb1, Thumb2 …）が残っているかぎり収束させない。
        // 検出は「同じ語幹が2つ以上」に限定してあるので SectionH2 単体は拾わない。
        const componentsPassed =
          // Radix を外したアブレーションでは、この関門は見ない
          ABLATIONS.noRadix ||
          (components.radixExpectedMissing.length === 0 &&
            components.numberedVariants.length === 0)

        let verdict: JudgeVerdict | null = null
        let judgeUsage: Usage | null = null
        let judgeCost: number | null = null
        if (pixelPassed && flowPassed && structurePassed && componentsPassed) {
          console.log('  ピクセル・構造・Radix を通過 → LLM judge へ')
          const judged = await judge({
            pairs: judgePairs,
            unscored,
            sourcePath: SANDBOX_APP,
            notes: spec.notes,
          })
          verdict = judged.verdict
          judgeUsage = judged.usage
          judgeCost = judged.total_cost_usd
          judgeTotals = addUsage(judgeTotals, judgeUsage)
          judgeCostTotal += judgeCost ?? 0
        }

        const passed =
          pixelPassed && flowPassed && structurePassed && componentsPassed && verdict?.pass === true
        const metric: TurnMetric = {
          ts: new Date().toISOString(),
          runId,
          target: spec.slug,
          turn,
          usage: outcome.usage,
          modelUsage: outcome.modelUsage,
          total_cost_usd: outcome.total_cost_usd,
          num_turns: outcome.num_turns,
          duration_ms: outcome.duration_ms,
          subtype: outcome.subtype,
          rawDiff: s.rawDiff,
          layoutDiff: s.layoutDiff,
          states,
          slices:
            sliceResult?.matches.map((m) => ({
              name: m.name,
              offset: m.offset,
              layoutMad: m.score.layoutMad,
              layoutDiff: m.score.layoutDiff,
            })) ?? null,
          slicesOrdered: sliceResult?.ordered ?? null,
          flow,
          layoutMad: s.layoutMad,
          heightRatio: s.heightRatio,
          structure,
          components,
          gate: !pixelPassed
            ? 'pixel'
            : !flowPassed
              ? 'flow'
              : !structurePassed
              ? 'structure'
              : !componentsPassed
                  ? 'radix'
                  : 'judge',
          passed,
          judge: verdict,
          judgeUsage,
          judge_cost_usd: judgeCost,
        }
        await appendMetric(metricsFile, metric)

        totals = addUsage(totals, outcome.usage)
        totalCost += outcome.total_cost_usd ?? 0
        if (s.layoutMad < best.layoutMad) {
          best = { turn, rawDiff: s.rawDiff, layoutDiff: s.layoutDiff, layoutMad: s.layoutMad }
        }

        const worstName = sliceResult?.worst.name ?? states.reduce((a, b) => (b.layoutMad > a.layoutMad ? b : a)).name
        for (const st of states) {
          const mark = st.name === worstName && states.length > 1 ? ' ← 最悪' : ''
          console.log(
            `  [${st.name}] layoutMad ${(st.layoutMad * 100).toFixed(3)}% / layoutDiff ${pct(st.layoutDiff)}${
              sliceResult ? ` / 位置 ${sliceResult.matches.find((m) => m.name === st.name)?.offset}` : ''
            }${mark}`,
          )
        }
        if (sliceResult && !sliceResult.ordered) {
          console.log(`  ⚠ 断片の順序が崩れています: ${sliceResult.orderViolations.join(', ')}`)
        }
        console.log(`  ${describeFlow(flow)}`)
        console.log(`  ${describeStructure(structure, spec.structure.maxAbsoluteRatio)}`)
        console.log(`  ${describeComponents(components)}`)
        if (structure.tracing) console.log('  ⚠ 絶対配置でなぞっています（収束させません）')
        console.log(
          `  累計 $${totalCost.toFixed(4)} / out ${totals.output_tokens} tok / 内部ターン ${outcome.num_turns ?? '-'}`,
        )

        lastScore = s
        lastShot = shotPath
        lastVerdict = verdict
        lastStructure = structure
        lastComponents = components
        lastStates = states
        lastSlices = sliceResult
        lastFlow = flow

        // スコアと実装の行数が両方とも前ターンと同じなら、何も進んでいない
        const signature = `${s.layoutMad.toFixed(6)}|${structure.lines}|${components.appLines}`
        stalledTurns = signature === previousSignature ? stalledTurns + 1 : 0
        previousSignature = signature
        if (stalledTurns >= 2) {
          // 何も変わらない原因が SDK 側にあることがある。
          // PreToolUse フックが中断されると、許可済みのパスまで
          // 「The user doesn't want to take this action right now. STOP」で拒否され、
          // builder は停止指示と受け取って手を止める。これはエージェントの失敗ではない
          const debugLog = await readFile(path.join(runDir, 'sdk-debug.log'), 'utf8').catch(() => '')
          const hookAborted = (debugLog.match(/hooks chain failed: errorKind=AbortError/g) ?? []).length
          if (hookAborted > 0) {
            throw new Error(
              `フックが中断され、ツール呼び出しが拒否され続けました（${hookAborted}回）。` +
                'ハーネス側の失敗です（H-26）',
            )
          }
          console.log(`\n✖ ${stalledTurns + 1}ターン連続で何も変わりません。打ち切ります。`)
          break
        }

        if (passed) {
          converged = true
          turnsToConverge = turn
          console.log(`\n✔ ターン ${turn} で収束`)
          break
        }
        if (outcome.subtype === 'error_max_budget_usd') {
          console.log('\n✖ 予算上限に到達したため打ち切り')
          break
        }
      }
    })
  } catch (error) {
    await recordFailure(error)
    throw error
  } finally {
    await server.stop()
    // 隠したものを戻す。ここで戻さないと、次の試行も集計も動かない
    restoreSecrets()
  }

  // 生成されたソースを結果として残す。残さないと次の試行のリセットで消える。
  await copyFile(SANDBOX_APP, path.join(runDir, 'App.final.tsx'))
  // ライブラリの状態も残す。試行をまたいで育つので、どの時点の部品で
  // 走ったのかが分からないと結果を読めない。
  await cp(UI_PACKAGE_SRC, path.join(runDir, 'lib'), { recursive: true }).catch(() => {})
  const libraryAfter = await analyzeComponents(target.spec.radix)

  const turnsRun = Math.min(turn, spec.maxTurns)
  await writeSummary(path.join(runDir, 'summary.json'), {
    runId,
    target: spec.slug,
    promptVersion: version,
    conditions: {
      knowledge: knowledgeMode,
      variant: process.env.UI_BENCH_VARIANT ?? 'A',
          isolated: !ABLATIONS.noIsolation,
      sdkVersion: SDK_VERSION,
      // 'opus' のようなエイリアスは時期によって別のモデルに解決される。
      // 実測で claude-opus-5 → claude-opus-5-5 に黙って替わっており、
      // 費用が5〜10分の1になった。エイリアスではなく解決後のIDを残す（H-24）
      modelAlias: process.env.UI_BENCH_MODEL ?? 'opus',
      // 切ったものを記録しないと、あとから条件を復元できない
      ...(ABLATIONS.noProbe ? { noProbe: true } : {}),
      ...(ABLATIONS.noRadix ? { noRadix: true } : {}),
      ...(strict ? { layoutThreshold: Number(strict) } : {}),
      model: resolvedModel ?? 'unknown',
    },
    libraryVersionBefore: libraryBefore.libraryVersion,
    libraryComponentsBefore: libraryBefore.library.length,
    libraryVersionAfter: libraryAfter.libraryVersion,
    libraryComponentsAfter: libraryAfter.library.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    converged,
    turnsToConverge,
    turnsRun,
    totals: { ...totals, total_cost_usd: totalCost },
    judgeTotals: { ...judgeTotals, total_cost_usd: judgeCostTotal },
    best,
    stateNames: target.states.map((st) => st.name),
    thresholds: spec.thresholds,
  })

  console.log(`\n${converged ? '収束' : '未収束'} / ${turnsRun} ターン / $${totalCost.toFixed(4)}`)
  console.log(`結果: ${runDir}`)
  return runDir
}

async function main(): Promise<void> {
  const targetArg = process.argv[2]
  if (!targetArg) {
    console.error('使い方: pnpm trial targets/<slug>')
    process.exit(1)
  }
  await runTrial(targetArg)
}

if (isEntrypoint(import.meta.url)) await main()

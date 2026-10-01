import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { LEARNINGS_PATH, buildAgents, loadLearnings, promptVersion } from './agents.ts'
import { ROOT, RUNS_DIR, findTargetDir, isEntrypoint } from './config.ts'
import { markReflected, pendingRuns } from './reflected.ts'
import { collectRuns } from './report.ts'
import { describeStructure } from './structure.ts'
import type { RunSummary, TurnMetric } from './metrics.ts'

/**
 * 試行を振り返って knowledge/LEARNINGS.md を更新する。
 *
 * 一般論を書かせないことが肝心。「余白に気をつける」のような助言は、
 * 次の試行で何も変えない。この試行で実際に外したものと、その実測値だけを残す。
 *
 *   pnpm reflect runs/<runId>
 */

const HISTORY_DIR = path.join(ROOT, 'harness', 'knowledge', 'history')
const RUNS_DIR_REL = RUNS_DIR

const REFLECTOR: AgentDefinition = {
  description: '試行を振り返り、次の試行で精度を上げる知見を抽出して LEARNINGS.md を更新する。',
  prompt: `あなたはUI再現ベンチの振り返り担当です。1回の試行の結果を読み、
次の試行で同じ失敗を繰り返さないための知見を反映します。

## 知見は2つに分けて書く

**汎用** \`harness/knowledge/GENERAL.md\`
別のターゲット（別のサイトの画面）でもそのまま成り立つものだけ。
手順・技法・道具の使い方・失敗の型と避け方・判断の基準。
**サービス名・ページ名・その画面固有の座標や色を書かない。**
判定は「まだ見たことのない別のサイトの画面を作る人に渡して役に立つか」。

**固有** \`harness/knowledge/targets/<このターゲットの slug>.md\`
その画面の実測値・座標・色・断片ごとの違い・そのサイト特有の構造。

混ぜると何が移植できる知識なのか測れなくなる。実際、混ぜていたときの
「知見でターン数が減る」は抽出元のターゲットでしか成り立たず、
別ターゲットでは差ゼロで費用だけ 2.3 倍になった。

迷ったら固有に書く。汎用は少ないほうが強い。

## やること

1. 参照画像と最終実装のスクリーンショットを Read で見る
2. judge の指摘（渡されたJSON）を読む
3. 指摘のうち**実測で確かめられるもの**は、probe で実際に測って数値を確定させる
   例: 「色が違う」→ 参照と実装の同じ座標を probe color で測り、両方の値を得る
4. 現在の GENERAL.md と targets/<slug>.md を読む
5. それぞれの更新版を Write で書き戻す（片方だけの更新でもよい）

## 劣化を成功と読み違えないこと

ターン数が減り、収束していても、**成果物が悪くなっていることがある**。
実際に一度起きた: 知見を与えた試行が5ターン→1ターンになり judge も高得点だったが、
ヒーロー画像の中にあった文字を丸ごと単色ブロックで潰し、
レイアウトも flex をやめて絶対座標でなぞる形に退化していた。

だから振り返りでは、必ず次を確認する:

1. 渡された**構造の指標**を読む。絶対配置の比率が上がっていたら、
   それはピクセル差分に最適化しただけでUIとして退化している
2. judge の **dropped**（落とされた中身）を読む。空でないなら、
   「再現しない」という知見が効きすぎている
3. **前回までの最良の試行と成果物を見比べる**。参照だけでなく、前の実装とも比べる
4. ターン数が減った理由が「うまくなった」のか「手を抜いた」のかを判定する

手を抜いて速くなっていたなら、その原因になった知見を**弱めるか条件を付ける**。
「速くなった」を理由に強化してはいけない。

## 書くもの・書かないもの

書く:
- この試行で**実際に外したこと**と、その**実測値**
  例: 「CTAの色を #1a6dff と推測したが実測は #166cf5」
- 外した原因が仕組みにあるなら、その仕組み
  例: 「参照が @2x なので座標を半分にし忘れる」
- 再現できないと判明したものと、そこに時間を使わない判断

書かない:
- 一般論（「余白に注意」「一貫性を保つ」）。次の試行で何も変えない
- 既にある項目の言い換え。重複は統合する
- この計測系の外の話

## 制約

- 項目は30が上限。超えるなら、効果の薄いものを落とすか統合する
- 各項目は **観察** と **対策** の対にする。対策だけだと守られなくなる
- 根拠になった run のIDを書く
- 既存の項目で、この試行で**守られていた**ものは残す。守られなかったものは
  書き方を変える（伝わっていないということなので）
- ファイル全体を書き直してよいが、既存の知見を理由なく消さないこと

最後に、何を追加・変更・削除したかを箇条書きで5行以内に報告してください。`,
  tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  model: 'inherit',
  omitClaudeMd: true,
}

export interface ReflectResult {
  before: string
  after: string
  changed: boolean
}

export async function reflectOnRun(runArg: string): Promise<ReflectResult> {
  const runDir = path.resolve(ROOT, runArg)

  const summary = JSON.parse(
    await readFile(path.join(runDir, 'summary.json'), 'utf8'),
  ) as RunSummary
  const metrics = (await readFile(path.join(runDir, 'metrics.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TurnMetric)

  // 試行時点の知見。無い run（仕組みを入れる前のもの）は空として扱う。
  const usedPath = path.join(runDir, 'LEARNINGS.used.md')
  const used = await readFile(usedPath, 'utf8').catch(() => '')

  const targetDir = (await findTargetDir(summary.target)) ?? path.join(ROOT, 'targets', summary.target)
  const reference = (await readdir(targetDir)).find((f) => f.startsWith('reference'))
  const shots = (await readdir(runDir)).filter((f) => /^turn-\d+\.png$/.test(f)).sort()
  const lastShot = shots.at(-1)

  // 更新前を履歴に残す。知見が悪化したときに戻せるようにするため。
  const before = await loadLearnings()
  const beforeVersion = promptVersion(buildAgents(before))
  await mkdir(HISTORY_DIR, { recursive: true })
  await copyFile(LEARNINGS_PATH, path.join(HISTORY_DIR, `LEARNINGS-${beforeVersion}.md`))

  // 過去の試行と比べられるようにする。劣化の検出に必要。
  const history = (await collectRuns(summary.target)).filter((r) => r.runId !== summary.runId)
  const previousBest = history.reduce<(typeof history)[number] | undefined>(
    (a, r) => (a === undefined || r.bestLayoutDiff < a.bestLayoutDiff ? r : a),
    undefined,
  )

  const curve = metrics
    .map((m) => `  ターン${m.turn}: layoutDiff ${(m.layoutDiff * 100).toFixed(2)}% / out ${m.usage?.output_tokens ?? '-'}tok / 内部${m.num_turns}ターン / ${m.subtype}`)
    .join('\n')
  const verdict = metrics.find((m) => m.judge)?.judge
  const lastStructure = metrics.at(-1)?.structure

  const prompt = `試行 ${summary.runId} を振り返って、知見を更新してください。

## この試行

- ターゲット: ${summary.target}（${targetDir}）
- 参照画像: ${path.join(targetDir, reference ?? 'reference.png')}
- 最終実装のスクショ: ${lastShot ? path.join(runDir, lastShot) : '(なし)'}
- 最終実装のソース: ${path.join(runDir, 'App.final.tsx')}
- 収束: ${summary.converged ? `した（${summary.turnsToConverge}ターン）` : 'しなかった'}
- 使用したプロンプト版: ${summary.promptVersion}

スコアの推移:
${curve}

${verdict ? `judge の採点: ${JSON.stringify(verdict.scores)}\njudge の指摘:\n${verdict.issues.map((i) => `  - ${i}`).join('\n')}${verdict.dropped.length ? `\njudge が見つけた「落とされた中身」:\n${verdict.dropped.map((d) => `  - ${d}`).join('\n')}` : ''}` : 'judge は発火していません（ゲートを通過しなかった）'}

実装の構造: ${lastStructure ? describeStructure(lastStructure, 0.4) : '(記録なし)'}
${lastStructure?.tracing ? '⚠ 絶対配置でなぞっています。ピクセル差分に最適化しただけで、UIとして退化しています。' : ''}

## 前回までの最良

${previousBest ? `run ${previousBest.runId}
  ターン ${previousBest.turnsToConverge ?? previousBest.turnsRun} / 最良 layoutDiff ${(previousBest.bestLayoutDiff * 100).toFixed(2)}% / 出力 ${previousBest.outputTokens}tok
  成果物: ${path.join(RUNS_DIR_REL, previousBest.runId)}/App.final.tsx と同ディレクトリの turn-*.png
この試行の成果物と見比べて、良くなったのか手を抜いたのかを判定してください。` : '（比較できる過去の試行がありません）'}

## この試行が実際に見た知見

${used ? `${usedPath}\n\nこの試行のエージェントが読んだのは上のファイルの内容だけです。` : 'この試行は知見を一切与えられずに走りました（知見の仕組みを入れる前の試行です）。'}

現在の ${LEARNINGS_PATH} には、この試行のあとに足された項目が含まれている可能性があります。
**試行時に与えられていなかった項目について「書いてあったのに守られなかった」と書かないでください。**
守られたかどうかを判断してよいのは、上のスナップショットに含まれる項目だけです。

## 更新するファイル

${LEARNINGS_PATH}

judge の指摘のうち、実測で確かめられるものは probe で数値を確定させてから書いてください。
「約4%」のような概算のまま書き写しても、次の試行で役に立ちません。`

  console.log(`▶ 振り返り: ${summary.runId}`)
  console.log(`  知見の更新前の版: ${beforeVersion}（履歴に保存しました）\n`)

  let text = ''
  for await (const message of query({
    prompt,
    options: {
      agent: 'reflector',
      agents: { reflector: REFLECTOR },
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      cwd: ROOT,
      model: process.env.UI_BENCH_MODEL ?? 'opus',
      settingSources: [],
      mcpServers: {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: 3,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '0',
      },
    },
  })) {
    if (message.type === 'result') {
      if ('result' in message && typeof message.result === 'string') text = message.result
      console.log(`  ${message.subtype} / 推定 $${(message.total_cost_usd ?? 0).toFixed(4)}`)
    }
  }

  const after = await loadLearnings()
  const afterVersion = promptVersion(buildAgents(after))

  console.log(`\n${text}`)
  console.log(`\n知見の版: ${beforeVersion} → ${afterVersion}`)
  if (beforeVersion === afterVersion) {
    console.log('（変化なし。振り返りが何も足せなかったか、書き込みに失敗しています）')
  } else {
    console.log(`差分を見る: diff harness/knowledge/history/LEARNINGS-${beforeVersion}.md ${path.relative(ROOT, LEARNINGS_PATH)}`)
  }

  // 振り返り済みとして記録する。溜めると selftest が止める（仕組みで忘れを塞ぐ）
  await markReflected(path.basename(runDir))

  return { before: beforeVersion, after: afterVersion, changed: beforeVersion !== afterVersion }
}

async function main(): Promise<void> {
  const runArg = process.argv[2]

  // 未反映の試行をまとめて振り返る。バッチの最後に必ずこれを呼ぶ
  if (runArg === '--pending') {
    const pending = await pendingRuns()
    if (pending.length === 0) {
      console.log('未反映の試行はありません')
      return
    }
    console.log(`未反映 ${pending.length} 件を振り返ります`)
    for (const [i, id] of pending.entries()) {
      console.log(`\n[${i + 1}/${pending.length}] ${id}`)
      const r = await reflectOnRun(path.join('runs', id))
      console.log(r.changed ? '  知見を更新しました' : '  変更なし')
    }
    return
  }

  if (!runArg) {
    console.error('使い方: pnpm reflect runs/<runId>  /  pnpm reflect --pending')
    const pending = await pendingRuns()
    if (pending.length) console.error(`未反映の試行が ${pending.length} 件あります`)
    process.exit(1)
  }
  await reflectOnRun(runArg)
}

if (isEntrypoint(import.meta.url)) await main()

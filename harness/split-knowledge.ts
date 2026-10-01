import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ROOT, isEntrypoint } from './config.ts'

/**
 * 1つに混ざっていた知見を、汎用と固有に分ける。
 *
 * 「知見でターン数が減る」は、知見の抽出元のターゲットでしか成り立たなかった。
 * 原因は、汎用の手順とそのターゲット固有の実測値が同じファイルに同居していたこと。
 * 分けないと「何が移植できる知識なのか」を測れない。
 *
 *   pnpm knowledge:split
 */
const KNOWLEDGE = path.join(ROOT, 'harness', 'knowledge')

const SPLITTER: AgentDefinition = {
  description: '知見を汎用とターゲット固有に仕分ける。',
  prompt: `あなたは知見の仕分け担当です。1つのファイルに混ざっている知見を2種類に分けます。

## 分け方

**汎用（GENERAL）**: 別のターゲット（別のWebサイトの画面）でもそのまま成り立つもの。
- 手順・技法・道具の使い方（「寸法は probe scan で帯の太さとして読む」）
- 失敗の型と、その避け方（「共通部品の誤りは全パネルに複製される。1枚測ってから並べる」）
- 判断の基準（「judge の寸法指摘は場所のヒント。値は測り直す」）

**固有（TARGET）**: そのターゲットでしか使えないもの。
- 特定の画面の実測値・座標・色・断片番号
- そのサイト特有の構造（「断片06 の右下ピルは押された状態」「Picks 数で件数を数える」）
- 固有名詞（サービス名・ページ名）が無いと意味が通らないもの

## 迷ったときの判定

**「この文を、まだ見たことのない別のサイトの画面を作る人に渡して役に立つか」**で決める。
役に立つなら汎用。そのサイトを知らないと意味がないなら固有。

汎用に書くときは、固有名詞と具体的な数値を**例から外す**。
ただし**なぜそうするのかの理由は残す**。理由の無い規則は次の試行で守られない。

例:
- 元: 「newspicks の断片06 だけ右下のピルが押された状態。多数派に合わせて止める」
- 汎用: 「断片ごとに状態が違う部分がある。操作で変わる装飾は、参照の多数派に合わせて固定する」
- 固有: 「断片06 の右下ピルは押された状態」

## やること

1. 渡されたファイルを読む
2. 汎用ぶんを **harness/knowledge/GENERAL.md** に Write する
3. 固有ぶんを、ターゲットごとに **harness/knowledge/targets/<slug>.md** に Write する
   （既存ファイルがあれば読んでから追記の形で書き直す）
4. どちらにも入らない・重複しているものは捨てる。捨てたものは最後に列挙する

## 守ること

- **GENERAL.md にサービス名・サイト名を残さない**（newspicks / Ant Design / antd / grafana / github / Picks）。
  機械的に検査され、1つでも残っていればやり直しになる
- 章立て（## 見出し）は元のものを引き継ぐ
- 元のファイルは消さない。読むだけ

最後に、汎用◯件・固有◯件（ターゲット別）・破棄◯件を3行で報告してください。`,
  tools: ['Read', 'Write', 'Glob'],
  model: 'inherit',
  omitClaudeMd: true,
}

const FORBIDDEN = /newspicks|ant\s*design|antd|grafana|github|Picks/i

export async function splitKnowledge(): Promise<{ ok: boolean; leaks: string[] }> {
  await mkdir(path.join(KNOWLEDGE, 'targets'), { recursive: true })
  const src = path.join(KNOWLEDGE, 'LEARNINGS.md')

  const prompt = [
    `仕分ける元ファイル: ${path.relative(ROOT, src)}`,
    '',
    '出力先:',
    `- 汎用: ${path.relative(ROOT, path.join(KNOWLEDGE, 'GENERAL.md'))}`,
    `- 固有: ${path.relative(ROOT, path.join(KNOWLEDGE, 'targets'))}/<slug>.md`,
    '',
    'ターゲットの slug は targets/ ディレクトリの名前に合わせてください。',
    'Glob で targets/*/target.json を見れば一覧が取れます。',
  ].join('\n')

  for await (const message of query({
    prompt,
    options: {
      agents: { splitter: SPLITTER },
      agent: 'splitter',
      allowedTools: ['Read', 'Write', 'Glob'],
      cwd: ROOT,
      model: process.env.UI_BENCH_MODEL ?? 'opus',
      settingSources: [],
      mcpServers: {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
    },
  })) {
    if (message.type === 'result' && 'result' in message && typeof message.result === 'string') {
      console.log(`\n${message.result}`)
    }
  }

  // 汎用に固有名詞が残っていないかを機械的に検査する。
  // 「分けた」と言えるのは、混入が無いことを確かめたときだけ
  const general = await readFile(path.join(KNOWLEDGE, 'GENERAL.md'), 'utf8').catch(() => '')
  const leaks = general
    .split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => FORBIDDEN.test(l))
    .map(({ l, i }) => `  ${i}: ${l.trim().slice(0, 100)}`)
  return { ok: leaks.length === 0 && general.length > 0, leaks }
}

async function main(): Promise<void> {
  const { ok, leaks } = await splitKnowledge()
  if (leaks.length) {
    console.error(`\n✖ GENERAL.md にターゲット固有の語が ${leaks.length} 行残っています:`)
    for (const l of leaks) console.error(l)
  }
  console.log(ok ? '\n✔ 汎用と固有に分かれました' : '\n✖ 分割が不完全です')
  process.exit(ok ? 0 : 1)
}

if (isEntrypoint(import.meta.url)) await main()

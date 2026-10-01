import { readFile, writeFile } from 'node:fs/promises'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildAgents, loadLearnings } from './agents.ts'
import { ROOT, SANDBOX_APP } from './config.ts'
import type { Usage } from './metrics.ts'

/**
 * Agent SDK のループが実際に通るかだけを確かめる最小の実行。
 *
 * 確かめること:
 *   1. 認証が通るか（Claudeサブスクリプション経由）
 *   2. agent:'brain' が主エージェントとして立つか
 *   3. ブレインが builder に委譲するか（Agent ツールの呼び出しを検出）
 *   4. builder が実際にファイルを編集できるか
 *   5. result メッセージから usage / total_cost_usd / num_turns が取れるか
 *
 * App.tsx は退避して最後に必ず戻す（較正の基準UIを壊さないため）。
 */

const MARKER = 'smoke ok'

async function main(): Promise<void> {
  const { brain, builder } = buildAgents(await loadLearnings())
  const agents = { brain, builder }
  const original = await readFile(SANDBOX_APP, 'utf8')
  console.log('▶ スモークテスト開始（App.tsx は終了時に復元します）\n')

  let sessionId: string | undefined
  let usage: Usage | null = null
  let cost: number | null = null
  let numTurns: number | null = null
  let subtype = 'unknown'
  let delegated = false
  let resultText = ''

  try {
    for await (const message of query({
      prompt: `動作確認です。UIの再現作業ではありません。

builder サブエージェントに、次の1点だけを指示してください:
「sandbox/src/App.tsx の h1 のテキストを "${MARKER}" に変更する。それ以外は一切変えない。」

あなた自身は編集しないでください。必ず builder に委譲してください。`,
      options: {
        agent: 'brain',
        agents,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Agent'],
        cwd: ROOT,
        model: process.env.UI_BENCH_MODEL ?? 'opus',
        settingSources: [],
        // 個人のMCPコネクタが混ざるとツール定義が試行ごとに変わり、入力トークンがぶれる
        mcpServers: {},
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxBudgetUsd: 1,
        env: {
          ...process.env,
          // 将来 ANTHROPIC_API_KEY を環境に入れたとき、黙ってAPIキー課金に
          // 切り替わらないようにここで落とす。計測は常にサブスク経由で揃える。
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
        },
      },
    })) {
      if ('session_id' in message && typeof message.session_id === 'string') {
        sessionId = message.session_id
      }

      // サブエージェント委譲の検出。SDKのバージョンで名前が Task / Agent と揺れる。
      const blocks = (message as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks as Array<{ type?: string; name?: string }>) {
          if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
            delegated = true
            console.log('  ✓ ブレインが Agent ツールで委譲しました')
          }
        }
      }

      if (message.type === 'result') {
        subtype = message.subtype
        usage = (message.usage as Usage | undefined) ?? null
        cost = message.total_cost_usd ?? null
        numTurns = message.num_turns ?? null
        if ('result' in message && typeof message.result === 'string') resultText = message.result
      }
    }
  } catch (error) {
    console.error(`\n! query がエラーで終了: ${String(error)}`)
    if (subtype === 'unknown') subtype = 'error'
  }

  const after = await readFile(SANDBOX_APP, 'utf8')
  const edited = after !== original
  const markerApplied = after.includes(MARKER)

  // 何があっても元に戻す
  await writeFile(SANDBOX_APP, original, 'utf8')

  console.log('\n── 結果 ──')
  const check = (ok: boolean, label: string) => console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  check(subtype === 'success', `query が完走した (subtype=${subtype})`)
  check(Boolean(sessionId), `session_id を取得できた${sessionId ? ` (${sessionId})` : ''}`)
  check(delegated, 'ブレインが builder に委譲した')
  check(edited, 'builder が App.tsx を編集した')
  check(markerApplied, `指示どおりのマーカー "${MARKER}" が入った`)
  check(usage !== null, 'result から usage を取得できた')
  check(numTurns !== null, `num_turns を取得できた${numTurns !== null ? ` (${numTurns})` : ''}`)

  if (usage) {
    console.log('\n  usage:')
    console.log(`    input          ${usage.input_tokens}`)
    console.log(`    output         ${usage.output_tokens}`)
    console.log(`    cache_creation ${usage.cache_creation_input_tokens}`)
    console.log(`    cache_read     ${usage.cache_read_input_tokens}`)
  }
  console.log(`\n  推定コスト: ${cost === null ? '取得できず' : `$${cost.toFixed(4)}`}`)
  if (resultText) console.log(`\n  ブレインの最終出力:\n    ${resultText.replace(/\n/g, '\n    ')}`)
  console.log('\n  App.tsx は復元しました。')

  const allOk = subtype === 'success' && delegated && edited && markerApplied && usage !== null
  console.log(`\n${allOk ? '✔ 試行ループは動きます' : '✖ 未解決の問題があります（上の ✗ を参照）'}`)
  process.exit(allOk ? 0 : 1)
}

await main()

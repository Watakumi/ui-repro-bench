import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ROOT, findTargetDir, isEntrypoint, loadTarget } from './config.ts'

/**
 * 参照画像から「作るべきものの一覧」を抽出する。
 *
 * これまで radix.expected・states・notes は人間側が参照を見て手書きしていた。
 * それが新ターゲットを増やせない原因であり、同時に「どの要素をどの primitive で
 * 作るか」という設計判断を計測に漏らす経路でもあった。
 *
 *   pnpm extract targets/<slug> [--write]
 *
 * --write を付けると target.json の radix.expected を書き換える。
 * 付けなければ表示するだけ（手書きの正解と突き合わせて精度を見るため）。
 */

const RADIX_PRIMITIVES = [
  'Accordion', 'AlertDialog', 'AspectRatio', 'Avatar', 'Checkbox', 'Collapsible',
  'ContextMenu', 'Dialog', 'DropdownMenu', 'Form', 'HoverCard', 'Label', 'Menubar',
  'NavigationMenu', 'Popover', 'Progress', 'RadioGroup', 'ScrollArea', 'Select',
  'Separator', 'Slider', 'Switch', 'Tabs', 'Toast', 'Toggle', 'ToggleGroup',
  'Toolbar', 'Tooltip',
]

export interface ExtractedSpec {
  elements: {
    name: string
    where: string
    interactive: boolean
    primitive: string | null
    reason: string
  }[]
  tokens: {
    colors: { role: string; hex: string; where: string }[]
    spacing: number[]
    fontSizes: number[]
  }
  layout: string
  states: { name: string; trigger: string; note: string }[]
  notReproducible: { what: string; reason: string }[]
}

const EXTRACTOR: AgentDefinition = {
  description: '参照UIの画像から、作るべき要素の一覧・設計トークン・状態を抽出する。',
  prompt: `あなたは参照UIの分析担当です。画像を見て、作るべきものの一覧を作ります。
実装はしません。分析だけです。

## やること

1. 渡された参照画像を Read ですべて見る
2. pnpm probe で色と寸法を実測する（推測しない）
3. 下の形式の JSON だけを出力する

## 道具

    pnpm probe size  <画像>
    pnpm probe color <画像> <x> <y> [--r 4]
    pnpm probe grid  <画像> [--step 100]
    pnpm probe crop  <画像> <x> <y> <w> <h> --scale 4
    pnpm probe scan  <画像> --x <x> --from <a> --to <b>
    pnpm probe scan  <画像> --y <y> --from <a> --to <b>

座標は画像そのもののピクセル。参照が @2x なら CSS px はその半分。

## 判断の基準

**interactive**: クリック・ホバー・キーボードで状態が変わるなら true。
表示するだけのテキストや罫線は false。

**primitive**: 次から選ぶ。当てはまるものが無ければ null。
${RADIX_PRIMITIVES.join(', ')}

無理に当てはめないこと。素の input・リンク・見出しで足りるものは null にして、
reason に「素のマークアップで足りる」と書く。

**notReproducible**: 写真そのものだけ。
チャートは SVG で描けるので含めない。画像の上に載った文字も描けるので含めない。
含めてよいのは人物・風景・商品の写真。

## 出力

JSONだけ。前置きもコードフェンスも不要。

{"elements": [{"name": "ヘッダーのニュース（キャレット付き）", "where": "左上のグローバルナビ",
               "interactive": true, "primitive": "NavigationMenu",
               "reason": "キャレット付きで開閉する"}],
 "tokens": {"colors": [{"role": "アクセント", "hex": "#0000ff", "where": "CTAボタン"}],
            "spacing": [4, 8, 16], "fontSizes": [12, 14, 22]},
 "layout": "カラム構成を1〜2文で",
 "states": [{"name": "reading", "trigger": "続きを読むをクリック", "note": "3カラムに変わる"}],
 "notReproducible": [{"what": "著者の顔写真", "reason": "写真素材がない"}]}`,
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  model: 'inherit',
  omitClaudeMd: true,
}

function parse(text: string): ExtractedSpec {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`JSONとして読めません: ${text.slice(0, 200)}`)
  const p = JSON.parse(text.slice(start, end + 1)) as Partial<ExtractedSpec>
  return {
    elements: p.elements ?? [],
    tokens: p.tokens ?? { colors: [], spacing: [], fontSizes: [] },
    layout: p.layout ?? '',
    states: p.states ?? [],
    notReproducible: p.notReproducible ?? [],
  }
}

export async function extract(targetArg: string): Promise<ExtractedSpec> {
  const target = await loadTarget(targetArg)
  const refs = target.slices.length > 0 ? target.slices.map((s) => s.file) : [target.referencePath]

  const prompt = [
    '次の参照UIを分析して、作るべきものの一覧を出してください。',
    '',
    '## 参照画像',
    ...refs.map((f) => `- ${f}`),
    refs.length > 1 ? '\nこれらは同じ1ページを上から順にスクロールして撮った断片です。' : '',
    '',
    `撮影条件: ${target.spec.viewport.width}x${target.spec.viewport.height} @${target.spec.deviceScaleFactor}x / ${target.spec.colorScheme}`,
    '',
    'すべての画像を Read で見て、probe で測ってから JSON を出力してください。',
  ].join('\n')

  let text = ''
  for await (const message of query({
    prompt,
    options: {
      agent: 'extractor',
      agents: { extractor: EXTRACTOR },
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      cwd: ROOT,
      model: process.env.UI_BENCH_MODEL ?? 'opus',
      settingSources: [],
      mcpServers: {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxBudgetUsd: 4,
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
  return parse(text)
}

async function main(): Promise<void> {
  const targetArg = process.argv[2]
  if (!targetArg) {
    console.error('使い方: pnpm extract targets/<slug> [--write]')
    process.exit(1)
  }

  console.log(`▶ 抽出: ${targetArg}\n`)
  const spec = await extract(targetArg)
  const withPrimitive = spec.elements.filter((e) => e.primitive)

  console.log(`\n要素 ${spec.elements.length}件（うち primitive あり ${withPrimitive.length}件）`)
  for (const e of spec.elements) {
    console.log(`  ${e.interactive ? '◆' : '・'} ${e.name}`)
    console.log(`      ${e.primitive ?? '（素のマークアップ）'} — ${e.reason}`)
  }
  console.log(`\nレイアウト: ${spec.layout}`)
  console.log(`状態: ${spec.states.map((s) => `${s.name}（${s.trigger}）`).join(' / ') || 'なし'}`)
  console.log(
    `色 ${spec.tokens.colors.length}件 / 余白 ${spec.tokens.spacing.join(',')} / 文字 ${spec.tokens.fontSizes.join(',')}`,
  )
  console.log(`再現対象外: ${spec.notReproducible.map((n) => n.what).join(', ') || 'なし'}`)

  const dir = (await findTargetDir(path.basename(targetArg))) ?? path.resolve(ROOT, targetArg)
  await writeFile(path.join(dir, 'extracted.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  console.log(`\n保存: ${path.join(dir, 'extracted.json')}`)

  if (process.argv.includes('--write')) {
    const specPath = path.join(dir, 'target.json')
    const t = JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>
    t.radix = {
      expected: withPrimitive.map((e) => ({
        element: e.name,
        primitive: e.primitive,
        note: e.reason,
      })),
      notApplicable: spec.elements
        .filter((e) => !e.primitive && e.interactive)
        .map((e) => ({ element: e.name, reason: e.reason })),
    }
    await writeFile(specPath, `${JSON.stringify(t, null, 2)}\n`, 'utf8')
    console.log(`target.json の radix.expected を ${withPrimitive.length}件で更新しました`)
  } else {
    console.log('\n--write を付けると target.json に反映します')
  }
}

if (isEntrypoint(import.meta.url)) await main()

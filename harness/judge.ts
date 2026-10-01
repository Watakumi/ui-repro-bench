import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ROOT } from './config.ts'
import type { Usage } from './metrics.ts'

/** ゲート2。ピクセル差分が閾値を通ったあとに「見落とし」を拾う。 */
export interface JudgeVerdict {
  pass: boolean
  /** 直さないと収束させない指摘。pass はこれと dropped・seamIssues が空かで決める */
  blocking: string[]
  scores: {
    layout: number
    spacing: number
    typography: number
    color: number
    components: number
  }
  issues: string[]
  summary: string
  /** 参照にあるのに実装で落とされた要素。単色ブロックで潰した箇所を拾う */
  dropped: string[]
  /**
   * 採点していない位置で見つかった問題。
   *
   * 採点対象のスクショは最適化の対象そのものなので、必ず正しく見える。
   * 実測では、参照断片ごとに画面を用意して縦に並べた実装が、全断片で
   * 完璧に一致しながら「スクロールするとヘッダーが6回現れる」状態だった。
   * 継ぎ目や画面外を見せないと、この種の穴は見つからない。
   */
  seamIssues: string[]
}

export interface JudgeResult {
  verdict: JudgeVerdict
  /** 審査自体の消費。計測コストに含めるため呼び出し元へ返す。 */
  usage: Usage | null
  total_cost_usd: number | null
}

const JUDGE: AgentDefinition = {
  description: 'UI再現の審査員。参照と実装のスクショを比べ、項目別に採点する。',
  prompt: `あなたはUI再現の審査員です。参照UIの画像と、実装のスクリーンショットを比べます。

参照はスクリーンショット画像なので、フォントの字形やアンチエイリアスは厳密には一致しません。
そこは減点しないでください。見るのは次の5項目です。

- layout: 要素の並び・階層・グリッド・領域分割が一致しているか
- spacing: 余白・行間・要素間の間隔の比率が一致しているか
- typography: 文字サイズの階層・ウェイト・行長が一致しているか
- color: 背景・前景・アクセント・境界線の明度関係が一致しているか
- components: 参照にある部品（ボタン・タブ・バッジ・アバター等）が過不足なく存在するか

渡された2枚の画像を Read で必ず両方見てください。片方だけで採点してはいけません。

## 採点していない位置も見る

「採点対象」とは別に「採点していない位置」の画像が渡されることがあります。
参照との比較はできませんが、**そこにこそ手抜きが出ます**。

採点対象のスクリーンショットは、実装が合わせにいった対象そのものなので、
必ず正しく見えます。過去に、参照の断片ごとに画面を用意して縦に並べた実装が、
全断片で完璧に一致しながら、実際にスクロールするとヘッダーが6回現れ、
要素が途中で切断されている、ということがありました。

採点していない位置の画像で、次を確認してください。

- ヘッダーやナビが**ページの途中で再び現れて**いないか
- 要素が**途中で不自然に切断**されていないか
- 大きな**空白や、意味のない帯**がないか
- 採点対象の位置だけ作り込まれ、その間が**空っぽ**になっていないか

見つけたら seamIssues に書いてください。1件でもあれば pass は false です。

## 実装ソースも必ず読む

スクリーンショットだけでは見抜けない不正があります。ソースを Read して次を確認してください。

1. **絶対配置でのトレース**
   \`absolute left-[222.5px] top-[124px]\` のように座標を直接指定して参照をなぞっていないか。
   これはピクセル差分だけは下がりますが、UIとして成立していません。
   見つけたら layout を 60 以下にし、issues の先頭に書いてください。

2. **再現できるのに捨てられた中身**
   参照の画像領域（ヒーロー、バナー）の中に**文字**があるなら、それは再現できます。
   領域ごと単色ブロックで潰していたら、それは手抜きです。
   \`<div className="... bg-[#d7d6b3]" />\` のような、中身のない矩形で大きな領域を
   埋めていないか確認してください。見つけたら dropped に列挙し、components を下げてください。

   写真そのもの（人物・風景）は再現できないので、単色ブロックで正しいです。
   区別は「文字や図形として描けるか」です。

## 再現できないものを理由に落とさない

写真・動画サムネイル・イラスト・人物アバターは素材が無いので、**枠の位置と大きさだけ**を見ます。
中の構図、イニシャル文字の有無、代替の円が無地か模様かは採点しません。
過去に、全項目85前後の実装を「アバターがイニシャルのまま」「サムネイル内の表の行間」で落とし、
予算を使い切らせたことがあります。それは審査の失敗です。

## 指摘は「直さないと収束させない」ものと「直せるとよい」ものに分ける

blocking（これがあると pass しない）:
- 参照にある部品・文字・領域が無い、または参照に無いものがある
- 並び順・階層・列数・領域の分割比が違う（幅や高さが 15% 以上ずれる）
- 絶対配置のトレース、dropped、seamIssues

minor（記録するが pass は妨げない）:
- 折り返し位置が1行ぶん違う、幅・余白が 20px 程度ずれる
- 色味の微差、字形、写真やイラストの中身

点数は参考値です。pass の判定は blocking・dropped・seamIssues が空かどうかだけで決まります。

最終出力はJSONだけにしてください。前置きも説明文もコードフェンスも不要です。

{"pass": <blocking と dropped と seamIssues がすべて空なら true>,
 "scores": {"layout": 0, "spacing": 0, "typography": 0, "color": 0, "components": 0},
 "blocking": ["直さないと収束させない指摘。具体的な要素名と方向つき。無ければ空配列"],
 "issues": ["minor を含む全部の指摘を、具体的な要素名と方向つきで。最大5件。どの参照のことかを頭に付ける"],
 "dropped": ["参照にあるのに実装で落とされた中身。単色ブロックで潰した箇所。無ければ空配列"],
 "seamIssues": ["採点していない位置で見つかった問題。無ければ空配列"],
 "summary": "1文"}`,
  tools: ['Read'],
  model: 'inherit',
  omitClaudeMd: true,
}

function parseVerdict(text: string): JudgeVerdict {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error(`judge の応答をJSONとして読めません: ${text.slice(0, 200)}`)
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as JudgeVerdict
  // 古い形の応答でも落ちないようにする
  const dropped = parsed.dropped ?? []
  const seamIssues = parsed.seamIssues ?? []
  const blocking = parsed.blocking ?? []
  // pass は審査員の自己申告ではなくこちらで決める。
  // 「全項目85以上」で決めていたころ、84点の1項目で落として予算を使い切らせた。
  const pass = Array.isArray(parsed.blocking)
    ? blocking.length === 0 && dropped.length === 0 && seamIssues.length === 0
    : parsed.pass
  return { ...parsed, pass, blocking, dropped, seamIssues }
}

/**
 * 審査も Agent SDK 経由で回す。
 * 生の Anthropic SDK を直接叩くとAPIキー課金になり、
 * ブレイン/builder（Claudeサブスクリプション）と課金経路が分かれてしまうため。
 */
export interface JudgePair {
  name: string
  referencePath: string
  candidatePath: string
}

export async function judge(opts: {
  /** 採点対象。参照と実装の対。断片モードでは全断片を渡す */
  pairs: JudgePair[]
  /** 採点していない位置の実装スクショ。継ぎ目や画面外 */
  unscored?: { label: string; path: string }[]
  sourcePath: string
  notes?: string
}): Promise<JudgeResult> {
  const prompt = [
    '次を比べて採点してください。',
    '',
    '## 採点対象（参照と実装の対）',
    ...opts.pairs.map(
      (p) => `- ${p.name}\n    参照: ${p.referencePath}\n    実装: ${p.candidatePath}`,
    ),
    opts.pairs.length > 1
      ? '\nこれらは同じ1ページを上から順にスクロールして撮ったものです。全部を見てください。'
      : '',
    ...(opts.unscored?.length
      ? [
          '',
          '## 採点していない位置（参照なし）',
          ...opts.unscored.map((u) => `- ${u.label}: ${u.path}`),
          '',
          'これらは採点対象ではありません。参照と比べる必要はありません。',
          '手抜きや破綻が出ていないかだけを見てください。',
        ]
      : []),
    '',
    `## 実装ソース\n${opts.sourcePath}`,
    opts.notes ? `\n補足: ${opts.notes}` : '',
    '',
    '画像を Read してから、JSONだけを出力してください。',
  ].join('\n')

  let text = ''
  let usage: Usage | null = null
  let cost: number | null = null

  for await (const message of query({
    prompt,
    options: {
      agent: 'judge',
      agents: { judge: JUDGE },
      allowedTools: ['Read'],
      cwd: ROOT,
      model: process.env.UI_BENCH_JUDGE_MODEL ?? 'opus',
      settingSources: [],
      // 個人のMCPコネクタが混ざるとツール定義が試行ごとに変わり、入力トークンがぶれる
      mcpServers: {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        // APIキーが環境にあっても使わない。課金経路をサブスクに揃えるため。
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '0',
      },
    },
  })) {
    if (message.type === 'result') {
      usage = (message.usage as Usage | undefined) ?? null
      cost = message.total_cost_usd ?? null
      if ('result' in message && typeof message.result === 'string') text = message.result
    }
  }

  return { verdict: parseVerdict(text), usage, total_cost_usd: cost }
}

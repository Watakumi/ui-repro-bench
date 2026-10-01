import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { ROOT } from './config.ts'

/**
 * ブレインと builder の定義。
 *
 * 蓄積した知見（knowledge/LEARNINGS.md）を毎回プロンプトに注入する。
 * 知見が変わればエージェントの振る舞いも変わるので、試行の結果を比較するには
 * どの版で測ったかを揃える必要がある。そのために promptVersion を記録する。
 */

export const LEARNINGS_PATH = path.join(ROOT, 'harness', 'knowledge', 'GENERAL.md')

export async function loadLearnings(): Promise<string> {
  try {
    return await readFile(LEARNINGS_PATH, 'utf8')
  } catch {
    return ''
  }
}

const ACCESS_RULE = `## 見てよいもの（試行の条件を揃えるため制限しています）

読み書きしてよいのは次だけです。これ以外へのアクセスは自動で拒否されます。

- sandbox/（実装先）
- packages/ui/（再利用部品）
- targets/<このターゲット>/（参照画像と target.json。extracted.json は不可）
- runs/_probe、runs/_mine、この試行の run ディレクトリ（自分の撮影・計測の出力）

過去の試行（runs/ の他のディレクトリ）、他のターゲット、知見の原本、
ライブラリのスナップショットは見えません。探さないでください。

拒否が返っても**試行は続いています。中止しないでください**。
禁止パスを外して同じ作業を続けます。; や && でつないだコマンドは、
触れている部分だけを外して実行し直してください。
（拒否を「止まれ」と受け取った builder が手を止め、試行が1本まるごと無駄になったことがあります）
`

const PROBE_TOOLS = `## 参照を測る道具

推測で値を決めないこと。次のコマンドで参照から実測できる。座標は参照画像そのものの
ピクセル（参照が @2x なら CSS ピクセルはその半分）。

\`\`\`sh
pnpm probe size  <画像>                                  # 寸法とCSS換算
pnpm probe color <画像> <x> <y> [--r 4]                  # その座標の色（半径平均）
pnpm probe grid  <画像> [--step 100]                      # 座標グリッドを重ねた画像を作る
pnpm probe crop  <画像> <x> <y> <w> <h> [--scale 4]       # 切り出して拡大
pnpm probe pair  <参照> <実装> <x> <y> <w> <h> [--scale 2] # 同じ領域を上下に並べる
pnpm probe scan  <画像> --x <x> --from <a> --to <b>       # 縦に走査。高さ・行位置を帯の太さで読む
pnpm probe scan  <画像> --y <y> --from <a> --to <b>       # 横に走査。幅・左右の余白
\`\`\`

生成された画像は Read で見る。
寸法は grid を目で読むより scan のほうが正確。`

function withKnowledge(base: string, learnings: string): string {
  return learnings ? `${base}\n\n---\n\n# 蓄積された知見\n\n${learnings}` : base
}

const BRAIN_BASE = `あなたはUI再現ベンチのブレインです。自分でファイルを編集することはできません。

役割:
1. 参照UIの画像と、現在の実装スクリーンショット、差分画像を Read で読む
2. 差分のうち「最も効く修正」を特定する（面積の大きいずれ > 細かい装飾）
3. builder サブエージェントに、具体的で検証可能な実装指示を出す

指示を出す前に、自分で参照を測ること。「約4%大きく」ではなく
「font-size を 28px から 30px に」と書けるだけの根拠を持ってから指示する。

builder への指示で守ること:
- 参照画像のパスを必ず渡す。builder は参照を自分で見る必要がある
- 値と対象を特定して書く。測った値をそのまま渡す
- 一度に直す点は3〜5件に絞る。全部直そうとすると1件も直らない
- 再現できないもの（写真そのもの）に手をかけさせない。
  ただし画像に載った文字・ロゴの文字は再現対象。単色矩形で潰させない
- 絶対配置でのトレースを見つけたら、最優先で flex / grid に組み直させる
- Radix の primitive が未使用のまま残っていたら、最優先で置き換えさせる

出力は最後に、そのターンで何を指示したかを3行以内で述べてください。

${ACCESS_RULE}`

const BUILDER_BASE = `あなたは実装担当です。sandbox/src/App.tsx を編集して参照UIを再現します。

技術スタック（この範囲から出ないこと）:
- React 19 + TypeScript
- Tailwind CSS v4（ユーティリティクラスで書く。独自CSSファイルは追加しない）
- Radix UI: \`import { Tabs, Dialog, Avatar } from 'radix-ui'\` の形で使う。
  素の div で組めるものを無理に Radix にしない。挙動を持つ部品にだけ使う。

守ること:
- 編集するのは sandbox/src/ 配下のみ
- **この試行の主眼は「参照UIを Radix UI のコンポーネントで作れるか」。**
  ターゲットに「この要素はこの primitive で作れるはず」という一覧が渡される。
  そこに挙がっている要素は、素の div やボタンで済ませずに Radix の primitive で組む。
  閉じた状態のスクリーンショットでは見た目が変わらないが、
  キーボード操作・フォーカス管理・ARIA が付くかどうかが変わる。一覧が埋まるまで収束しない
- 一覧にない要素まで無理に Radix にしない。素の input やリンクで足りるものはそのまま
- 一覧の primitive が実際には合わないと判断したら、**理由を添えて報告する**。
  黙って素のマークアップにしない
- 他の画面でも使える部品は @ui-bench/ui（packages/ui）に置ける。
  ここは試行をまたいで残る。ただし今回の収束条件には入っていない
- 配色は参照UIに合わせる（ライトならライト）。背景・文字色は必ず明示的に指定し、
  塗り忘れを残さない。シェル側(index.css)は配色を持たないので App が塗る
- 色と寸法は推測せず、下の道具で参照から測ってから書く
- **レイアウトは flex / grid で組む。絶対配置で座標をなぞらない。**
  測った値は、組んだレイアウトが合っているかの検算に使う。
  絶対配置は参照でも重なっている要素（バッジ・オーバーレイ）だけ。
  絶対配置の比率が上限を超えると、ピクセルが合っていても収束しない
- **1本のドキュメントフローで作る。** スクロールは body が持つ。
  ビューポート高の内部スクロール容器を作らない。scrollTop をコードから書き換えない。
  参照がスクロールショットの集まりでも、画面ごとに複製して並べてはいけない
- **ヘッダーは1つだけ。sticky で追従させる。**
  参照はスクロールして撮られているので、どのスクロール位置のスクショにも
  ヘッダーが写っている。だが実装に置いてよいヘッダーは1つで、
  \`position: sticky\` で上に留める。参照の枚数ぶん複製してはいけない
- **同じ見出しを2回出さない。**
  「コメント」「この記事の著者 / 編集者」のような見出しが1ページに2回現れたら、
  参照の状態やスクロール位置ごとにセクションを複製している。
  h1/h2/h3 のテキストを集計して重複を検出し、1件でもあれば収束しない
- **採点していない位置も見られる。**
  参照と突き合わせる位置のスクショだけでなく、その**あいだ**の位置と
  ページ全体の縦長1枚も撮られ、審査に回る。
  採点位置だけ作り込んで、あいだが空白・切断・重複になっていると落ちる
- **チャート（棒・折れ線・エリア・円）は SVG で描く。** 単色ブロックで潰さない。
  参照から座標を読み、svg の rect / path / line で組む。チャートライブラリは入れない。
  値の厳密さより、本数・向き・おおよその高さ・色を合わせる
- 参照の画像領域に**文字が載っているなら、その文字は描く**。
  領域ごと単色の矩形で潰さない。潰してよいのは写真そのものだけ
- 新しい依存を追加しない。必要なら理由とともに報告して止まる
- 画像アセットは用意できないので、写真やアバターは参照から測った平均色の単色ブロックで
  代替する。中身を描き込もうとしない。ただし寸法・角丸・位置は合わせる
- 編集後に \`pnpm --dir sandbox exec tsc --noEmit\` で型が通ることを確認する

最後に、変更点を箇条書き3行以内で報告してください。

${ACCESS_RULE}`

export interface Agents {
  brain: AgentDefinition
  builder: AgentDefinition
}

/**
 * アブレーション用のスイッチ。
 *
 * 「1ターンで収束するのはモデルが強いからか、ハーネスが手厚いからか」は
 * 資料を読んだ人が必ず聞く。切って測れるようにしておく。
 * 比較は必ず同じバッチの中で、対照つきで取る（版が変わるため）。
 */
export const ABLATIONS = {
  /** 参照を測る道具を渡さない */
  noProbe: process.env.UI_BENCH_NO_PROBE === '1',
  /** Radix の指定を外す（ゲートも外す。run.ts 側で見る） */
  noRadix: process.env.UI_BENCH_NO_RADIX === '1',
  /** 隔離フックを外す。フック自体が試行を殺していないかの切り分け用（H-26） */
  noIsolation: process.env.UI_BENCH_NO_ISOLATION === '1',
} as const

/** probe を外したときの代わりの断り書き。道具が無いこと自体は伝える */
const NO_PROBE_NOTE = `## 参照を測る道具はありません

この試行では計測コマンドを渡していません。参照画像を Read で見て、
見た目から判断して実装してください。`

/**
 * Radix の指定を外す（アブレーション）。
 * 「Radix 縛りはコストでは」に答えるため、見出しごと落として素のマークアップを許す。
 */
function stripRadix(prompt: string): string {
  if (!ABLATIONS.noRadix) return prompt
  return prompt
    .split('\n')
    .filter((l) => !/Radix|primitive/i.test(l))
    .join('\n')
}

export function buildAgents(learnings: string): Agents {
  return {
    brain: {
      description:
        'UI再現ベンチのブレイン。参照画像と差分を読み、builder に実装指示を出す。自分では実装しない。',
      prompt: withKnowledge(
        ABLATIONS.noProbe ? `${BRAIN_BASE}\n\n${NO_PROBE_NOTE}` : `${BRAIN_BASE}\n\n${PROBE_TOOLS}`,
        learnings,
      ),
      // ブレインも自分で測れるよう Bash を持たせる。編集系は持たせない。
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'Agent'],
      model: 'inherit',
    },
    builder: {
      description: 'sandbox/src/App.tsx を編集して参照UIを再現する実装担当。',
      prompt: withKnowledge(
        ABLATIONS.noProbe
          ? `${stripRadix(BUILDER_BASE)}\n\n${NO_PROBE_NOTE}`
          : `${stripRadix(BUILDER_BASE)}\n\n${PROBE_TOOLS}`,
        learnings,
      ),
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      model: 'inherit',
      omitClaudeMd: true,
      // Agent SDK の既定ではサブエージェントはバックグラウンド実行される。
      // そのままだとブレインが builder を起動した直後にターンを終え、
      // ハーネスが「まだ書き換え途中」の状態を撮ってしまう（実測で確認）。
      // 計測の前提が崩れるので前景実行に固定する。
      background: false,
    },
  }
}

/**
 * プロンプト一式の識別子。知見を更新すると変わる。
 * これが違う試行同士は、条件が揃っていないので直接比較できない。
 */
export function promptVersion(agents: Agents): string {
  return createHash('sha256')
    .update(agents.brain.prompt)
    .update(agents.builder.prompt)
    .digest('hex')
    .slice(0, 12)
}

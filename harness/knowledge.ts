import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './config.ts'

/**
 * 知見の注入モード。
 *
 * 汎用と固有を1つのファイルに混ぜていたため、「知見でターン数が減る」が
 * 抽出元のターゲットでしか成り立たなかった（別ターゲットでは差ゼロ・費用2.3倍）。
 * 何が移植できる知識なのかを測れるよう、ファイルから分ける。
 *
 * どのモードでも、手順そのもの（測ってから書く・flex/grid で組む・検算する・
 * probe の使い方）はエージェントのプロンプトに常に入っている。
 * none は「知識ゼロ」ではなく「蓄積なし」である。
 */
export type KnowledgeMode =
  /** 蓄積を与えない。手順プロンプトだけ。基準線 */
  | 'none'
  /** 汎用の知見のみ。別ターゲットへ移植できるかを測る */
  | 'general'
  /** 汎用 + そのターゲットの固有知見。積み上げの効果を測る */
  | 'full'
  /** 旧称。general と同じ（過去の試行の記録と互換を取るため残す） */
  | 'cold'
  /** 旧称。full と同じ */
  | 'hot'

/** 16進カラーコードを伏せる。根拠としての文脈は残す。 */
export function maskHex(text: string): string {
  return text.replace(/#[0-9a-fA-F]{6}\b/g, '#______')
}

/**
 * 座標つきの実測値を伏せる。
 * 汎用ファイルに紛れ込んだ具体値への保険で、本来は固有ファイル側にあるべきもの。
 */
export function maskMeasurements(text: string): string {
  return text
    .replace(/\((\d{2,4}),\s*(\d{2,4})\)/g, '(x,y)')
    .replace(/参照\s*[\d.]+\s*\/\s*実装\s*[\d.]+/g, '参照 ○○ / 実装 △△')
}

export interface Knowledge {
  text: string
  mode: KnowledgeMode
  /** そのターゲットの固有知見を与えたか */
  targetFactsIncluded: boolean
}

const KNOWLEDGE_DIR = path.join(ROOT, 'harness', 'knowledge')

export async function loadKnowledge(
  targetSlug: string,
  mode: KnowledgeMode = 'general',
): Promise<Knowledge> {
  if (mode === 'none') {
    return { text: '', mode, targetFactsIncluded: false }
  }

  const general = await readFile(path.join(KNOWLEDGE_DIR, 'GENERAL.md'), 'utf8').catch(() => '')
  const wantsFacts = mode === 'full' || mode === 'hot'

  if (wantsFacts) {
    const facts = await readFile(
      path.join(KNOWLEDGE_DIR, 'targets', `${targetSlug}.md`),
      'utf8',
    ).catch(() => '')
    return {
      text: facts ? `${general}\n\n---\n\n${facts}` : general,
      mode,
      targetFactsIncluded: Boolean(facts),
    }
  }

  // general: 汎用だけ。分離漏れの具体値も伏せる。
  // 「なぜそうするのか」は残しつつ、「答え」だけ消す。
  return {
    text:
      maskMeasurements(maskHex(general)) +
      '\n\n> 上の `#______` や `(x,y)` は、この試行では伏せてあります。' +
      '\n> 色も寸法も、参照から `pnpm probe` で自分で測ってください。\n',
    mode,
    targetFactsIncluded: false,
  }
}

import { appendFile, writeFile } from 'node:fs/promises'
import type { JudgeVerdict } from './judge.ts'
import type { ComponentScore } from './components.ts'
import type { FlowCheck } from './flow.ts'
import type { StructureScore } from './structure.ts'

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/** 1状態ぶんの採点結果 */
export interface StateMetric {
  name: string
  rawDiff: number
  layoutDiff: number
  layoutMad: number
  heightRatio: number
  shotPath: string
}

export interface TurnMetric {
  ts: string
  runId: string
  target: string
  turn: number
  /** result メッセージの usage。サブエージェントの消費も含まれる。 */
  usage: Usage | null
  /** モデル別（brain + builder + 補助）の使用量と推定額。usage は brain の主ループだけ */
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number; costBasis?: string }> | null
  total_cost_usd: number | null
  /** 1 回の query() 内でエージェントが回した内部ターン数 */
  num_turns: number | null
  duration_ms: number | null
  subtype: string
  /** 状態ごとの結果。状態を定義していなければ default の1件 */
  states: StateMetric[]
  /** 参照断片ごとの結果。slices 指定があるときだけ埋まる */
  slices: { name: string; offset: number; layoutMad: number; layoutDiff: number }[] | null
  /** 断片が参照の順番どおりに並んでいるか */
  slicesOrdered: boolean | null
  /** ページが1本のドキュメントフローになっているか */
  flow: FlowCheck | null
  /** 以下は「最も悪い状態」の値。収束判定はこれで行う */
  rawDiff: number
  layoutDiff: number
  layoutMad: number
  heightRatio: number
  /** 実装ソースの構造。ピクセル一致とは別に、UIとして成立しているかを見る */
  structure: StructureScore | null
  /** コンポーネントの質。目的が「再利用できる部品を作ること」なので別に測る */
  components: ComponentScore | null
  /** どのゲートまで進んだか */
  gate: 'pixel' | 'flow' | 'structure' | 'radix' | 'judge'
  passed: boolean
  judge: JudgeVerdict | null
  /** 審査そのものの消費。「計測にいくらかかったか」を実装の消費と分けて見るため */
  judgeUsage: Usage | null
  judge_cost_usd: number | null
}

export interface RunSummary {
  runId: string
  target: string
  /** 知見とプロンプトの版。これが違う試行は条件が揃っていないので直接比較できない */
  promptVersion: string
  /**
   * 試行の条件。env で切り替えていたものを記録しないと、
   * あとから結果を条件ごとに分けられない（実測で分けられなくなった）。
   */
  conditions: {
    /** none = 知見なし / cold = 一般知見のみ / hot = 固有の実測値込み */
    knowledge: string
    /** A = 段階分けなし / B = 構造抽出→骨格→精緻化 */
    variant: string
    /** 過去の試行・知見原本・他ターゲットから隔離して回したか（H-20 以降は true） */
    isolated?: boolean
    /** Claude Agent SDK の版 */
    sdkVersion?: string
    /** 指定したモデル名（'opus' などのエイリアス） */
    modelAlias?: string
    /** 実際に解決されたモデルID。エイリアスは時期で別モデルを指す */
    model?: string
    /** 参照を測る道具を渡さなかった（アブレーション） */
    noProbe?: boolean
    /** Radix の指定とゲートを外した（アブレーション） */
    noRadix?: boolean
    /** layoutDiff の閾値を上書きした値 */
    layoutThreshold?: number
  }
  /** 試行開始時のライブラリの版と部品数。手持ちの部品が違えば必要な作業量も違う */
  libraryVersionBefore: string
  libraryComponentsBefore: number
  /** 試行終了時。差が「この試行で増えた部品」 */
  libraryVersionAfter: string
  libraryComponentsAfter: number
  startedAt: string
  finishedAt: string
  converged: boolean
  /** 収束したターン。未収束なら null */
  turnsToConverge: number | null
  turnsRun: number
  /** ブレイン+builder の消費（審査は含まない） */
  totals: Usage & { total_cost_usd: number }
  /** 審査の消費。計測系のオーバーヘッド */
  judgeTotals: Usage & { total_cost_usd: number }
  best: { turn: number; rawDiff: number; layoutDiff: number; layoutMad: number }
  /** 撮影した状態の名前 */
  stateNames: string[]
  thresholds: { rawDiff: number; layoutDiff: number }
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
  }
}

export async function appendMetric(file: string, metric: TurnMetric): Promise<void> {
  await appendFile(file, `${JSON.stringify(metric)}\n`, 'utf8')
}

export async function writeSummary(file: string, summary: RunSummary): Promise<void> {
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
}

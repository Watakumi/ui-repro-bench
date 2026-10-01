/**
 * 実装ソースの「構造の質」を測る。
 *
 * ピクセル差分だけで判定すると、エージェントは絶対配置で参照をなぞるのが最短だと
 * 正しく学習する。実測（run 08-18-03）では absolute が 10→34、flex/grid が 30→13、
 * Radix の使用が 1→0 になり、1ターンで「収束」した。指標は下がらず judge も見抜けなかった。
 *
 * UIとして成立しているかは、ピクセルの一致とは別に測る必要がある。
 */

export interface StructureScore {
  /** absolute 指定の数 */
  absoluteCount: number
  /** flex / grid の数 */
  flexGridCount: number
  /** absolute / (absolute + flex + grid)。高いほど「なぞっている」 */
  absoluteRatio: number
  /** radix-ui からの import の数 */
  radixImports: number
  /** [123px] のような直値の数 */
  pxLiterals: number
  lines: number
  /** 絶対配置でのトレースとみなすか */
  tracing: boolean
}

const RE = {
  absolute: /\babsolute\b/g,
  flexGrid: /\b(?:flex|grid)\b/g,
  radix: /from ['"]radix-ui['"]/g,
  px: /\[[\d.]+px\]/g,
}

function count(source: string, re: RegExp): number {
  return source.match(re)?.length ?? 0
}

export function analyzeStructure(source: string, maxAbsoluteRatio: number): StructureScore {
  const absoluteCount = count(source, RE.absolute)
  const flexGridCount = count(source, RE.flexGrid)
  const denom = absoluteCount + flexGridCount
  const absoluteRatio = denom === 0 ? 0 : absoluteCount / denom

  return {
    absoluteCount,
    flexGridCount,
    absoluteRatio,
    radixImports: count(source, RE.radix),
    pxLiterals: count(source, RE.px),
    lines: source.split('\n').length,
    tracing: absoluteRatio > maxAbsoluteRatio,
  }
}

export function describeStructure(s: StructureScore, max: number): string {
  return [
    `absolute ${s.absoluteCount} / flex・grid ${s.flexGridCount}`,
    `絶対配置の比率 ${(s.absoluteRatio * 100).toFixed(0)}%（上限 ${(max * 100).toFixed(0)}%）`,
    `Radix ${s.radixImports}箇所 / px直値 ${s.pxLiterals} / ${s.lines}行`,
  ].join(' · ')
}

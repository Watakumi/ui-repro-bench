import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeStructure } from './structure.ts'

/**
 * Goodhart G-1 の回帰テスト。
 *
 * 座標を直接指定して参照をなぞる実装は、ピクセル差分だけは下がるが
 * UIとして成立していない。絶対配置の比率で捕まえる。
 */
const tracing = Array.from(
  { length: 10 },
  (_, i) => `<div className="absolute left-[${i * 10}px] top-[${i * 20}px]" />`,
).join('\n')

const flexed = Array.from({ length: 10 }, () => `<div className="flex items-center gap-4" />`).join('\n')

test('絶対配置だらけの実装はトレースとして検出される（G-1）', () => {
  const s = analyzeStructure(tracing, 0.4)
  assert.equal(s.tracing, true, '上限 40% を超えているのに検出されていない')
  assert.ok(s.absoluteRatio > 0.4)
})

test('flex / grid で組んだ実装はトレースにしない', () => {
  const s = analyzeStructure(flexed, 0.4)
  assert.equal(s.tracing, false)
})

test('上限を変えれば判定も変わる', () => {
  assert.equal(analyzeStructure(tracing, 1).tracing, false, '上限1なら何も引っかからないはず')
})

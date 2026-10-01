import assert from 'node:assert/strict'
import { test } from 'node:test'
import { numberedVariants, radixSatisfied } from './components.ts'

/**
 * 失敗カタログ H-12 の回帰テスト。
 *
 * 連番の検出が「数字で終わる名前」だけを見ていたため、
 * 1つしかない SectionH2 を連番コピペと誤判定し、ターンを1つ無駄にした。
 * 同じ語幹が2つ以上あるときだけ連番とみなす。
 */
test('同じ語幹が2つ以上あるときだけ連番とみなす（H-12）', () => {
  assert.deepEqual(numberedVariants(['Thumb1', 'Thumb2', 'Thumb3']).sort(), ['Thumb1', 'Thumb2', 'Thumb3'])
})

test('数字で終わっても1つだけなら連番ではない（H-12 の誤検出）', () => {
  assert.deepEqual(numberedVariants(['SectionH2', 'Header', 'Card']), [])
})

test('語幹が違えば連番にしない', () => {
  assert.deepEqual(numberedVariants(['Row1', 'Col1']), [])
})

/**
 * 失敗カタログ H-18 の回帰テスト。
 *
 * 抽出エージェントは Form と Label を両方挙げるが、Radix の Form.Label は
 * Label そのもの。別物として数えていたため、Form に寄せた実装で
 * 「Label を落とした」と判定し、設定画面で2回ともターンが1つ増えた。
 */
test('Form を使っていれば Label は満たしたとみなす（H-18）', () => {
  assert.equal(radixSatisfied('Label', ['Form', 'Tabs']), true)
})

test('役割が違う primitive は代用にならない', () => {
  assert.equal(radixSatisfied('Dialog', ['Form', 'Tabs']), false)
})

test('そのものを使っていれば当然満たす', () => {
  assert.equal(radixSatisfied('Tabs', ['Tabs']), true)
})

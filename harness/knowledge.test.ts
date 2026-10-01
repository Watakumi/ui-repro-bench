import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadKnowledge, maskHex, maskMeasurements } from './knowledge.ts'

/**
 * 失敗カタログ H-7 の回帰テスト。
 *
 * 知見に「この参照の CTA は #176bf5」のような実測値が混ざっていると、
 * 測れるのは「保存した答えを貼れるか」になる。実際そうなっていた。
 */
test('16進カラーコードは伏せる（H-7: 知見に答えが混入していた）', () => {
  assert.equal(maskHex('CTA は #176bf5 です'), 'CTA は #______ です')
})

test('座標つきの実測値は伏せる（H-7）', () => {
  assert.equal(maskMeasurements('CTA(900,1258) を測る'), 'CTA(x,y) を測る')
  assert.equal(maskMeasurements('参照 21.0 / 実装 22.5'), '参照 ○○ / 実装 △△')
})

test('伏せても文脈は残る', () => {
  const masked = maskHex('ブランド色を記憶から書かない。実測は #1677ff だった')
  assert.ok(masked.includes('ブランド色を記憶から書かない'), '理由まで消してはいけない')
})

/**
 * 汎用と固有を混ぜていたため、「知見でターン数が減る」が
 * 抽出元のターゲットでしか再現しなかった。モードで切り分ける。
 */
test('none は蓄積を一切渡さない', async () => {
  const k = await loadKnowledge('github-repo', 'none')
  assert.equal(k.text, '')
  assert.equal(k.targetFactsIncluded, false)
})

test('general はターゲット固有の知見を含めない', async () => {
  const k = await loadKnowledge('github-repo', 'general')
  assert.equal(k.targetFactsIncluded, false)
})

test('旧称 cold は general と同じ扱い（過去の記録との互換）', async () => {
  const [a, b] = await Promise.all([
    loadKnowledge('github-repo', 'cold'),
    loadKnowledge('github-repo', 'general'),
  ])
  assert.equal(a.text, b.text)
})

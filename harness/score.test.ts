import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutBlurRadius, pct } from './score.ts'

/**
 * 失敗カタログ H-1 の回帰テスト。
 *
 * ぼかし半径を 3px に固定していたため、差分が字形の差で埋まり、
 * 配置の差が見えていなかった。画像幅に比例させて初めて効くようになった。
 */
test('ぼかし半径は画像幅の 1/100（H-1: 3px 固定では効かなかった）', () => {
  assert.equal(layoutBlurRadius(2940), 29)
  assert.equal(layoutBlurRadius(1470), 15)
  // 幅が変わっても半径が変わらない実装は、この比較で落ちる
  assert.notEqual(layoutBlurRadius(2940), layoutBlurRadius(1470))
})

test('小さい画像でも下限 3px を割らない', () => {
  // 0 にすると、ぼかしが効かず字形の差がそのまま差分に出る
  assert.equal(layoutBlurRadius(100), 3)
  assert.equal(layoutBlurRadius(1), 3)
})

test('pct は割合を百分率の文字列にする', () => {
  assert.equal(pct(0.0123), '1.23%')
  assert.equal(pct(0), '0.00%')
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { ROOT } from './config.ts'

/**
 * 汎用の知見にターゲット固有の名前が混ざっていないかを機械で守る。
 *
 * 混ざったまま測っていたせいで、「知見でターン数が減る」が
 * 抽出元のターゲットでしか成り立たない結論になっていた。
 * 分離は目視では保てないので、ここで落とす。
 */
test('GENERAL.md にサービス名が混ざっていない', async () => {
  const p = path.join(ROOT, 'harness', 'knowledge', 'GENERAL.md')
  const text = await readFile(p, 'utf8')
  assert.ok(text.length > 0, 'GENERAL.md が空')

  const forbidden = /newspicks|ant\s*design|antd|grafana|github|Picks/i
  const leaks = text
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter(({ text: l }) => forbidden.test(l))

  assert.deepEqual(
    leaks.map((l) => `${l.line}: ${l.text.trim().slice(0, 60)}`),
    [],
    'ターゲット固有の名前は targets/<slug>.md に書く',
  )
})

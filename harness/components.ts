import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { SANDBOX_APP, UI_PACKAGE_SRC, type RadixSpec } from './config.ts'

/**
 * コンポーネントの質を測る。
 *
 * 画面が参照と一致するかだけを見ていると、実測（run 08-50-16）のように
 * 507行1ファイル・Thumb1〜Thumb5 という「コピペをコンポーネントの形にしただけ」の
 * 実装でも満点になる。目的が再利用できる部品を作ることなら、そこを別に測る必要がある。
 */

export interface ComponentInfo {
  name: string
  file: string
  /** props を受け取るか。取らないものは特定画面専用の可能性が高い */
  hasProps: boolean
  /** プロジェクト全体での使用回数 */
  uses: number
}

export interface ComponentScore {
  /** lib/ から export されている部品 */
  library: ComponentInfo[]
  /** App.tsx の中だけで定義されている部品 */
  local: ComponentInfo[]
  /** App.tsx が lib から import している部品の数 */
  reusedFromLibrary: number
  /** props を取らない部品の数。多いほど画面専用で再利用できない */
  propslessCount: number
  /** 1回しか使われていない部品の数 */
  singleUseCount: number
  /** Thumb1, Card2 のように末尾が数字の部品。props にすべきものの兆候 */
  numberedVariants: string[]
  /** 使っている Radix primitive の種類 */
  radixPrimitives: string[]
  /** 期待した primitive のうち、実際に使われたもの */
  radixExpectedUsed: string[]
  /** 期待したのに使われていないもの */
  radixExpectedMissing: string[]
  appLines: number
  libLines: number
  /**
   * ライブラリの版。lib/ の中身から作る。
   * ライブラリは試行をまたいで育つので、これが違う試行は
   * 「手持ちの部品」が違う。必要プロンプト数を比較するには揃っている必要がある。
   */
  libraryVersion: string
}

const COMPONENT_RE = /(?:export\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9]*)\s*[({=]/g
const PROPS_RE = /(?:function|const)\s+NAME\s*(?:=\s*)?\(\s*(\{[^)]*\}|[a-z][A-Za-z]*\s*:)/

async function readTree(dir: string): Promise<{ file: string; source: string }[]> {
  const out: { file: string; source: string }[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await readTree(full)))
    else if (/\.tsx?$/.test(e.name)) out.push({ file: full, source: await readFile(full, 'utf8') })
  }
  return out
}

function findComponents(file: string, source: string): { name: string; hasProps: boolean }[] {
  const found: { name: string; hasProps: boolean }[] = []
  for (const m of source.matchAll(COMPONENT_RE)) {
    const name = m[1]!
    // OLIVE や NAV のような全大文字の定数は部品ではない
    if (name === name.toUpperCase()) continue
    // 定数（大文字始まりでも JSX を返さないもの）を除くため、JSX を含むかで絞る
    const after = source.slice(m.index, m.index + 1200)
    if (!/<[A-Za-z]/.test(after)) continue
    const propsRe = new RegExp(PROPS_RE.source.replace('NAME', name))
    found.push({ name, hasProps: propsRe.test(source) })
  }
  return found
}

/**
 * 連番コピペの検出。
 *
 * 末尾が数字というだけで拾うと SectionH2（h2 を出す単一部品）まで引っかかる。
 * 実測で誤検出した。Thumb1 / Thumb2 のように「同じ語幹の部品が2つ以上」あるときだけ
 * 連番とみなす。
 */
/**
 * 連番の部品（Thumb1, Thumb2 …）を拾う。
 * 同じ語幹が2つ以上あるときだけ連番とみなす。
 * 1つだけの SectionH2 を連番と誤検出して、ターンを1つ無駄にしたことがある（H-12）。
 */
export function numberedVariants(names: string[]): string[] {
  const byStem = new Map<string, string[]>()
  for (const n of names) {
    const m = /^([A-Za-z]+?)(\d+)$/.exec(n)
    if (!m) continue
    byStem.set(m[1]!, [...(byStem.get(m[1]!) ?? []), n])
  }
  return [...byStem.values()].filter((g) => g.length >= 2).flat()
}

/**
 * 同じ役割の primitive は同一視する。
 * 抽出エージェントは Form と Label を両方挙げるが、Form.Label は Label そのもの。
 * 分けて数えていたため、Form に寄せた実装で Label を「落とした」と判定し、
 * 設定画面で2回ともターンが1つ増えた（H-18）。
 */
const SATISFIED_BY: Record<string, string[]> = { Label: ['Form'] }

export function radixSatisfied(expected: string, used: string[]): boolean {
  return used.includes(expected) || (SATISFIED_BY[expected] ?? []).some((alt) => used.includes(alt))
}

export async function analyzeComponents(radix?: RadixSpec): Promise<ComponentScore> {
  const appSource = await readFile(SANDBOX_APP, 'utf8').catch(() => '')
  const libFiles = await readTree(UI_PACKAGE_SRC)
  const libSource = libFiles.map((f) => f.source).join('\n')
  const all = appSource + '\n' + libSource

  const countUses = (name: string) =>
    (all.match(new RegExp(`<${name}[\\s/>]`, 'g')) ?? []).length

  const toInfo = (file: string) => (c: { name: string; hasProps: boolean }): ComponentInfo => ({
    name: c.name,
    file: path.basename(file),
    hasProps: c.hasProps,
    uses: countUses(c.name),
  })

  const library = libFiles.flatMap((f) =>
    findComponents(f.file, f.source)
      // index.ts の re-export だけの行を拾わないよう、定義のあるファイルに限る
      .filter(() => !f.file.endsWith('index.ts'))
      .map(toInfo(f.file)),
  )
  const local = findComponents(SANDBOX_APP, appSource).map(toInfo(SANDBOX_APP))

  const importedFromLib = appSource.match(/from\s+['"]@ui-bench\/ui['"]/g) ?? []
  const reusedFromLibrary = importedFromLib.length
    ? (appSource.match(/import\s*\{([^}]*)\}\s*from\s*['"]@ui-bench\/ui/s)?.[1] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean).length
    : 0

  const everything = [...library, ...local]

  // import 名だけでなく実際の使用も見る。import して使っていないのは充足ではない。
  const usedPrimitives = [
    ...new Set(
      (all.match(/import\s*\{([^}]*)\}\s*from\s*['"]radix-ui['"]/g) ?? [])
        .flatMap((m) => (m.match(/\{([^}]*)\}/)?.[1] ?? '').split(','))
        .map((x) => x.trim().split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean),
    ),
  ]
  const expected = radix?.expected.map((e) => e.primitive) ?? []
  // 同じ役割の primitive は同一視する。抽出エージェントは Form と Label を両方挙げるが、
  // Form.Label は Label そのものなので、Form に寄せた実装で Label を「落とした」と数えない
  // （設定画面で2回とも、Form を足したら Label が消えて1ターン増えた）。
  const satisfied = (e: string) => radixSatisfied(e, usedPrimitives)
  const radixExpectedUsed = [...new Set(expected.filter(satisfied))]
  const radixExpectedMissing = [...new Set(expected.filter((e) => !satisfied(e)))]

  const hash = createHash('sha256')
  for (const f of [...libFiles].sort((a, b) => a.file.localeCompare(b.file))) {
    hash.update(f.file).update(f.source)
  }

  return {
    library,
    local,
    reusedFromLibrary,
    propslessCount: everything.filter((c) => !c.hasProps).length,
    singleUseCount: everything.filter((c) => c.uses <= 1).length,
    numberedVariants: numberedVariants(everything.map((c) => c.name)),
    radixPrimitives: usedPrimitives,
    radixExpectedUsed,
    radixExpectedMissing,
    appLines: appSource.split('\n').length,
    libLines: libSource.split('\n').filter(Boolean).length,
    libraryVersion: hash.digest('hex').slice(0, 12),
  }
}

export function describeComponents(c: ComponentScore): string {
  return [
    `lib ${c.library.length}個（${c.libLines}行, 版 ${c.libraryVersion}）`,
    `App内 ${c.local.length}個（${c.appLines}行）`,
    `libから再利用 ${c.reusedFromLibrary}`,
    `props無し ${c.propslessCount}`,
    `Radix ${c.radixPrimitives.length ? c.radixPrimitives.join('・') : 'なし'}`,
    c.radixExpectedMissing.length
      ? `未使用 ${c.radixExpectedMissing.join('・')}`
      : c.radixExpectedUsed.length
        ? '期待した primitive は全部使用'
        : '',
    c.numberedVariants.length ? `⚠連番 ${c.numberedVariants.join(',')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

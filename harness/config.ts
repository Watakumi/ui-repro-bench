import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SANDBOX_DIR = path.join(ROOT, 'sandbox')
export const SANDBOX_APP = path.join(SANDBOX_DIR, 'src', 'App.tsx')
/**
 * 再利用コンポーネントのパッケージ。試行をまたいで残る。
 * App.tsx は毎回リセットするが、ここはリセットしない。
 *
 * sandbox とは別パッケージにしてあるので、アプリ側のファイルを import できない。
 * 画面専用の部品が紛れ込むことを、規約ではなく構造で防いでいる。
 */
export const UI_PACKAGE = path.join(ROOT, 'packages', 'ui')
export const UI_PACKAGE_SRC = path.join(UI_PACKAGE, 'src')
export const APP_PLACEHOLDER = path.join(ROOT, 'harness', 'templates', 'App.placeholder.tsx')
export const RUNS_DIR = path.join(ROOT, 'runs')
export const TARGETS_DIR = path.join(ROOT, 'targets')

/**
 * そのモジュールが直接実行されたか。
 * campaign から import しても main() が走らないようにするため。
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href
}

/** 参照として受け付ける拡張子。UI Pocket の書き出しが webp なので webp を含める。 */
const REFERENCE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg']

export interface Thresholds {
  /** 正規化後の素のピクセル差分率の上限 (0-1) */
  rawDiff: number
  /** グレースケール+ぼかし後の差分率の上限 (0-1) */
  layoutDiff: number
}

/** 撮影前に行う操作。状態を作るために使う。 */
export type Action =
  | { type: 'scroll'; y: number }
  | { type: 'click'; selector?: string; text?: string }
  | { type: 'hover'; selector?: string; text?: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }

/**
 * 撮影する状態。
 *
 * 静止画1枚だけを見ていると、挙動を持つ部品（ドロップダウン、タブ）を
 * 素の div で組んでも差が出ない。状態を分けて撮ることで、
 * 閉じた見た目だけでなく開いた見た目も判定に入る。
 */
export interface StateSpec {
  name: string
  /** この状態の参照画像。省略すると reference-<name>.<ext> を探す */
  reference?: string
  /** 撮影前の操作。省略すると素の初期状態を撮る */
  actions?: Action[]
  /** この状態を説明する短い文。ブレインへのフィードバックに出る */
  note?: string
}

/** 参照UIの要素と、対応する Radix primitive の対応表 */
export interface RadixExpectation {
  element: string
  primitive: string
  note?: string
}

export interface RadixSpec {
  /** Radix で作れるはずの要素 */
  expected: RadixExpectation[]
  /** Radix の出番がない要素。なぜ無いのかを残す */
  notApplicable?: { element: string; reason: string }[]
}

export interface StructureLimits {
  /**
   * 絶対配置の比率の上限。これを超えたらレイアウトを組まずに
   * 座標でなぞっているとみなし、収束させない。
   */
  maxAbsoluteRatio: number
}

export interface TargetSpec {
  slug: string
  title: string
  notes: string
  /** サンドボックス上で撮影するパス */
  route: string
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  colorScheme: 'dark' | 'light'
  thresholds: Thresholds
  maxTurns: number
  maxBudgetUsd: number
  structure: StructureLimits
  /** Radix UI で作れるはずの要素の一覧。充足率を測るために使う */
  radix?: RadixSpec
  /**
   * 縦に連なった参照断片。同じ1ページをスクロールしながら撮ったもの。
   * 指定すると、実装をフルページで撮って各断片の位置を探索する方式になる。
   */
  slices?: string[]
  /**
   * 撮影の前に一度だけ行う操作。参照が「ある状態に入ったあと」の
   * スクロールショットである場合に使う。
   *
   * 実測で、参照6枚のうち 01 と 02 のあいだに状態変化（「続きを読む」を押す）が
   * 挟まっていることが分かった。1ページとして繋げという出題は、
   * 同時に存在できない2状態を要求していて、満たせる実装が存在しなかった。
   */
  enterActions?: Action[]
  /**
   * 撮影する状態の一覧。省略すると、既定の1状態（操作なし）だけになる。
   * 参照画像は reference.<ext>（既定状態）と reference-<name>.<ext>（各状態）。
   */
  states?: StateSpec[]
  /** 撮影をページ全体にするか。参照が縦長スクショならこれを true にする。 */
  fullPage?: boolean
}

/** 解決済みの状態。参照画像のパスが確定している。 */
export interface ResolvedState {
  name: string
  referencePath: string
  actions: Action[]
  note?: string
}

export interface Target {
  dir: string
  spec: TargetSpec
  /** 解決済みの参照断片。slices 指定があるときだけ埋まる */
  slices: { name: string; file: string }[]
  /** 既定状態の参照。後方互換のために残している */
  referencePath: string
  states: ResolvedState[]
}

const DEFAULTS = {
  route: '/',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  thresholds: { rawDiff: 0.05, layoutDiff: 0.02 },
  maxTurns: 10,
  maxBudgetUsd: 5,
  structure: { maxAbsoluteRatio: 0.4 },
} satisfies Partial<TargetSpec>

/**
 * targets/<slug>/ を読む。reference.<ext> は拡張子を決め打ちせず走査するので、
 * 参照画像の形式を変えても target.json を触らずに済む。
 */
export async function loadTarget(targetDir: string): Promise<Target> {
  const dir = path.resolve(targetDir)
  const raw = JSON.parse(await readFile(path.join(dir, 'target.json'), 'utf8')) as Partial<TargetSpec>

  const spec: TargetSpec = {
    ...DEFAULTS,
    slug: raw.slug ?? path.basename(dir),
    title: raw.title ?? path.basename(dir),
    notes: raw.notes ?? '',
    ...raw,
    thresholds: { ...DEFAULTS.thresholds, ...raw.thresholds },
    viewport: { ...DEFAULTS.viewport, ...raw.viewport },
    structure: { ...DEFAULTS.structure, ...raw.structure },
  } as TargetSpec

  const entries = await readdir(dir)

  /** basename（拡張子なし）に一致する参照画像を探す */
  const findReference = (base: string): string | undefined => {
    const hit = entries.find(
      (e) =>
        path.basename(e, path.extname(e)) === base &&
        REFERENCE_EXTENSIONS.includes(path.extname(e).toLowerCase()),
    )
    return hit ? path.join(dir, hit) : undefined
  }

  const referencePath = findReference('reference')
  if (!referencePath) {
    throw new Error(
      `参照画像が見つかりません: ${dir}/reference{${REFERENCE_EXTENSIONS.join(',')}}`,
    )
  }

  // 状態が定義されていなければ、既定の1状態だけを持つものとして扱う
  const specs: StateSpec[] = spec.states?.length
    ? spec.states
    : [{ name: 'default', actions: [] }]

  const states: ResolvedState[] = specs.map((st) => {
    const explicit = st.reference ? path.join(dir, st.reference) : undefined
    const resolved =
      explicit ??
      (st.name === 'default' ? referencePath : findReference(`reference-${st.name}`))
    if (!resolved) {
      throw new Error(
        `状態 "${st.name}" の参照画像が見つかりません: ${dir}/reference-${st.name}.{png,webp,jpg}\n` +
          '参照を用意するか、target.json の states からこの状態を外してください。',
      )
    }
    return { name: st.name, referencePath: resolved, actions: st.actions ?? [], note: st.note }
  })

  const slices = (spec.slices ?? []).map((f) => ({
    name: path.basename(f, path.extname(f)).replace(/^slice-/, ''),
    file: path.join(dir, f),
  }))

  return { dir, spec, referencePath, states, slices }
}

/**
 * slug からターゲットのディレクトリを探す。
 * 直下だけでなく _archived / _fixtures も見る。
 * 廃止したターゲットの過去 run を再計算できなくならないようにするため。
 */
export async function findTargetDir(slug: string): Promise<string | null> {
  const candidates = [
    path.join(TARGETS_DIR, slug),
    path.join(TARGETS_DIR, '_archived', slug),
    path.join(TARGETS_DIR, '_fixtures', slug),
  ]
  for (const dir of candidates) {
    try {
      await readFile(path.join(dir, 'target.json'), 'utf8')
      return dir
    } catch {
      // 次を試す
    }
  }
  return null
}

/** ファイル名に使える形の実行ID。コロンを含むと macOS/Finder で扱いづらいので置換する。 */
export function makeRunId(slug: string): string {
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  return `${stamp}_${slug}`
}

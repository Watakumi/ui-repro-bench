import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ROOT, RUNS_DIR, findTargetDir, isEntrypoint } from './config.ts'
import { aggregate, collectRuns, type ConditionStat, type RunRow } from './report.ts'
import type { StructureScore } from './structure.ts'

/**
 * 試行のゴール（参照UI）と成果物（実装スクショ）を並べたページを組み立てる。
 * 画像は web 用に縮小して assets/ に書き出す。
 *
 *   pnpm gallery [--target <slug>]
 *
 * 出力: runs/_report/index.html + runs/_report/assets/
 */

const REPORT_DIR = path.join(RUNS_DIR, '_report')
const ASSETS_DIR = path.join(REPORT_DIR, 'assets')
const IMAGE_WIDTH = 1200

interface Plate extends RunRow {
  index: number
  goalAsset: string
  builtAsset: string | null
  diffAsset: string | null
  learningsLines: number
  structure: StructureScore | null
}

async function emit(src: string, name: string): Promise<string> {
  await sharp(src).resize({ width: IMAGE_WIDTH }).webp({ quality: 82 }).toFile(path.join(ASSETS_DIR, name))
  return `assets/${name}`
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`)
const num = (v: number) => v.toLocaleString('en-US')

async function buildPlates(rows: RunRow[]): Promise<Plate[]> {
  await mkdir(ASSETS_DIR, { recursive: true })
  const plates: Plate[] = []

  for (const [i, r] of rows.entries()) {
    const runDir = path.join(RUNS_DIR, r.runId)
    const targetDir = (await findTargetDir(r.target)) ?? path.join(ROOT, 'targets', r.target)

    const refName = (await readdir(targetDir)).find((f) => f.startsWith('reference'))
    const goalAsset = refName
      ? await emit(path.join(targetDir, refName), `goal-${r.target}.webp`)
      : ''

    // 断片モードの run は turn-NN.png を作らず turn-NN.full.png だけを残す。
    // 片方しか見ていなかったため、断片モードの成果物が全部欠けていた。
    const entries = await readdir(runDir)
    const viewport = entries.filter((f) => /^turn-\d+\.png$/.test(f)).sort()
    const fullPage = entries.filter((f) => /^turn-\d+\.full\.png$/.test(f)).sort()
    const last = viewport.at(-1) ?? fullPage.at(-1)
    const builtAsset = last ? await emit(path.join(runDir, last), `built-${i + 1}.webp`) : null

    const diffName = last?.replace('.png', '.layout-diff.png')
    const diffAsset =
      diffName && entries.includes(diffName)
        ? await emit(path.join(runDir, diffName), `diff-${i + 1}.webp`)
        : null

    const used = await readFile(path.join(runDir, 'LEARNINGS.used.md'), 'utf8').catch(() => '')

    const lastMetric = (await readFile(path.join(runDir, 'metrics.jsonl'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .at(-1)
    const structure = lastMetric
      ? ((JSON.parse(lastMetric) as { structure?: StructureScore }).structure ?? null)
      : null

    plates.push({
      ...r,
      index: i + 1,
      goalAsset,
      builtAsset,
      diffAsset,
      learningsLines: used ? used.trim().split('\n').length : 0,
      structure,
    })
  }

  return plates
}

function plateHtml(p: Plate): string {
  const judge = p.judgeScores
    ? `<div class="judge"><span class="judge-label">judge</span>${Object.entries(p.judgeScores)
        .map(([k, v]) => `<span class="judge-item"><b>${esc(k)}</b><i>${v}</i></span>`)
        .join('')}</div>`
    : ''

  return `<figure class="plate">
  <div class="plate-head">
    <span class="plate-no">試行 ${p.index}</span>
    <span class="target-tag">知見 ${KNOWLEDGE_LABEL[p.knowledge] ?? esc(p.knowledge)}${p.isolated ? ' · 隔離あり' : ''}</span>
    <span class="ver" title="プロンプトと知見の版">${esc(p.promptVersion)}</span>
    <span class="state ${p.harnessFailure ? 'broken' : p.converged ? 'ok' : 'no'}" ${p.harnessFailure ? `title="${esc(p.harnessFailure)}"` : ''}>${p.harnessFailure ? 'ハーネス失敗' : p.converged ? '収束' : '未収束'}</span>
    <span class="knowledge">${p.learningsLines ? `知見 ${p.learningsLines}行` : '知見なし'}</span>
  </div>

  <div class="pair">
    <div class="shot">
      <span class="shot-label goal">ゴール</span>
      ${p.goalAsset ? `<img src="${p.goalAsset}" alt="参照UI" loading="lazy">` : ''}
    </div>
    <div class="shot">
      <span class="shot-label built">成果物</span>
      ${p.builtAsset ? `<img src="${p.builtAsset}" alt="実装の最終スクリーンショット" loading="lazy">` : '<p class="missing">スクリーンショットなし</p>'}
    </div>
  </div>

  <figcaption>
    <dl class="stats">
      <div><dt>ターン</dt><dd>${p.turnsToConverge ?? p.turnsRun}</dd></div>
      <div><dt>layoutDiff</dt><dd>${pct(p.firstTurnLayoutDiff)} <span class="arrow">→</span> <b>${pct(p.bestLayoutDiff)}</b></dd></div>
      <div><dt>出力</dt><dd>${num(p.outputTokens)} <span class="unit">tok</span></dd></div>
      <div><dt>履歴読込</dt><dd>${num(p.cacheReadTokens)} <span class="unit">tok</span></dd></div>
      <div><dt>推定</dt><dd>$${p.estCostUsd.toFixed(2)}</dd></div>
      <div><dt>所要</dt><dd>${p.durationMin.toFixed(0)} <span class="unit">分</span></dd></div>
      ${p.structure ? `<div><dt>絶対配置</dt><dd class="${p.structure.tracing ? 'trace' : ''}">${(p.structure.absoluteRatio * 100).toFixed(0)}<span class="unit">%</span></dd></div>
      <div><dt>Radix</dt><dd>${p.structure.radixImports}</dd></div>` : ''}
    </dl>
    ${p.structure?.tracing ? '<p class="warn">絶対配置で参照をなぞっている。ピクセル差分は下がるが、UIとして成立していない。</p>' : ''}
    ${judge}
  </figcaption>
</figure>`
}

interface Failure {
  kind: 'G' | 'H'
  no: number
  title: string
}

function parseFailures(md: string): Failure[] {
  const out: Failure[] = []
  for (const m of md.matchAll(/^## (G|H)-(\d+) (.+)$/gm)) {
    out.push({ kind: m[1] as 'G' | 'H', no: Number(m[2]), title: m[3]!.trim() })
  }
  return out
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

/**
 * ターゲットの素性。
 *
 * 「1ビューポートの記事」と「5画面ぶんのページ全体」と「ダッシュボード」は別の問題で、
 * ターン数を並べても意味がない。資料はターゲットごとに章を分け、
 * その章の中だけで条件（知見・隔離）を比較する。
 */
interface TargetInfo {
  slug: string
  /** 資料での表示名 */
  title: string
  /** 元ページの <title> */
  sourceTitle: string
  kind: string
  note: string
  viewport: string
  references: number
  colorScheme: string
  radixExpected: number
  archived: boolean
  /** 参照画像を資料に載せてよいか。商用サイトの記事本文や写真が写るものは false */
  publishable: boolean
}

/** 何の画面かは target.json から読めないので、ここだけ人が書く */
const TARGET_NOTES: Record<string, { name: string; kind: string; note: string }> = {
  'antd-pro-analysis': {
    name: 'ダッシュボード｜Ant Design Pro / Analysis',
    kind: 'ダッシュボード',
    note: 'Ant Design Pro の分析ページ。折れ線・棒・円・ミニエリアの各チャートを、チャートライブラリ抜きの SVG で描かせる',
  },
  'grafana-play': {
    name: 'ダークダッシュボード｜Grafana Play',
    kind: 'ダッシュボード（ダーク）',
    note: 'Grafana Play のホーム。唯一のダークUI。動画サムネイル・人物写真・入れ子のミニダッシュボードを含む',
  },
  'antd-pro-form-advanced': {
    name: 'フォーム｜Ant Design Pro / Advanced Form',
    kind: 'フォーム',
    note: '3カラムのフォームを3枚のカードに積み、下端にすりガラスの固定フッターバー。入力・セレクト・日付レンジが並ぶ',
  },
  'antd-pro-settings': {
    name: '設定画面｜Ant Design Pro / Account Settings',
    kind: '設定画面',
    note: '縦タブ＋フォームの2カラム。参照がちょうど1ビューポート（956px）に収まる',
  },
  'newspicks-article-reading': {
    name: '記事・5断片｜NewsPicks 本文展開後',
    kind: '記事（本文展開後・5断片）',
    note: '「続きを読む」を押してから、1本の記事を上から5か所で撮った参照。断片ごとに画面を作って並べる不正を検出する必要がある',
  },
  'newspicks-article-preview': {
    name: '記事・1画面｜NewsPicks プレビュー',
    kind: '記事（プレビュー）',
    note: '本文が折りたたまれた状態の1ビューポート',
  },
  'newspicks-article-top': {
    name: '記事・1画面｜NewsPicks トップ',
    kind: '記事（トップ・廃止）',
    note: '1ビューポートのみ。ライブラリ蓄積後は 9/9 が1ターンで飽和したため廃止',
  },
  'newspicks-article-full': {
    name: '記事・6断片｜NewsPicks ページ全体',
    kind: '記事（ページ全体・廃止）',
    note: '参照6枚が状態変化（本文の折りたたみ）を跨いでおり、満たせる実装が存在しない出題だった。廃止',
  },
}

async function loadTargetInfo(slug: string): Promise<TargetInfo> {
  const dir = (await findTargetDir(slug)) ?? path.join(ROOT, 'targets', slug)
  const raw = await readFile(path.join(dir, 'target.json'), 'utf8').catch(() => '{}')
  const t = JSON.parse(raw) as {
    title?: string
    viewport?: { width: number; height: number }
    slices?: unknown[]
    colorScheme?: string
    radix?: { expected?: unknown[] }
    publishable?: boolean
  }
  const meta = TARGET_NOTES[slug] ?? { name: slug, kind: '—', note: '' }
  return {
    slug,
    title: meta.name,
    sourceTitle: t.title ?? slug,
    kind: meta.kind,
    note: meta.note,
    viewport: t.viewport ? `${t.viewport.width}×${t.viewport.height}` : '—',
    references: t.slices?.length || 1,
    colorScheme: t.colorScheme ?? 'light',
    radixExpected: t.radix?.expected?.length ?? 0,
    archived: dir.includes('_archived'),
    // 既定は非公開。載せてよいものだけ明示する
    publishable: t.publishable === true,
  }
}

const KNOWLEDGE_LABEL: Record<string, string> = {
  none: 'なし',
  cold: '汎用のみ',
  hot: '汎用＋答案',
  '?': '（記録なし）',
}

/** 条件表。ターゲット別の章の中で呼ぶので、ターゲット列は持たない */
function conditionRows(stats: ConditionStat[]): string {
  return stats
    .map((c) => {
      // 解決あたり費用（費用 ÷ 収束率）。未収束の費用を無視すると効果を過大評価する（HarnessTax の指標に合わせた）
      const perSolve = c.converged ? (c.avgCostUsd * c.n) / c.converged : null
      return `<tr>
      <td>${KNOWLEDGE_LABEL[c.knowledge] ?? esc(c.knowledge)}</td>
      <td class="mono">${esc(c.variant)}</td>
      <td class="${c.isolated ? 'ok-text' : 'no-text'}">${c.isolated ? 'あり' : 'なし'}</td>
      <td class="mono">${c.n}</td>
      <td class="mono ${c.converged === c.n ? 'ok-text' : 'no-text'}">${c.converged}/${c.n}</td>
      <td class="mono">${c.turns.join(', ') || '—'}</td>
      <td class="mono strong">${c.median ?? '—'}</td>
      <td class="mono">$${c.avgCostUsd.toFixed(2)}</td>
      <td class="mono">${c.avgBuilderCalls === null ? '—' : c.avgBuilderCalls.toFixed(0)}</td>
      <td class="mono">${c.avgFirstMad === null ? '—' : `${(c.avgFirstMad * 100).toFixed(2)}%`}</td>
      <td class="mono strong">${c.avgFinalMad === null ? '—' : `${(c.avgFinalMad * 100).toFixed(2)}%`}</td>
      <td class="mono">${c.avgJudge === null ? '—' : c.avgJudge.toFixed(1)}</td>
      <td class="mono">${perSolve === null ? '—' : `$${perSolve.toFixed(2)}`}</td>
      <td class="mono broken-text">${c.broken || ''}</td>
    </tr>`
    })
    .join('\n')
}

/** 1ターゲットぶんの章 */
function targetSection(info: TargetInfo, plates: Plate[], stats: ConditionStat[]): string {
  const broken = plates.filter((p) => p.harnessFailure)
  const scored = plates.filter((p) => !p.harnessFailure)
  const converged = scored.filter((p) => p.converged)
  const best = scored.reduce<Plate | null>(
    (a, p) => (a === null || p.bestLayoutDiff < a.bestLayoutDiff ? p : a),
    null,
  )
  const goal = plates.find((p) => p.goalAsset)?.goalAsset

  const runRows = plates
    .map(
      (p) => `<tr>
      <td class="mono">${p.index}</td>
      <td>${KNOWLEDGE_LABEL[p.knowledge] ?? esc(p.knowledge)}</td>
      <td class="${p.isolated ? 'ok-text' : 'no-text'}">${p.isolated ? 'あり' : 'なし'}</td>
      <td class="mono ver-cell">${esc(p.promptVersion)}</td>
      <td class="${p.harnessFailure ? 'broken-text' : p.converged ? 'ok-text' : 'no-text'}" ${p.harnessFailure ? `title="${esc(p.harnessFailure)}"` : ''}>${p.harnessFailure ? '⊘' : p.converged ? '✔' : '✖'}</td>
      <td class="mono">${p.turnsToConverge ?? p.turnsRun}</td>
      <td class="mono">${p.innerTurnsFirst ?? '—'}</td>
      <td class="mono">${pct(p.firstTurnLayoutDiff)}</td>
      <td class="mono strong">${pct(p.bestLayoutDiff)}</td>
      <td class="mono ${p.structure?.tracing ? 'no-text' : ''}">${p.structure ? `${(p.structure.absoluteRatio * 100).toFixed(0)}%` : '—'}</td>
      <td class="mono">$${p.estCostUsd.toFixed(2)}</td>
    </tr>`,
    )
    .join('\n')

  return `
  <section class="target" id="${esc(info.slug)}">
    <h2>${esc(info.title)}${info.archived ? ' <span class="badge">廃止</span>' : ''}</h2>
    <div class="target-head">
      ${info.publishable && goal ? `<img class="target-thumb" src="${goal}" alt="${esc(info.title)}の参照UI" loading="lazy">` : '<div class="target-thumb noimg">画像は非掲載</div>'}
      <div class="target-meta">
        <p class="note">${esc(info.note)}</p>
        <p class="note src">元ページ: ${esc(info.sourceTitle)}</p>
        <dl class="chips">
          <div><dt>種類</dt><dd>${esc(info.kind)}</dd></div>
          <div><dt>参照</dt><dd>${info.references}<span class="unit"> 枚</span></dd></div>
          <div><dt>画面</dt><dd>${esc(info.viewport)}<span class="unit"> / ${esc(info.colorScheme)}</span></dd></div>
          <div><dt>Radix 期待</dt><dd>${info.radixExpected}<span class="unit"> 種</span></dd></div>
          <div><dt>試行</dt><dd>${scored.length}${broken.length ? `<span class="unit"> +${broken.length}除外</span>` : ''}</dd></div>
          <div><dt>収束</dt><dd class="${converged.length === scored.length ? 'ok-text' : 'no-text'}">${converged.length}<span class="unit"> / ${scored.length}</span></dd></div>
          <div><dt>最良 layoutDiff</dt><dd>${best ? pct(best.bestLayoutDiff) : '—'}</dd></div>
        </dl>
      </div>
    </div>

    <h3>条件別</h3>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>知見</th><th>変種</th><th>隔離</th><th>n</th><th>収束</th>
          <th>ターン</th><th>中央値</th><th>平均$</th><th>builder呼び出し</th>
          <th>初手の誤差</th><th>最終の誤差</th><th>judge</th><th>解決あたり$</th><th>除外</th>
        </tr></thead>
        <tbody>
${conditionRows(stats)}
        </tbody>
      </table>
    </div>

    <h3>試行</h3>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>#</th><th>知見</th><th>隔離</th><th>版</th><th>収束</th><th>ターン</th>
          <th>内側往復</th><th>1回目</th><th>最良</th><th>絶対配置</th><th>推定$</th>
        </tr></thead>
        <tbody>
${runRows}
        </tbody>
      </table>
    </div>

    <h3>ゴールと成果物</h3>
${
  info.publishable
    ? plates.map(plateHtml).join('\n')
    : `<p class="note noimg-note">このターゲットは商用サイトの記事ページで、参照画像に本文と写真が写る。
       数値は載せるが、<b>参照UIと成果物の画像は掲載しない</b>。`
}
  </section>`
}

function page(
  plates: Plate[],
  stats: ConditionStat[],
  failures: Failure[],
  infos: TargetInfo[],
): string {
  // ハーネスの失敗は「エージェントが収束できなかった」ではないので分母から外す
  const broken = plates.filter((p) => p.harnessFailure)
  const scored = plates.filter((p) => !p.harnessFailure)
  const converged = scored.filter((p) => p.converged)
  const isolated = scored.filter((p) => p.isolated)

  const order = [...infos].sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      plates.filter((p) => p.target === b.slug).length -
        plates.filter((p) => p.target === a.slug).length,
  )

  const indexRows = order
    .map((t) => {
      const mine = plates.filter((p) => p.target === t.slug)
      const ok = mine.filter((p) => !p.harnessFailure && p.converged).length
      const n = mine.filter((p) => !p.harnessFailure).length
      return `<tr class="${t.archived ? 'dim' : ''}">
      <td><a href="#${esc(t.slug)}">${esc(t.title)}</a>${t.archived ? ' <span class="badge">廃止</span>' : ''}</td>
      <td>${esc(t.kind)}</td>
      <td class="mono">${t.references}</td>
      <td class="mono">${esc(t.colorScheme)}</td>
      <td class="mono">${t.radixExpected}</td>
      <td class="mono">${n}</td>
      <td class="mono ${ok === n ? 'ok-text' : 'no-text'}">${ok}/${n}</td>
    </tr>`
    })
    .join('\n')

  return `<title>UI再現ベンチ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+JP:wght@400;500;600;700&display=swap">
<style>
  :root {
    --ground: #faf7f9;
    --panel: #ffffff;
    --sunken: #f2edf0;
    --line: #e3d9de;
    --line-strong: #cbbcc3;
    --ink: #1b151a;
    --ink-soft: #6a5c64;
    --ink-faint: #94868d;
    --accent: #d6006e;
    --accent-soft: #fbe6f0;
    --ok: #1f7a55;
    --no: #a8620a;
    --shadow: 0 1px 2px rgba(27, 21, 26, .06), 0 8px 24px -16px rgba(27, 21, 26, .3);
    --sans: "IBM Plex Sans JP", ui-sans-serif, system-ui, "Hiragino Sans", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #141014;
      --panel: #1d181c;
      --sunken: #241e23;
      --line: #342c32;
      --line-strong: #4a3f46;
      --ink: #f2eaee;
      --ink-soft: #b3a4ac;
      --ink-faint: #7d6f76;
      --accent: #ff4fa3;
      --accent-soft: #3a1228;
      --ok: #4cc08c;
      --no: #e0a04a;
      --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px -16px rgba(0, 0, 0, .8);
    }
  }
  :root[data-theme="dark"] {
    --ground: #141014;
    --panel: #1d181c;
    --sunken: #241e23;
    --line: #342c32;
    --line-strong: #4a3f46;
    --ink: #f2eaee;
    --ink-soft: #b3a4ac;
    --ink-faint: #7d6f76;
    --accent: #ff4fa3;
    --accent-soft: #3a1228;
    --ok: #4cc08c;
    --no: #e0a04a;
    --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px -16px rgba(0, 0, 0, .8);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: clamp(32px, 6vw, 72px) clamp(20px, 4vw, 40px) 96px; }

  .masthead { display: flex; flex-direction: column; gap: 14px; }
  .eyebrow {
    font-family: var(--mono); font-size: 12px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--accent);
  }
  h1 {
    margin: 0; font-size: clamp(30px, 4.4vw, 44px); font-weight: 700;
    letter-spacing: -.02em; line-height: 1.2; text-wrap: balance;
  }
  .lede { margin: 0; max-width: 62ch; color: var(--ink-soft); font-size: 16px; }

  .headline {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1px; margin: 36px 0 0; background: var(--line);
    border: 1px solid var(--line); border-radius: 3px; overflow: hidden;
  }
  .headline div { background: var(--panel); padding: 16px 18px; }
  .headline dt { margin: 0; font-size: 12px; color: var(--ink-faint); letter-spacing: .04em; }
  .headline dd {
    margin: 4px 0 0; font-family: var(--mono); font-size: 24px;
    font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .headline .unit { font-size: 13px; color: var(--ink-faint); font-weight: 400; }

  h2 {
    margin: 0 0 6px; font-size: 13px; font-weight: 600;
    font-family: var(--mono); letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink-soft); padding-bottom: 8px; border-bottom: 1px solid var(--line-strong);
  }
  .section { margin-top: 64px; }
  h3 { margin: 28px 0 4px; font-size: 15px; font-weight: 600; }
  .note { margin: 14px 0 0; max-width: 68ch; color: var(--ink-soft); font-size: 14px; }

  /* ターゲットの章 */
  .target { margin-top: 72px; scroll-margin-top: 16px; }
  .target > h2 {
    font-family: var(--sans); font-size: 20px; font-weight: 700; letter-spacing: -.01em;
    text-transform: none; color: var(--ink); border-bottom: 2px solid var(--accent); padding-bottom: 10px;
  }
  .badge {
    font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .06em;
    padding: 2px 7px; border-radius: 2px; background: var(--sunken); color: var(--ink-faint);
    vertical-align: middle;
  }
  .target-head { display: grid; grid-template-columns: minmax(0, 240px) minmax(0, 1fr); gap: 24px; margin-top: 18px; align-items: start; }
  @media (max-width: 720px) { .target-head { grid-template-columns: 1fr; } }
  .target-thumb { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 3px; }
  .target-thumb.noimg {
    display: grid; place-items: center; aspect-ratio: 3 / 2; background: var(--sunken);
    color: var(--ink-faint); font-size: 12.5px; border-style: dashed;
  }
  .noimg-note { padding: 14px 16px; background: var(--sunken); border-radius: 3px; max-width: none; }
  .target-meta .note { margin-top: 0; }
  .target-meta .src { margin-top: 6px; font-size: 12.5px; color: var(--ink-faint); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px 28px; margin: 14px 0 0; }
  .chips div { display: flex; flex-direction: column; }
  .chips dt { font-size: 11px; color: var(--ink-faint); letter-spacing: .04em; }
  .chips dd { margin: 0; font-family: var(--mono); font-size: 15px; font-variant-numeric: tabular-nums; }
  .chips .unit { font-size: 12px; color: var(--ink-faint); }

  .scroll { overflow-x: auto; margin-top: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 9px 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--line); }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
  thead th {
    font-size: 11px; font-weight: 500; letter-spacing: .06em; color: var(--ink-faint);
    text-transform: uppercase; border-bottom: 1px solid var(--line-strong);
  }
  tbody tr:hover { background: var(--sunken); }
  tr.dim td { color: var(--ink-faint); }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .strong { font-weight: 600; color: var(--accent); }
  .ver-cell { color: var(--ink-faint); font-size: 12.5px; }
  .ok-text { color: var(--ok); } .no-text { color: var(--no); } .broken-text { color: var(--ink-faint); }

  .plate { margin: 24px 0 0; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; box-shadow: var(--shadow); overflow: hidden; }
  .plate-head {
    display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
    padding: 13px 18px; border-bottom: 1px solid var(--line); background: var(--sunken);
  }
  .plate-no { font-weight: 600; font-size: 14px; }
  .ver { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  .state { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 2px; }
  .state.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .state.no { color: var(--no); background: color-mix(in srgb, var(--no) 14%, transparent); }
  .state.broken { color: var(--ink-faint); background: var(--sunken); }
  .knowledge { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }

  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
  .shot { position: relative; background: var(--panel); padding: 0; min-width: 0; }
  .shot img { display: block; width: 100%; height: auto; }
  .shot-label {
    position: absolute; top: 10px; left: 10px; z-index: 1;
    font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 2px; color: #fff;
  }
  .shot-label.goal { background: #1b151a; }
  .shot-label.built { background: var(--accent); }
  .missing { margin: 0; padding: 40px; color: var(--ink-faint); text-align: center; }

  figcaption { padding: 4px 18px 16px; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 30px; margin: 12px 0 0; }
  .stats div { display: flex; flex-direction: column; }
  .stats dt { font-size: 11px; color: var(--ink-faint); letter-spacing: .04em; }
  .stats dd { margin: 0; font-family: var(--mono); font-size: 15px; font-variant-numeric: tabular-nums; }
  .stats .unit, .stats .arrow { color: var(--ink-faint); font-size: 12px; font-weight: 400; }
  .stats b { color: var(--accent); }
  .stats .trace { color: var(--no); }

  .judge { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line-strong); }
  .judge-label { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); margin-right: 4px; }
  .judge-item { font-size: 13px; color: var(--ink-soft); }
  .judge-item i { font-style: normal; font-family: var(--mono); font-weight: 600; color: var(--ink); margin-left: 5px; font-variant-numeric: tabular-nums; }

  .target-tag {
    font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 2px;
    background: var(--accent-soft); color: var(--accent);
  }
  .target-cell { font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; }
  .warn {
    margin: 12px 0 0; padding: 9px 12px; font-size: 13px;
    color: var(--no); background: color-mix(in srgb, var(--no) 10%, transparent);
    border-radius: 2px;
  }
  .caveat {
    margin-top: 20px; padding: 16px 18px; border-left: 2px solid var(--accent);
    background: var(--accent-soft); border-radius: 0 3px 3px 0;
  }
  .caveat p { margin: 0; font-size: 14px; max-width: 66ch; }
  .caveat p + p { margin-top: 10px; }
  .fail-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 40px; margin-top: 6px; }
  .fail-cols h3 { margin-top: 18px; }
  .fail-cols ol { margin: 8px 0 0; padding-left: 1.4em; font-size: 14px; color: var(--ink-soft); }
  .fail-cols li { margin: 3px 0; }
  footer { margin-top: 72px; padding-top: 18px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
</style>

<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">UI reproduction bench</span>
    <h1>参考UIの再現に、<br>プロンプトは何回必要か</h1>
    <p class="lede">
      参照スクリーンショットを渡し、ブレインが差分を読んで builder に指示を出す。
      これを収束するまで繰り返し、必要なターン数とトークンを記録する。
      <b>問題ごとに章を分けてある</b>。規模も難易度も違うので、比較は章の中だけで成立する。
    </p>
  </header>

  <dl class="headline">
    <div><dt>試行</dt><dd>${scored.length}</dd></div>
    <div><dt>ターゲット</dt><dd>${infos.length}</dd></div>
    <div><dt>収束</dt><dd>${converged.length}<span class="unit"> / ${scored.length}</span></dd></div>
    <div><dt>隔離あり</dt><dd>${isolated.length}<span class="unit"> 件</span></dd></div>
    <div><dt>ハーネス失敗</dt><dd>${broken.length}<span class="unit"> 件は除外</span></dd></div>
    <div><dt>失敗カタログ</dt><dd>${failures.length}<span class="unit"> 件</span></dd></div>
  </dl>

  <div class="section">
    <h2>問い</h2>
    <p class="note">
      参照UIのスクリーンショットを渡したとき、Claude Code は<b>何回の指示</b>で同じ画面を作れるか。
      「同じ」の判定は人の目ではなく、ぼかし差分・DOM のフロー検査・絶対配置比率・Radix primitive の使用・
      LLM 審査の5段のゲートで機械的に行う。ゲートを1つでも落とせば、差分の説明を付けてもう1回指示する。
    </p>

    <h3>「1ターン」の中で起きていること</h3>
    <p class="note">
      ターンはハーネスが差分を突き返した回数（外側のループ）で、LLM の呼び出し回数ではない。
      1ターンの内側では brain が参照を実測して数値表を builder に渡し、builder が組んで自分で撮り、
      参照と同じ座標を走査して直す。収束した試行の1ターン目の内側のやりとりは
      <b>中央値 ${median(converged.map((p) => p.innerTurnsFirst ?? 0).filter(Boolean)) ?? '—'} 往復</b>。
      「1ターンで収束」は、外から突き返す必要がなかった、という意味である。
    </p>

    <h3>比較してよい範囲</h3>
    <p class="note">
      比較が成立するのは<b>同じターゲット・同じ隔離状態・同じプロンプト世代・同じモデル</b>の中だけ。
      実測で、<span class="mono">model: 'opus'</span> の解決先が試験の途中で
      <span class="mono">claude-opus-5</span> から <span class="mono">claude-opus-5-5</span> に替わり、
      費用が 5〜10 分の1になっていた（H-24）。隔離ありの試行はすべて後者で揃っている。
      ターゲットが違えば問題が違い、隔離なしの試行はエージェントが過去の試行や抽出結果に届き得た（H-20）。
      版（プロンプトと知見のハッシュ）が違う試行も、与えた知見が違うので傾向としてだけ読む。
    </p>

    <h3>いまの答え</h3>
    <p class="note">
      測りたかったのは「知見を渡すとターン数が減るか」。だがターン数だけを見ていたのが狭かった。
      蓄積知見が実際に動かしていたのは<b>「1ターン目の精度」</b>で、
      それが画面によってターン数の削減になったり、品質の上積みになったりしていた。
      どの条件でも手順そのもの（測ってから書く・flex / grid で組む・撮って検算する・probe の使い方、
      約4,600字）は<b>プロンプトに常に入っている</b>。<span class="mono">なし</span>は知識ゼロではなく「蓄積なし」。
    </p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>ターゲット</th><th>蓄積知見</th><th>n</th><th>ターン中央値</th>
          <th>初手の誤差</th><th>最終の誤差</th><th>judge</th><th>平均$</th><th>builder呼び出し</th>
        </tr></thead>
        <tbody>
          <tr><td>記事5断片（非公開素材）</td><td>なし</td><td class="mono">10</td><td class="mono strong">3</td><td class="mono">4.08%</td><td class="mono">2.05%</td><td class="mono">87.2</td><td class="mono">$11.20</td><td class="mono">68</td></tr>
          <tr><td>記事5断片（非公開素材）</td><td>あり</td><td class="mono">12</td><td class="mono strong">1</td><td class="mono">2.09%</td><td class="mono">1.80%</td><td class="mono">88.7</td><td class="mono">$8.67</td><td class="mono">80</td></tr>
          <tr class="dim"><td colspan="9"></td></tr>
          <tr><td>GitHub 5断片</td><td>なし</td><td class="mono">5</td><td class="mono strong">1</td><td class="mono">0.81%</td><td class="mono">0.53%</td><td class="mono">92.5</td><td class="mono">$2.91</td><td class="mono">26</td></tr>
          <tr><td>GitHub 5断片</td><td>汎用のみ 396行</td><td class="mono">3</td><td class="mono strong">1</td><td class="mono">0.45%</td><td class="mono">0.45%</td><td class="mono">93.7</td><td class="mono">$4.58</td><td class="mono">58</td></tr>
          <tr><td>GitHub 5断片</td><td>汎用＋この画面の固有</td><td class="mono">1</td><td class="mono strong">1</td><td class="mono">0.45%</td><td class="mono">0.45%</td><td class="mono">94.2</td><td class="mono">$5.52</td><td class="mono">76</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note">
      <b>共通しているのは初手の誤差</b>。蓄積知見を渡すと、1ターン目の時点での誤差がおよそ半分になる
      （記事 4.08% → 2.09%、GitHub 0.81% → 0.45%）。その先が画面によって分かれる。
    </p>
    <div class="caveat">
      <p>
        <b>手順だけでは届かない画面</b>（記事5断片）では、初手の精度がそのまま<b>ターン数の削減</b>になった。
        3 ターン → 1 ターン、費用も $11.20 → $8.67 と<b>安くなる</b>。
      </p>
      <p>
        <b>手順だけで届く画面</b>（GitHub）では、ターン数はもう 1 なので減らしようがない。
        代わりに<b>品質が上がる</b> — 最終誤差 0.53% → 0.45%、judge 92.5 → 94.2。
        費用は $2.91 → $5.52、内側の作業は 26 → 76 回に増える。
      </p>
      <p>
        つまり知見は「税」ではなく<b>品質を買っている</b>。
        ただし GitHub 側の差は小さく（誤差で 0.08 ポイント、judge で 1.7 点）、n も 5 / 3 / 1 と少ない。
        <b>その品質差に $2.6 払う価値があるかは、作るものによる</b>。
      </p>
    </div>

    <h3>これは Opus の話で、モデルを変えると成り立たない</h3>
    <p class="note">
      同じ問題・同じ条件（蓄積知見なし・隔離あり）でモデルだけを替えた。
    </p>
    <div class="scroll">
      <table>
        <thead><tr><th>モデル</th><th>収束</th><th>ターン</th><th>費用</th><th>最終 layoutMad</th></tr></thead>
        <tbody>
          <tr><td>Opus 5.5</td><td class="ok-text">収束</td><td class="mono strong">1</td><td class="mono">$2</td><td class="mono">0.49%</td></tr>
          <tr><td>Sonnet 5 ①</td><td class="no-text">未収束</td><td class="mono">11</td><td class="mono">$89</td><td class="mono">2.14%</td></tr>
          <tr><td>Sonnet 5 ②</td><td class="no-text">未収束</td><td class="mono">12</td><td class="mono">$165</td><td class="mono">2.86%</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note mono" style="font-size:13px">
      Sonnet ① 9.05 → 9.05 → 8.93 → 2.66 → 2.36 → 1.64 → 1.93 → 1.63 → 2.14 → 2.14 → 2.14<br>
      Sonnet ② 9.35 → 9.35 → 3.06 → 3.23 → 3.06 → 3.06 → 3.07 → 3.84 → 3.22 → 2.27 → 2.28 → 2.86
    </p>
    <p class="note">
      Sonnet は序盤で 9% から 2〜3% まで詰めたあと、<b>1.6〜3% を往復して止まる</b>（閾値は1%）。
      直すと別の場所が壊れる状態で、12ターン・$165 かけても収束しなかった。費用は Opus の <b>44〜82 倍</b>。
      <b>「手順プロンプトだけで1ターン」は Opus 固有の性質</b>で、ベンチ自体は Sonnet に対しては十分に機能していた。
    </p>

    <h3>汎用と固有は、分けて初めて測れた</h3>
    <p class="note">
      当初は1つのファイル（1,066行）に混ざっていた。そのため「知見の効果」を測ると、
      抽出元のターゲットでしか再現しない結論が出た。仕分けエージェントで
      <b>汎用 396行（33項目・サービス名ゼロ）</b>と<b>ターゲット別 約220件</b>に分け、
      汎用にターゲット名が混ざっていないかを selftest で機械的に検査するようにした。
      分けたうえで測ると、汎用だけでもターンは減らず費用は 1.6 倍だった。
    </p>

    <h3>ここに至るまでに、結論は3回ひっくり返った</h3>
    <div class="caveat">
      <p>
        <b>1回目</b>（9/26）: 隔離すると効果が消えた、と書いた。根拠は n=2。
        <b>2回目</b>（9/28 朝）: 取り直したら効果が戻った（1,1,1 対 6,6,3）。1回目は1世代前のプロンプトの n=2 だった。
        <b>3回目</b>（9/29）: 別ターゲットで測ったら効果が消えた。2回目の結論は<b>ターゲット固有</b>だった。
        <b>4回目</b>（同日）: 汎用と固有を分けて測り直し、「効果は無く費用だけ増えた」と書いた。
        だがそれは<b>ターン数しか見ていなかったから</b>で、
        品質（最終誤差・judge）を並べると単調に上がっていた。
        <b>指標を1つしか見ないと、上がっているものを「無駄」と読む</b>。
      </p>
      <p>
        比較が成立するのは<b>ターゲット・隔離状態・プロンプト世代・モデル</b>の4つが揃った中だけで、
        さらに<b>結論をターゲットの外へ持ち出せるかは別に確かめる</b>必要がある。
        n を増やしても、それは同じターゲットの中の確からしさが上がるだけだった。
      </p>
    </div>

    <h3>では知見は効いていないのか</h3>
    <p class="note">
      外側のターン数では見えないが、<b>1ターンの内側の作業量には差が出る</b>。
      builder への呼び出し回数（下の条件表の列）を隔離ありで比べると、
      アプリ画面では知見ありが少ない — フォーム 104 回 対 145 回（−28%）、
      設定 90 回 対 154 回（−42%）。どちらも外側は1ターンで、従来の指標では差が見えなかった。
      ただし5断片の記事では逆に増える（101 回 対 82 回）。
      外側のターン数と内側の作業量は別々に動く、というのがここで見えることで、
      どちらも n が小さいので方向の目安まで。
      なお、この差も GitHub では確かめていない。
    </p>
  </div>

  <div class="section">
    <h2>ターゲット</h2>
    <p class="note">
      8つのターゲットを、1ビューポートの記事・5断片のページ・ダッシュボード・フォーム・設定画面から選んだ。
      廃止したものも、過去の試行を再計算できるよう残してある。
    </p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>ターゲット</th><th>種類</th><th>参照</th><th>配色</th><th>Radix 期待</th><th>試行</th><th>収束</th>
        </tr></thead>
        <tbody>
${indexRows}
        </tbody>
      </table>
    </div>
  </div>

${order
  .map((t) =>
    targetSection(
      t,
      plates.filter((p) => p.target === t.slug),
      stats.filter((c) => c.target === t.slug),
    ),
  )
  .join('\n')}

  <div class="section">
    <h2>想定される質問</h2>
    <p class="note">
      読んだ人が最初に疑うところを、推測で答えずに実験した。すべて GitHub リポジトリページ・
      蓄積知見なし・隔離ありで、対照を同じバッチに入れて測っている。
    </p>
    <div class="scroll">
      <table>
        <thead><tr><th>質問</th><th>答え</th><th>根拠</th></tr></thead>
        <tbody>
          <tr><td>モデルを変えても成り立つのか</td><td class="no-text">成り立たない</td><td>Opus 1ターン $2 / Sonnet 未収束 11〜12ターン $89〜165</td></tr>
          <tr><td>計測の道具を渡しているから1ターンなのでは</td><td class="ok-text">違う</td><td>probe を外しても 2, 1, 1 ターン（$3.80 / $1.46 / $1.38）</td></tr>
          <tr><td>Radix を強制するのは余計な負担では</td><td class="ok-text">負担は見えない</td><td>指定とゲートを外しても 2, 1 ターン。対照と同等</td></tr>
          <tr><td>審査が LLM なら採点はぶれるのでは</td><td class="no-text">ぶれる</td><td>同じ成果物を3回採点して平均点の幅 0.8。<b>スコアで条件を比べない</b></td></tr>
          <tr><td>収束の閾値が甘いのでは</td><td class="ok-text">甘くはない</td><td>layoutDiff 1% → 0.2%（5倍厳しく）でも 1, 1 ターン</td></tr>
          <tr><td>関門は本当に効いているのか</td><td class="no-text">1つは効いていない</td><td>312ターンを集計。絶対配置の関門は<b>発火 0 回</b>（保険として残す）</td></tr>
        </tbody>
      </table>
    </div>
    <p class="note">
      最後の2つは自分の計測を否定する側の結果で、どちらもこの資料の主張を弱めている。
      judge のスコア差（1.7点）は judge 自身のぶれ（0.8点）の2倍しかないので、
      品質の根拠は<b>LLM を介さない layoutMad に一本化</b>した。
    </p>
  </div>

  <div class="section">
    <h2>失敗カタログ</h2>
    <p class="note">
      G は指標が満点なのに成果物が劣化していたもの（Goodhart）。H は計測する側の欠陥。
      無駄になったターンの大半は H だった。全文は <span class="mono">harness/knowledge/FAILURES.md</span>。
    </p>
    <div class="fail-cols">
      <div>
        <h3>G · 指標をすり抜けた ${failures.filter((f) => f.kind === 'G').length}件</h3>
        <ol>${failures
          .filter((f) => f.kind === 'G')
          .map((f) => `<li>${esc(f.title)}</li>`)
          .join('')}</ol>
      </div>
      <div>
        <h3>H · 計測側の欠陥 ${failures.filter((f) => f.kind === 'H').length}件</h3>
        <ol>${failures
          .filter((f) => f.kind === 'H')
          .map((f) => `<li>${esc(f.title)}</li>`)
          .join('')}</ol>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>読むときの注意</h2>
    <div class="caveat">
      <p>
        <b>layoutDiff</b> は、両者をグレースケール化してぼかしてから比べた不一致率。
        ぼかし半径は画像幅の1/100。フォントの字形差を潰し、配置と寸法の差だけを見る。
        素のピクセル差分（rawDiff）はフォント差で9%前後から下がらず、判定に使えない。
      </p>
      <p>
        <b>推定$</b> は Claude Agent SDK が内蔵の定価表で出す推定値で、請求額ではない
        （実行は Claude サブスクリプション）。絶対額として引用できる根拠はまだなく、試行間の相対比較にだけ使う。
      </p>
      <p>
        <b>解決あたり$</b> は 平均$ ÷ 収束率。未収束に使った費用を無視すると、条件の効果を過大評価する。
      </p>
      <p>
        <b>n が小さい</b>。各条件 1〜5 件なので、ターン数の差が条件の効果なのか偶然なのかは区別できない。
        言えるのは「この条件でこうなった」までで、一般化には反復が要る。
      </p>
    </div>
  </div>

  <footer>生成 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ui-bench</footer>
</div>`
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

export async function buildGallery(targetFilter?: string): Promise<string> {
  const rows = await collectRuns(targetFilter)
  if (rows.length === 0) throw new Error('試行がまだありません。')
  const plates = await buildPlates(rows)
  const failures = parseFailures(
    await readFile(path.join(ROOT, 'harness', 'knowledge', 'FAILURES.md'), 'utf8').catch(() => ''),
  )
  const slugs = [...new Set(rows.map((r) => r.target))]
  const infos = await Promise.all(slugs.map(loadTargetInfo))
  const out = path.join(REPORT_DIR, 'index.html')
  await writeFile(out, page(plates, aggregate(rows), failures, infos), 'utf8')
  return out
}

async function main(): Promise<void> {
  const out = await buildGallery(flag('target'))
  console.log(out)
  console.log(`  画像: ${ASSETS_DIR}`)
}

if (isEntrypoint(import.meta.url)) await main()

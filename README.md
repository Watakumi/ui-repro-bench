# ui-bench

Reproduce a UI from a reference screenshot, and **decide mechanically whether it worked**.

Plenty of tools turn a screenshot into code. Almost none of them judge the result —
a human looks at it and decides. Here the verdict is five gates. Fail one and the
agent gets another turn with the diff attached. What gets recorded is the number of
prompts it took, what it cost, and how close it landed.

> 日本語版は [README.ja.md](README.ja.md) にあります。

```
reference ──▶ brain (reads the diff, writes the instruction)
                 │
                 ├─▶ builder (edits sandbox/src/App.tsx)
                 │
             capture ──▶ five gates ──▶ pass: converged / fail: one more turn
```

## The gates

| Gate | What it looks at | What it throws away |
| --- | --- | --- |
| pixel `layoutDiff` | grayscale + blur, then diff | glyph shapes — **and hue** |
| pixel `rawDiff` | raw diff | nothing; this is the only gate that catches a wrong colour |
| flow | DOM: inner scrollers, duplicated headers, duplicated headings | — |
| structure | ratio of absolutely-positioned nodes | — |
| components | whether the expected Radix primitives are actually used | — |
| judge | an LLM compares reference and result | — |

Each gate exists because an implementation walked through the previous ones with a
perfect score and was still wrong. The whole history is in
[`harness/knowledge/FAILURES.md`](harness/knowledge/FAILURES.md).

## Usage

```sh
pnpm install
pnpm exec playwright install chromium

# Capture a reference. Third-party screenshots are not shipped — take your own.
pnpm target:add my-target https://example.com
pnpm target:add my-target https://example.com --scroll 0,820,1640,2460   # long page, in slices
pnpm capture:states my-target                                           # stateful (needs states.json)

# Inventory which elements map to which primitive
pnpm extract targets/my-target --write

# Run
pnpm trial targets/my-target
UI_BENCH_KNOWLEDGE=none pnpm trial targets/my-target   # without accumulated knowledge

# Look
pnpm report      # per-condition aggregate
pnpm gallery     # HTML with reference and result side by side
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `UI_BENCH_KNOWLEDGE` | `general` | `none` nothing accumulated / `general` transferable only / `full` plus this target's specifics |
| `UI_BENCH_VARIANT` | `A` | `A` single phase / `B` extract → skeleton → refine |
| `UI_BENCH_MODEL` | `opus` | Model alias. The resolved id is recorded in `summary.json` |
| `UI_BENCH_NO_PROBE` | — | `1` withholds the measuring tools (ablation) |
| `UI_BENCH_NO_RADIX` | — | `1` drops the Radix requirement and its gate |
| `UI_BENCH_NO_ISOLATION` | — | `1` disables isolation |
| `UI_BENCH_LAYOUT_THRESHOLD` | per target | overrides the `layoutDiff` threshold |

## Making the measurement trustworthy

Most of the effort in this repository went into the measuring side, not the generating side.

- **`pnpm selftest <target> <known-good App.tsx>`** — checks the harness itself without
  spending a single agent call: that the trial entrypoint even loads, that reflection
  isn't piling up, that the general knowledge has no target names leaking into it.
- **Isolation** — during a trial the knowledge originals, the other targets, the extraction
  output and every past result are moved out of the repository. Proving the conditions were
  equal means showing they were **unreachable**, not that you deleted something.
  `pnpm isolate:restore` recovers after a crash.
- **`pnpm audit:gates`** — counts how often each gate actually rejected a turn. Counting
  showed the absolute-positioning gate had fired **zero times in 312 turns** (kept as insurance).
- **`pnpm judge:repeat <runId>`** — scores the same result repeatedly to measure the LLM
  judge's own noise. It moves by 0.8 points, so **the scores are not used to compare conditions**.
- **`pnpm reflect --pending`** — distils knowledge out of finished trials. Let it pile up and
  selftest fails, so the next batch cannot start.
- **`pnpm trace`** — counts the round trips *inside* one turn, where differences hide that the
  outer turn count cannot show.

## Knowledge is split: transferable vs. target-specific

| | Contents |
| --- | --- |
| [`harness/knowledge/GENERAL.md`](harness/knowledge/GENERAL.md) | Procedure, technique and failure modes that hold on any target. **No service names** — selftest enforces this |
| `harness/knowledge/targets/<slug>.md` | Measured values, coordinates, per-slice differences for one screen |

While the two were mixed, the data said "knowledge cuts the number of turns." It only
reproduced on the target the knowledge had been distilled from. Splitting them is what
made transferability measurable at all.

## What the numbers said

- **The conclusion depends on the model.** Same task, same conditions: Opus 5.5 converged in
  1 turn for $2; Sonnet 5 ran 11–12 turns for $89–165 and never converged.
- Accumulated knowledge improves **first-turn accuracy** (roughly halves the error). On a
  screen the base procedure cannot reach, that becomes fewer turns; on one it can reach, it
  becomes a little more quality for more money.
- **Most of the wasted turns were defects in the measurement, not the agent** — 5 cases of
  the agent gaming a metric against 30 defects in the harness itself.

## Why the reference screenshots are not in the repository

Rights differ site by site. Only `target.json` is committed — capture settings, thresholds,
expected primitives. The images come from `pnpm target:add` on your machine.

## Layout

```
harness/        measurement and the trial loop
  knowledge/    knowledge (general / per target) and the failure catalogue
targets/        target specs (images are gitignored)
sandbox/        where the implementation goes. React 19 + Tailwind v4 + Radix UI
packages/ui/    component library that survives across trials
docs/           decisions, with the numbers behind them
articles/       draft write-up
```

## Licence

MIT. The third-party UIs referenced from `targets/` remain under their own terms.

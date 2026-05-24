# Plan — Variant comparison mode

> **Status: proposed.** Not yet started. This document captures the design for a `quiver compare` subcommand that captures screenshots of the same screens under multiple variant conditions and outputs a side-by-side comparison viewer.

## Problem

Design teams working in code (SwiftUI / Jetpack Compose) can build realistic prototypes quickly, but comparing multiple visual variants of a style, component, or flow is painful. There's no easy way to see 3–5 alternatives side-by-side in context. Designers end up manually screenshotting, pasting into Keynote/Figma, and losing the connection to the running code.

## Goal

A new `quiver compare` subcommand that:

1. Accepts a set of **variant sources** (git branches, build flavors, or inline theme/token overrides).
2. For each variant, captures screenshots of **only the specified screens** (not the full graph).
3. Outputs a self-contained **comparison viewer** — a grid of variants per screen, with labels, optional pixel-diff overlay, and a "select this one" action.

The output is an HTML artifact similar to the existing flow map viewer but purpose-built for comparison rather than navigation mapping.

## Variant sources

Two primary approaches, prioritized by practicality for design teams working in code:

### Primary: Git branches (zero setup)

Each variant is a branch. The tool checks out each branch, builds, captures the target screens, and restores:

```bash
npx quiver compare --branches main,variant/compact-cards,variant/airy-cards \
                   --screens home,messages
```

This requires no configuration file and no prototype-side changes. The code differences on each branch ARE the variants. Designers already work this way — branching to try something is natural — so the tool meets them where they are.

**Strengths:**
- Works immediately with any prototype, any change (visual, structural, navigational).
- No ceremony — just branch, make changes, run compare.
- Supports arbitrarily complex differences between variants (not limited to parametric changes).

**Limitations:**
- Branch management overhead with 4–5+ variants (naming, keeping in sync with main, merge conflicts).
- Each branch requires a full build, so comparison time scales linearly with variant count.
- If variants only differ by a few token values, maintaining separate branches is more overhead than necessary.

**Practical tips for designers:**
- Use a naming convention like `variant/<feature>/<name>` (e.g. `variant/card-style/compact`).
- Keep variant branches short-lived — compare, pick, merge the winner, delete the rest.
- If your variants diverge from main significantly, rebase before comparing so the diff is clean.

### Secondary: Token/theme overrides (variants.yaml)

For teams that have invested in a design-token layer, a `variants.yaml` in the prototype defines named variants as key-value token maps:

```yaml
# variants.yaml
screens:
  - home
  - messages
  - appointments/detail

variants:
  - name: "Current"
    description: "Existing production style"
    # No overrides — captures the prototype as-is

  - name: "Compact"
    description: "Tighter spacing, smaller type"
    tokens:
      spacing.card: 8
      font.body.size: 14
      corner.radius: 8

  - name: "Airy"
    description: "More whitespace, larger touch targets"
    tokens:
      spacing.card: 16
      font.body.size: 16
      corner.radius: 12
```

The prototype needs a thin integration point (a `QuiverTokens` object) that the test harness populates before capture, analogous to how `TestHooks.navController` is injected today.

**Strengths:**
- Fastest iteration cycle — change yaml values, re-run, no branch switching or rebuilding.
- Clean for the common case of "same layout, different visual tuning" (spacing, color, type scale, corner radii).
- No merge conflicts, no branch management.
- Easy to generate many variants (5, 10, 20 spacing values) without branch explosion.

**Limitations:**
- Only covers parametric changes — things expressible as a single value. Cannot swap components, layouts, or navigation structure.
- Requires upfront investment: the prototype must be built with a token layer. If values are hardcoded as inline literals, someone must refactor before tokens work.
- Token keys are a stringly-typed contract between yaml and code — a typo silently does nothing, no autocomplete, no type checking.
- Per-screen, not per-component — captures the full screen even if the variant only affects one button.

**What designers need to do (one-time setup):**

1. Create a tokens object the UI reads from (see "Token injection" section below).
2. Replace hardcoded literals in composables/views with reads from the tokens object.
3. That's it — `variants.yaml` handles the rest per comparison.

If your prototype already uses a theme/token system (Material 3 theme, custom design system), the wiring is minimal. If values are scattered as inline literals, the refactor is non-trivial but good practice regardless.

### Future / maybe: Build flavors

Gradle product flavors (Android) or Xcode build configurations (iOS) could theoretically drive variants, but in practice this is too heavyweight for design exploration:

- Each flavor requires `build.gradle.kts` changes and a new source set directory.
- Each flavor is a full build (30–90s per variant).
- Adding/removing variants is high-friction compared to branches or yaml.
- Designers comfortable with Compose may not be comfortable with Gradle flavor configuration.

Flavors are better suited to permanent structural differences (free/paid, staging/production) than ephemeral design exploration. This approach is **not planned for initial delivery** but could be added later if a real use case emerges where branches and tokens aren't sufficient.

## Targeted capture

The existing crawlers capture every screen in the graph. For comparison mode we only need a subset. The implementation:

1. Parse the full graph (reuse `kotlin-parser` / `swift-parser`).
2. Filter to only the node IDs listed in `screens:` (or `--screens` CLI arg).
3. Pass the filtered graph to the existing `crawlAndScreenshotAndroid` / `crawlAndScreenshotIos`.

The crawlers already iterate `graph.nodes` to generate test methods — filtering the list before passing it in is trivial.

## Comparison viewer

A new `src/build-comparison-viewer.js` (does NOT modify `build-viewer.js`). Outputs a single `index.html` with:

- **Screen rows** — one row per target screen.
- **Variant columns** — one column per variant, labelled with name + description.
- **Screenshot cells** — each cell shows the captured screenshot at actual device size, scrollable.
- **Pixel-diff toggle** — click to overlay a diff heatmap between any two variants (using a canvas-based pixel comparison, e.g. pixelmatch).
- **"Pick this one" action** — per-screen selection. Writes choices to `comparison-result.json`.
- **Zoom and pan** — for inspecting details. Click a cell to expand it.
- **Annotations** — optional sticky notes per cell (stored in `annotations.json`, same pattern as the flow viewer's `positions.json`).

Layout is deliberately simple — a CSS grid, not a DAG. No dagre dependency.

## CLI interface

```
npx quiver compare <prototype-path> [options]

Options:
  --branches <list>        Comma-separated branch names (primary mode)
  --screens <list>         Comma-separated screen IDs to capture (overrides yaml)
  --variants <path>        Path to variants.yaml (token mode; default: <prototype>/variants.yaml)
  --output <dir>           Output directory (default: quiver-compare-output/)
  --scenario <name>        Run a .flow scenario per variant and capture each visited screen
  --diff                   Enable pixel-diff generation between adjacent variants
  --platform ios|android   Force platform (default: auto-detect)
```

The two primary invocation patterns:

```bash
# Branch mode — compare across branches
npx quiver compare . --branches main,variant/compact,variant/airy --screens home,messages

# Token mode — compare token overrides defined in yaml (requires token layer in prototype)
npx quiver compare . --screens home,messages
# (reads variants.yaml from prototype root)
```

## Scenario-driven comparison

When `--scenario` is provided, instead of capturing a flat list of screens, the tool:

1. Runs the named `.flow` scenario against each variant.
2. Captures a screenshot at each `-> snapshot` step (or every page visit).
3. The comparison viewer shows the journey as a sequence of rows, so you see how each variant handles the same flow step-by-step.

This reuses `src/scenario-runner.js` (for web) or the native crawler's navigate-and-capture loop.

## Token injection (Level 1 detail)

### Android / Compose

A `QuiverTokens.kt` singleton (auto-injected alongside `TestHooks.kt`):

```kotlin
@VisibleForTesting
object QuiverTokens {
    var overrides: Map<String, Any> = emptyMap()
}
```

The prototype's theme composables read from this at the point of use. The generated test file sets `QuiverTokens.overrides = mapOf(...)` before navigating.

The prototype needs to opt in by reading from `QuiverTokens` in its theme — this is a one-time setup documented in the README, similar to the existing TestHooks integration.

### iOS / SwiftUI

Same pattern via a `QuiverTokens` class with `@Published` properties, injected into the environment. The spike runner sets values before capturing.

## Implementation steps

### Phase 1 — Branch-based comparison (core)

Ship first because it requires zero prototype-side changes and covers the widest range of use cases:

1. **New CLI subcommand** — `compare` in `bin/cli.js`. Parse `--branches`, `--screens`, `--output`.
2. **Branch loop orchestration** — for each branch: `git stash` current state, `git checkout <branch>`, run targeted capture, collect screenshots into `<output>/<branch>/screenshots/`. Restore original branch + stash pop at the end.
3. **Targeted capture filter** — add a `filterScreens` option to `crawlAndScreenshotAndroid` and `crawlAndScreenshotIos` that prunes `graph.nodes` before generating tests.
4. **Comparison viewer** — `src/build-comparison-viewer.js`. Grid layout, labels, expand-on-click.
5. **Result file** — "pick this one" writes `comparison-result.json`.

### Phase 2 — Pixel diff

6. **Embed pixelmatch** (or a lightweight alternative) in the viewer JS.
7. **Diff toggle UI** — click two column headers to diff them; overlay heatmap on each cell.

### Phase 3 — Token overrides (variants.yaml)

For teams that want faster iteration on parametric changes without branch-switching:

8. **`variants.yaml` parser** — read variant definitions, validate token keys.
9. **Token injection for Android** — auto-inject `QuiverTokens.kt`, set overrides in generated test.
10. **Token injection for iOS** — same pattern via `QuiverTokens` environment object.
11. **Documentation** — setup guide for token integration in prototypes, including the one-time refactor needed to make a prototype token-driven.

### Phase 4 — Scenario-driven comparison

12. **Wire `--scenario` to the branch/token loop** — run the scenario per variant, collect per-step screenshots.
13. **Sequential row layout in viewer** — show journey steps as ordered rows, so you see each variant at the same point in a flow.

### Phase 5 — Polish

14. **Annotations** — sticky notes per cell, persisted to JSON.
15. **Export** — PDF or image grid export for sharing outside the tool.
16. **Labels from git** — auto-populate variant labels from branch names or most recent commit message, so the viewer is informative without manual labelling.

## Files to create / modify

### Phase 1 (branch-based — the MVP)

| File | Change |
|------|--------|
| `bin/cli.js` | Add `compare` subcommand |
| `src/compare-orchestrator.js` | New — branch checkout loop, targeted capture per branch |
| `src/build-comparison-viewer.js` | New — HTML/CSS/JS grid viewer |
| `src/kotlin-crawler.js` | Add `filterScreens` option |
| `src/swift-crawler.js` | Add `filterScreens` option |
| `docs/variant-comparison.md` | New — user-facing guide |

### Phase 3 (token overrides — only if/when needed)

| File | Change |
|------|--------|
| `src/variants-parser.js` | New — parse `variants.yaml` |
| `src/token-injector-android.js` | New — inject `QuiverTokens.kt` |
| `src/token-injector-ios.js` | New — inject `QuiverTokens` environment |

## Design decisions

**Why inside Quiver, not a separate tool?** The screenshot capture layer (TestHooks injection, simctl orchestration, adb install/instrument/pull, animation disabling, cleanup/restore) is the hardest and most maintenance-intensive piece. It already works in Quiver and breaks with Xcode/AGP updates — maintaining it in two repos doubles that burden for no benefit.

**Why branch-based as the primary approach?** Zero prototype-side setup. Designers already work on branches. Any change — visual, structural, navigational — can be a variant. The token system is more ergonomic for rapid parametric iteration but requires each prototype to integrate a `QuiverTokens` layer — a higher adoption bar that not every team will want to pay. Branches are the universal baseline; tokens are an opt-in acceleration for teams that invest in it.

**Why not Gradle flavors?** Too heavyweight for design exploration. Each flavor needs `build.gradle.kts` changes, a new source set, and a full rebuild. The overhead of adding/removing a flavor is disproportionate to "try a different corner radius." Flavors solve a different problem (permanent build variants like free/paid). If a real use case emerges, they can be added later without changing the core architecture.

**Why a separate viewer file?** The flow map viewer (`build-viewer.js`) is complex — dagre layout, edge rendering, subgraph columns, detail panels. The comparison viewer is a simple grid. Sharing code would mean abstracting two very different layouts behind one interface. Keeping them separate is cleaner and lets each evolve independently.

**Why not Compose Preview / Xcode Preview screenshots?** Those systems capture individual composables/views in isolation, without the full app chrome (status bar, nav bar, tab bar). For realistic comparison of how variants look in-situ, navigating the real app and capturing the full screen is more representative of what users will see.

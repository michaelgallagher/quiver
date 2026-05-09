# Light- and dark-theme contrast audit (Phase 1 follow-up)

Status: report only — no token changes yet
Owner: tbd
Last updated: 2026-05-09

## Why this exists

The Phase 1 work in `docs/plans/accessibility-improvements.md` shipped a tokenised CSS layer and a first-cut light palette. The plan flagged that "manual browser verification of contrast in both themes is still pending" and scheduled a remote agent to run the audit on 2026-05-06. That run was auto-disabled before it fired (`ended_reason: "auto_disabled_repo_access"` — GitHub wasn't connected for the repo at fire time). This report replaces it: a local Playwright + axe-core + per-token measurement against the smallest fixture under `flow-map-output/maps/`.

## How to reproduce

```bash
node scripts/regen-fixture-viewer.js check-in-test
npm install --no-save axe-core
node scripts/contrast-audit.js check-in-test
```

The script is in `scripts/contrast-audit.js`. It launches headless Chromium with `--allow-file-access-from-files` (needed so the page can read its own linked `styles.css` from the same `file://` directory tree), enumerates every CSS custom property declared on `:root`, runs axe-core under WCAG 2.0/2.1/2.2 AA tags in both dark and light, and computes WCAG 2.x relative-luminance contrast ratios for ~80 token pairings per theme. Results land in `flow-map-output/contrast-audit.json`.

Fixture: `check-in-test` (7 nodes, 17 edges) — chosen because tokens are static, so a small fixture loads fastest. Findings apply to all generated viewers.

## axe-core results

| Theme | Violations | Detail |
|---|---|---|
| Dark | 2 | `aria-hidden-focus` on `#detail-panel`; `color-contrast` on `#node-count` |
| Light | 1 | `aria-hidden-focus` on `#detail-panel` |

- **`aria-hidden-focus` on `#detail-panel`** (serious, both themes). When the panel is closed it carries `aria-hidden="true"` while keeping its focusable children (close button, hide-this-page button, etc.) in the DOM, hidden via `transform: translateX(100%)`. axe is right: aria-hidden plus focusable descendants is a pattern that lets keyboard users focus invisible controls. The fix is to add `inert` to the panel when closed (or swap the close-state to `display: none` after the slide-out transition ends). Surface area is small; suggest fixing alongside the next round of token changes.
- **`color-contrast` on `#node-count`** (serious, dark only). The node-count read-out uses `color: var(--text-muted)` which is `#888888` on `var(--surface-1)` `#16213e` — 4.48:1, just under the 4.5:1 AA floor. Bumping `--text-muted` (see "Recommended adjustments" below) clears this.

## Per-token contrast — failures and near-misses

Categories below are graded against the WCAG 2.2 AA thresholds:
- **Text (4.5:1)** — 1.4.3
- **UI / non-text (3:1)** — 1.4.11

A note on node fills: the audit reports many `node-X fill on bg` ratios under 3:1. **These are by design** — fills are decorative tints and the WCAG 1.4.11 boundary is delivered by the stroke and the label, both of which are checked separately. I list them in `contrast-audit.json` for completeness but exclude them from the failure tables here.

A note on edges: edges have CSS opacity 0.5–0.85, so the rendered colour is a composite of the stroke colour and the canvas. The "effective" rows below report contrast after compositing. The "raw" colour matters only at full opacity; effective contrast is what the user sees.

### Dark theme — genuine failures

| Token / pairing | Ratio | Threshold | Where it shows |
|---|---|---|---|
| `--text-subtle` on `--surface-1` | 2.77 | 4.5 | `.panel-links .link-edge-type` (panel meta) |
| `--text-meta-faint` on `--surface-1` | 3.40 | 4.5 | hidden-list popover meta |
| `--text-muted` on `--surface-1` | 4.48 | 4.5 | `#node-count`, panel close button, panel meta values, empty-outline copy |
| `--provenance-static-fg` on `--provenance-static-bg` | 3.73 | 4.5 | static provenance pill |
| `--border` on `--surface-1` | 1.27 | 3.0 | toolbar bottom border, panel/legend left border, popover seams |
| `--border-strong` on `--surface-1` | 1.81 | 3.0 | toolbar button outlines, search/select outlines |
| `--border-popover` on `--surface-1` | 1.59 | 3.0 | hidden-list, context menu, help-dialog outlines |
| `--node-content-stroke` on `--bg` | 2.40 | 3.0 | content-page node outline |
| `--node-error-stroke` on `--bg` | 2.06 | 3.0 | error-page node outline |
| `--node-splash-stroke` on `--bg` | 1.76 | 3.0 | splash-screen node outline |
| `--edge-redirect` on `--bg` (effective @0.6) | 2.23 | 3.0 | redirect edges |
| `--edge-render` on `--bg` (effective @0.5) | 1.93 | 3.0 | render edges |
| `--edge-nav` on `--bg` (effective @0.5) | (raw 7.05, eff ~3.5) | 3.0 | global-nav edges — passes the audit at `effective @0.5 ≈ 3.52` but only just |
| `--edge-safari` on `--bg` (effective @0.6) | 2.62 | 3.0 | Safari (open-external) edges |

### Dark theme — near-misses (≤ 0.6 above threshold)

| Token / pairing | Ratio | Threshold |
|---|---|---|
| `--provenance-runtime-fg` on `--provenance-runtime-bg` | 4.62 | 4.5 |
| `--node-screen-stroke` on `--bg` | 3.56 | 3.0 |
| `--edge-sheet` effective | 3.99 | 3.0 |
| `--edge-link` effective | 4.04 | 3.0 |
| `--node-check-answers-stroke` on `--bg` | 4.05 | 3.0 |
| `--node-external-stroke` on `--bg` | 4.06 | 3.0 |

These pass but leave no headroom; small future palette tweaks could push them under. Consider tightening when adjusting neighbouring tokens.

### Light theme — genuine failures

| Token / pairing | Ratio | Threshold | Where it shows |
|---|---|---|---|
| `--border` on `--surface-1` | 1.23 | 3.0 | toolbar bottom border, panel left border, etc. |
| `--border-strong` on `--surface-1` | 1.61 | 3.0 | toolbar button outlines |
| `--border-popover` on `--surface-1` | 1.73 | 3.0 | popover/menu outlines |
| `--edge-render` on `--bg` (effective @0.5) | 2.55 | 3.0 | render edges |
| `--edge-nav` on `--bg` (effective @0.5) | 2.25 | 3.0 | global-nav edges |
| `--edge-safari` on `--bg` (effective @0.6) | 2.74 | 3.0 | Safari edges |

### Light theme — near-misses

| Token / pairing | Ratio | Threshold |
|---|---|---|
| `--text-subtle` / `--text-meta-faint` on `--surface-1` | 4.81 | 4.5 |
| `--edge-tab` effective | 3.00 | 3.0 |
| `--edge-conditional` effective | 3.04 | 3.0 |
| `--edge-redirect` effective | 3.18 | 3.0 |
| `--edge-web-view` effective | 3.50 | 3.0 |

Light is generally healthier than dark on text, but the borders are notably weaker — every UI-boundary token (`--border`, `--border-strong`, `--border-popover`) fails 3:1 against white surfaces. Visually this reads as "controls drawn with hairlines that almost disappear."

## Recommended adjustments

The values below were derived by mixing the current colour towards black (light theme) or white (dark theme) until the threshold was met, then rounding to a clean hex. They preserve hue and respect the existing tonal direction.

### Dark theme

| Token | Current | Suggested | Result |
|---|---|---|---|
| `--text-muted` | `#888888` | `#9a9a9a` | 5.46:1 on surface-1 (clears the `#node-count` axe finding) |
| `--text-subtle` | `#666666` | `#8a8a8a` | 4.60:1 |
| `--text-meta-faint` | `#6c7488` | `#828a9e` | 4.60:1 |
| `--border` | `#0f3460` | `#496e9a` | 3.01:1 |
| `--border-strong` | `#1a4a8a` | `#3e6eae` | 3.06:1 |
| `--border-popover` | `#3a4258` | `#646c82` | 3.03:1 |
| `--node-content-stroke` | `#2a5a8f` | `#3a6a9f` | 3.04:1 |
| `--node-error-stroke` | `#8f2a2a` | `#ab4646` | 3.00:1 |
| `--node-splash-stroke` | `#5a2a8f` | `#8050b5` | 3.03:1 |
| `--provenance-static-fg` | `#aa55cc` | `#ba65dc` | 4.58:1 |

For the failing dark edges (`redirect`, `render`, `safari`), the colour itself already passes at full opacity — the issue is the CSS `stroke-opacity`. Two options:

1. Bump opacity on the failing edges so the *effective* contrast clears 3:1. Approximate targets: `redirect` 0.6 → 0.75, `render` 0.5 → 0.75, `safari` 0.6 → 0.75. This preserves the colour palette and keeps the dashed-vs-solid hierarchy.
2. Saturate/lighten the colours instead. Less appealing because it flattens the hue ladder used to differentiate edge types.

Recommend option 1.

### Light theme

| Token | Current | Suggested | Result |
|---|---|---|---|
| `--border` | `#E2E8F1` | `#8e949d` | 3.06:1 (significant darkening — verify it doesn't read as too heavy) |
| `--border-strong` | `#C2CDDE` | `#8a95a6` | 3.03:1 |
| `--border-popover` | `#c0c5d0` | `#9095a0` | 3.00:1 |
| `--edge-render`, `--edge-redirect` | `#aa55cc` | (raise opacity to 0.75; raw colour already passes 3:1 ≈ 3.98 on `#f4f6fa`) | |
| `--edge-nav`, `--edge-tab` | `#53d8fb` | `#159abd` | raw 3.04:1 against `#f4f6fa`; combine with current opacities to clear effective 3:1 |
| `--edge-safari` | `#8f8f40` | (raise opacity to 0.75) | raw 3.15:1; opacity bump pushes effective above 3:1 |

The light borders darken substantially. If that reads too heavy in practice, an alternative is to raise the surface contrast — make `--surface-1` slightly grey (`#fafbfd` or `#f7f9fc`) so a softer border can hit 3:1 against it. That trades surface contrast for border contrast and is a UX call worth making with the design owner.

The axe finding for `aria-hidden-focus` on `#detail-panel` is unrelated to colour but should land in the same follow-up PR — small surface, easy fix (add the `inert` attribute on close, remove on open).

## Suggested follow-up plan

1. Apply the dark-theme token tweaks (low risk; they only nudge values lighter).
2. Bump dark-edge opacities for `redirect`, `render`, `safari`.
3. Apply the light-theme edge tweaks (opacity bumps + `--edge-nav` / `--edge-tab` darken).
4. Decide light borders: heavy-darkened tokens vs. softened surfaces. Re-run the audit after the call.
5. Fix `#detail-panel` `aria-hidden`-with-focusable-children (use `inert`).
6. Re-run `node scripts/contrast-audit.js check-in-test` and confirm zero genuine failures.

A separate PR is fine for each step; the dark-theme set is the most impactful and least controversial — start there.

## What this audit does *not* cover

- Forced-colors (Windows High Contrast) is asserted in CSS but not measured here — axe doesn't simulate it, and Playwright's `forced-colors: active` emulation in headless mode is unreliable for SVG fills/strokes. Worth a manual VM check before the WCAG sign-off.
- The maps-index page (`src/build-index.js`) — still dark-only, separate task in the master plan.
- Any layout-rule contrast (e.g. focus rings against neighbouring SVG fills). The fixture exercises the static stylesheet but not every state combination; spot-check focus visibility manually after token changes.

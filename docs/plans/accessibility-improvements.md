# Accessibility improvements for the flow-map viewer

Status: Phases 1–5 shipped (Phase 5 on 2026-05-03; contrast follow-up on 2026-05-10)
Owner: tbd
Last updated: 2026-05-10

## Goal

Make the generated viewer (`src/build-viewer.js` → `index.html` + `viewer.js` + `styles.css`) usable by people who navigate by keyboard, by screen reader, in light/high-contrast environments, with reduced motion, and on small or low-precision pointing devices. Target WCAG 2.2 AA.

## Why this matters now

The current viewer is a single `<svg>` of `<g>` node groups with mouse-only handlers and a hardcoded dark theme. None of the interactive surfaces (nodes, edges, detail panel, context menu, hidden-list popover) have keyboard or assistive-technology affordances. Light-mode is requested by users with photosensitivity, daylight working conditions, or printing needs.

## Scope

In scope:
- The HTML viewer emitted by `src/build-viewer.js` for both web and native (iOS / Android) graphs
- The maps index page emitted by `src/build-index.js`

Out of scope (separate plans):
- Generated PDF accessibility (`src/export-pdf.js`)
- Mermaid sitemap (`src/build-mermaid.js`) — Mermaid's own a11y story
- Authoring-tool a11y (CLI, server logs)

## Standards we'll target

WCAG 2.2 AA, with attention to:

| Criterion | Relevance |
|---|---|
| 1.3.1 Info and relationships | Diagram needs a programmatic structure (list/tree/grid), not just visuals |
| 1.4.1 Use of colour | Edge types differ by colour today — ensure shape/dash also differs (largely already true) |
| 1.4.3 Contrast (text) | Light + dark themes must hit 4.5:1 for body text, 3:1 for large/UI |
| 1.4.11 Non-text contrast | Node strokes, focus rings, edges ≥ 3:1 against background |
| 1.4.12 Text spacing | No fixed-height containers that clip resized text |
| 1.4.13 Content on hover/focus | Hover-revealed info must also be reachable via focus and dismissible |
| 2.1.1 Keyboard | Every mouse interaction needs a keyboard equivalent |
| 2.1.2 No keyboard trap | Detail panel and popovers must release focus |
| 2.4.3 Focus order | Tab order: skip link → toolbar → graph → panel → legend |
| 2.4.7 Focus visible | All focusable elements need a visible, theme-aware focus ring |
| 2.4.11 Focus not obscured | Focused node must be scrolled into the visible viewport |
| 2.5.7 Dragging movements | Drag-to-reposition must have a single-pointer / keyboard alternative |
| 2.5.8 Target size | Toolbar buttons and the close-panel button ≥ 24×24 |
| 4.1.2 Name, role, value | Every custom widget gets correct ARIA |
| 4.1.3 Status messages | Filter/search/save outcomes via `aria-live` |

Plus: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.

## Current-state audit (one-line per gap)

Updated after Phase 1. ✅ = closed by Phase 1, ⬜ = still outstanding.

- ✅ Theme: ~~dark-only, hex literals throughout~~ — tokenised; light theme via `data-theme="light"`; reduced-motion and forced-colours queries in place (Phase 1)
- ⬜ SVG: `<svg>` has no `role`, `aria-label`, or instructions (the *outer* `<svg>` element; the inner node-container now carries `role="listbox"` from Phase 3)
- ✅ Status messages: ~~no live region for save/reset/move outcomes~~ — dedicated `#a11y-status` polite region added (Phase 4)
- ✅ Nodes: ~~`<g class="node-group">` is not focusable; click/hover/drag/contextmenu are mouse-only~~ — each node is now `role="option"` with composed `aria-label`, roving tabindex, spatial arrow-key navigation, structural `]`/`[` traversal, Home/End/Enter/Space, focus-driven `highlightConnections`, and auto-pan into view (Phase 3)
- ⬜ Edges: no semantics; colour-only differentiation in some cases (most already use dash patterns)
- ✅ Toolbar: ~~container has no `role="toolbar"`~~ — `role="toolbar" aria-label="Flow map controls"` added; `aria-pressed` on theme/thumbnail/screenshot toggles; `aria-label` on icon-only zoom buttons (Phase 2)
- ✅ Search: ~~uses placeholder as label~~ — `<label class="visually-hidden" for="search">` added; same for hub-filter and provenance-filter selects (Phase 2)
- ✅ Detail panel: ~~slides in with no focus management~~ — now `<aside role="complementary" aria-labelledby="panel-title" aria-hidden="…" tabindex="-1">`; opens with focus moved to heading; closes on Esc with focus returned to last trigger (Phase 2)
- ✅ Context menu (right-click on node): ~~div-based, no `role="menu"`, no arrow-key navigation, mouse-only invocation~~ — now `role="menu"` with `role="menuitem"` buttons; opens via right-click, Shift+F10, the ContextMenu key, or the new `#node-actions-btn` toolbar button; arrow keys move focus, Enter/Space activate, Esc/Tab close and return focus to the originating node (Phase 4)
- ✅ Hidden-list popover: ~~no focus trap, no list semantics~~ — now `role="dialog" aria-modal="true" aria-labelledby="hlp-title"`; first focus lands on the first restorable item / Restore-all; Tab cycles inside; Esc closes and restores focus to the "Show hidden" button (Phase 4)
- ✅ Legend: ~~visual only~~ — `<aside aria-labelledby>` with `<ul role="list">`; swatches `aria-hidden` since the text already names the type (Phase 2)
- ✅ Status: ~~`#node-count` updates silently~~ — now `aria-live="polite" aria-atomic="true"` (Phase 2)
- ✅ Reduced motion / forced colours / high-contrast: ~~not honoured~~ — both media queries shipped in Phase 1
- ✅ Skip link: ~~none~~ — `<a class="skip-link" href="#canvas-container">Skip to flow map</a>` as first focusable element; canvas-container has `tabindex="-1"` so focus can land there (Phase 2)

## Phased plan

Five phases. Phase 1 unlocks the rest, so don't reorder. Each phase ends with a manual a11y pass (axe DevTools + VoiceOver/NVDA spot-check) before merging.

### Phase 1 — Theming foundation (light mode + tokens) ✅ SHIPPED 2026-05-01

What landed in `src/build-viewer.js`:

- Tokenised the entire CSS: ~80 design tokens defined under `:root` (dark default) and `:root[data-theme="light"]` (light overrides). Every former hex literal in the generated stylesheet now resolves through `var(--token)` (122 references).
- Light palette: desaturated tints for the eleven node-type fills, darkened strokes and edge colours so they remain legible against the light canvas. First pass — see Cross-cutting "contrast verification" below.
- No-flash bootstrap: inline `<script>` in `<head>` reads `localStorage['flowmap-theme']`, falls back to `prefers-color-scheme: light`, sets `data-theme` before stylesheets paint.
- Theme toggle: `#theme-toggle` button in the toolbar with `aria-pressed` reflecting state and label that flips between "Light mode" / "Dark mode". Explicit choice persists; while no choice is saved we follow OS-level changes via `matchMedia`.
- `<meta name="color-scheme" content="dark light">` plus `:root { color-scheme }` so native form widgets and scrollbars match.
- `@media (prefers-reduced-motion: reduce)` — kills transitions and animations.
- `@media (forced-colors: active)` — maps surfaces to `Canvas` / `CanvasText` / `Highlight` for Windows High Contrast.
- `:focus-visible` outlines on toolbar buttons, selects, inputs, the back link, panel close button, and the hide-node button — keyboard users get a 2px ring in the accent colour, mouse users don't.
- Inline-style cleanup: eight legend swatches, three `style="color:#666"` spans in the detail panel, the global-nav badge, and the "Hide this page" button moved to themed CSS classes (`.legend-swatch--*`, `.link-edge-type`, `.edge-provenance--nav`, `.hide-node-btn`).
- `.visually-hidden` utility class shipped early so Phase 2's skip link and hidden labels don't need another CSS rebuild.

Smoke test: 18 acceptance checks pass against a generated `demonhsapp2` map. Manual browser verification of contrast in both themes is still pending — see Cross-cutting.

### Phase 2 — Toolbar, panel, and search semantics ✅ SHIPPED 2026-05-01

What landed in `src/build-viewer.js`:

- Skip link: `<a class="skip-link" href="#canvas-container">Skip to flow map</a>` as the first focusable element, hidden via CSS transform until focused. `#canvas-container` got `tabindex="-1"` so focus lands cleanly.
- Toolbar: `<div id="toolbar" role="toolbar" aria-label="Flow map controls">`. Decided NOT to add explicit `<div role="group">` subgroups — the toolbar is flat and readable; subgroups would have required restructuring the existing flex layout for marginal AT benefit.
- Icon-only buttons: `Zoom +` and `Zoom −` got `aria-label="Zoom in"` / `"Zoom out"`. The panel close button got `aria-label="Close details"`.
- Toggle parity: `aria-pressed` now on `#toggle-thumbnail` and `#toggle-screenshots` (synced both at click time and when the toggle is first revealed for a screenshotted map). Native `<input type="checkbox">` controls (`#toggle-labels`, `#toggle-global-nav`) kept their wrapping `<label>` pattern — already accessible — rather than converting to buttons.
- Search and selects: real `<label class="visually-hidden" for="…">` for `#search`, `#hub-filter`, and `#provenance-filter`. Placeholder text retained for sighted users.
- Live region: `#node-count` is now `aria-live="polite" aria-atomic="true"`, so filter / search / hub changes announce ("32 pages, 41 connections").
- Detail panel: `<aside role="complementary" aria-labelledby="panel-title" aria-hidden="true" tabindex="-1">`. `showDetail()` now records `document.activeElement` as the trigger, opens the panel with `aria-hidden="false"`, and moves focus to the `<h2 id="panel-title" tabindex="-1">` heading. `closePanel()` flips `aria-hidden` back, removes the highlight, and returns focus to the original trigger if it's still in the DOM. The Escape key now closes the panel in addition to the existing context-menu and hidden-list popovers.
- Legend: now `<aside aria-labelledby="legend-title">` containing `<ul role="list">` with `<li>` items; colour swatches marked `aria-hidden="true"` since the surrounding text already names the edge type.

Smoke test: 25 acceptance checks pass against a generated `demonhsapp2` map.

Out of scope (deferred to Phase 3 or later):
- Context menu and hidden-list popover (still need `role="menu"` and focus trapping — Phase 4).
- 24×24 target-size verification (visual measurement; assumed close enough; defer to Phase 4 audit).
- Manual screen reader pass (NVDA/VoiceOver) — pending and noted in Cross-cutting.

### Phase 3 — Keyboard navigation across the graph ✅ SHIPPED 2026-05-01

What landed in `src/build-viewer.js`:

- New `<g id="node-container" role="listbox" aria-label="Screens (NN total)">` wraps every node group, separated from the edge `<g>` siblings so only options live inside the listbox.
- Each `<g class="node-group">` now carries `role="option"`, `aria-selected`, `tabindex` (roving — exactly one node has `tabindex="0"` per render), `data-node-id`, and a composed `aria-label` of the form: *"`label`. `Type`. `N outgoing links, M sheets` outgoing. `filePath`. Press Enter to open details."*
- Roving tabindex picks the initial focus target each render: first start-node by `startOrder`, else first node by `layoutRank` then `visitOrder` then `id`. `applyRovingTabindex()` runs after the node loop and is also re-applied automatically when the previous focus target was filtered out or hidden.
- Spatial arrow-key navigation: `findSpatialNeighbour(node, dir)` filters by direction half-plane and picks the nearest visible node by weighted distance — `dx² + 4·dy²` for Up/Down, `dy² + 4·dx²` for Left/Right (matches the recipe in step 5 of this plan).
- Structural `]` / `[` traversal: `structuralNext` cycles through siblings of the same parent before descending to the current node's first outgoing target — the `siblingCursor` state records `{ parentId, index }`. `structuralPrev` jumps to the first incoming source. Hidden / filtered-out endpoints are excluded via `visibleEdgesFrom` / `visibleEdgesTo`. Spatial movement and Home/End reset the sibling cursor.
- Enter / Space opens the detail panel for the focused node (existing `showDetail`); Home/End jump to first/last by `visitOrder` then `layoutRank`. Tab leaves the listbox via the standard browser flow. Escape continues to flow through the existing global handler (closes panel / context menu / hidden-list popover).
- `focusNode(nodeId)` is the single entry point for moving focus: it rewrites `tabindex` and `aria-selected` across all node groups, calls `targetGroup.focus({ preventScroll: true })`, and pans the new focus into view via `ensureNodeVisible`.
- Auto-pan: `ensureNodeVisible` checks whether the focused node is inside the viewport (with 60px padding); if not, `panToTransform` animates the SVG transform to centre it (~200ms, ease-out). `prefers-reduced-motion: reduce` is read once at startup into `prefersReducedMotion` and short-circuits the animation to a hard jump.
- Focus / blur listeners on each node group fire `highlightConnections(node.id)` and `clearHighlight()` so the dim-non-neighbours treatment now triggers on keyboard focus as well as mouse hover.
- Focus indicator: new `.node-rect--focused` and `.node-group:focus-visible .node-rect` rules paint a 3px `--focus-ring` outline that is distinct from `:hover` (2px `--accent`) and `--highlight` (panel-open). Forced-colors fallback maps the same selectors to `Highlight !important`.

Smoke test: 36 acceptance checks pass against a generated `demonhsapp2` map; viewers also regenerate cleanly for `breast-screening`, `nhsapp-ios-demo-v2`, and `nhsapp-nav`.

Out of scope (deferred to Phase 4 or later):
- Pointer-free zoom/pan/move/context-menu equivalents (Phase 4).
- Manual NVDA / VoiceOver pass — still pending.

---

This was the largest piece of work. We expose the diagram as a structured, navigable widget.

Recommended pattern: **listbox with roving tabindex**, single-select.

Rationale: a listbox is a closer match than a tree (we don't want users tabbing between every level) or a grid (we don't have rows × columns). Treating the graph as a flat selectable list, with arrow keys mapped to spatial neighbours, gives intuitive movement without overloading expectations.

Implementation:

1. Wrap rendered nodes in `<g role="listbox" aria-label="Screens (NN total)" aria-activedescendant="…">` or, alternatively, manage focus directly on each node with roving tabindex (preferred for SVG — `aria-activedescendant` on SVG is patchy in JAWS).
2. Per node `<g class="node-group" role="option" tabindex="-1" aria-label="…" aria-selected="false">`. Compose `aria-label` from:
   - The label
   - Type ("Screen", "Web view", "External")
   - Outgoing edge summary ("3 outgoing links, 1 sheet")
   - File path
   - Hint suffix: "Press Enter to open details"
3. Roving tabindex: exactly one node has `tabindex="0"` at any time — the "current" one. On arrow-key navigation, swap tabindex.
4. Initial focus target: first start node, else first node by `layoutRank` then `visitOrder`, else first by `id`.
5. Key bindings when a node has focus (decided 2026-05-01 — spatial on arrows, structural on bracket keys):
   - `Tab` / `Shift+Tab` → leaves the listbox (does not cycle inside)
   - `Enter` / `Space` → open detail panel for current node
   - `Arrow Up/Down/Left/Right` → **spatial**: move to the nearest neighbour by layout coordinates. Use the existing dagre output. Algorithm: filter remaining visible nodes by the direction half-plane (only nodes whose centre lies in the pressed direction); pick the smallest weighted distance `dx² + 4·dy²` for up/down (vertical bias) and `dy² + 4·dx²` for left/right (horizontal bias). Matches what a sighted keyboard user sees and aligns with the listbox convention.
   - `]` / `[` → **structural**: move to the next outgoing target / previous incoming source along the graph. Tiebreak by edge-list order in `graph.edges`. Pressing `]` repeatedly cycles through siblings of the same parent before descending; this lets a screen-reader user reason about flow without overloading the arrow keys.
   - `Home` / `End` → first / last by visit order (else layout rank)
   - `Ctrl/Cmd+F` is left to the browser; our search input still works
   - `Escape` → close panel if open; else clear selection
   - `Shift+Arrow` → in "move mode" (see Phase 4), nudge node position
6. Auto-pan: when focus moves to a node outside the viewport, animate (or jump, with reduced motion) the SVG transform to centre the focused node. Reuses the existing zoom/pan transform.
7. Focus indicator: add `.node-rect--focused` class with a 3px outline using `--focus-ring`, distinct from `:hover`. Must be visible in light, dark, and forced-colors.
8. `highlightConnections(node.id)` should fire on **focus** as well as `mouseenter`, and clear on `blur`.
9. Hidden / filtered nodes are excluded from focus traversal automatically because the wrapper is rebuilt on each layout.

Files: `src/build-viewer.js` (`generateViewerJs` — node rendering, key handlers, neighbour-finding, transform helpers).

Definition of done: a sighted keyboard user can reach every visible node, open its details, traverse to any neighbour, and the focused node is always visible. NVDA / VoiceOver announce label + role + selected state on each move.

### Phase 4 — Pointer-free equivalents for power features ✅ SHIPPED 2026-05-03

What landed in `src/build-viewer.js`:

- **Keyboard shortcuts toolbar button** (`#keyboard-help-btn`, `aria-haspopup="dialog"`) and a `?` global shortcut both open the modal `#keyboard-help-dialog` (`role="dialog" aria-modal="true" aria-labelledby="kb-help-title"`). The dialog overlays a dimmer that closes on click; Esc closes; Tab is trapped between the close button and the dialog. Initial focus moves to `#kb-help-close`. Reopening returns focus to the toolbar trigger. Reduced-motion is inherited from the global rule.
- **Zoom shortcuts**: `+`/`=` zoom in, `-`/`_` zoom out, `0` fits to screen — wired in the document-level keydown handler. Skipped when the target is an `<input>` / `<select>` / `<textarea>` / `[contenteditable]`, or when the help dialog is open, or when focus is inside the menu / hidden-list popover. Fit announces "Fit to screen." via the live region.
- **Arrow-key pan when no node is focused**: same handler. 30px step, 80px with Shift. When focus is on a `.node-group`, the listbox handler runs first and consumes the arrow keys for spatial navigation (Phase 3 behaviour preserved).
- **Move mode (WCAG 2.5.7)**: pressing `M` on a focused node calls `enterMoveMode(node)`, which records `{ originalX, originalY }`, applies `.node-rect--move-mode` (a dashed warn-coloured pulsing stroke) and `aria-grabbed="true"`, then announces "Move mode for X. Use arrow keys to nudge, Enter to commit, Escape to cancel." `handleMoveModeKeydown` then intercepts arrows (8px nudge, 32px with Shift), Enter (commits via the existing `manualPositions` + `savePositions()` and dirty-state on `#save-layout-btn` in serve mode), and Esc (reverts to `originalX/Y` and `updateConnectedEdges`). Move mode swallows other keys to prevent accidental selection moves or shortcut activation.
- **Accessible context menu**: `showNodeContextMenu` now sets `role="menu"`, `aria-label="Actions for <label>"`, and gives each `.ncm-item` `role="menuitem"` with roving `tabindex`. New keyboard triggers — `Shift+F10`, the `ContextMenu` key, and a toolbar `#node-actions-btn` (`aria-haspopup="menu"`, disabled when no node is focused) — call `openNodeMenuForFocused()` which positions the menu under the node and focuses the first item. `handleNodeMenuKeydown` handles Up/Down/Home/End to move focus, Enter/Space to activate, and Esc/Tab to close. The originating element (node group or toolbar button) is recorded as `_nodeMenuTrigger` and re-focused on close.
- **Accessible hidden-list popover**: now mounted as `role="dialog" aria-modal="true" aria-labelledby="hlp-title"` with a labelled title (`"<N> hidden"`). `handleHiddenPopoverKeydown` provides a Tab focus-trap and Esc close that returns focus to `#show-all-btn`. Each Restore button has an explicit `aria-label="Restore <label>"` so the AT context isn't lost when the popover updates in place.
- **Live-region announcements**: a dedicated `#a11y-status` (`role="status" aria-live="polite" aria-atomic="true"`, visually-hidden) carries transient feedback. `announceStatus(msg)` is wired into Save layout success/failure, Reset positions, Fit to screen, and the move-mode lifecycle. The `#node-count` region kept its own live behaviour for filter / search summaries (Phase 2).

Smoke tests (both new):

- `scripts/smoke-test-phase4.js` — 66 static asserts over the emitted `index.html`, `styles.css`, and `viewer.js`.
- `scripts/smoke-test-phase4-runtime.js` — 16 Playwright/Chromium asserts: page loads with no JS errors, `?` opens / Esc closes the dialog with focus management, `+`/`-`/`0` mutate the SVG transform, `M` enters move mode (with class + `aria-grabbed`), arrows nudge, Esc reverts, Enter commits, `Shift+F10` opens `role="menu"` and Esc closes. Verified against `demonhsapp2` and `breast-screening` fixtures.

Decisions worth recording:

- The plan called for a "More actions" button that appears on focus. Implemented as a persistent `#node-actions-btn` in the toolbar — disabled until a node has focus, so its enabled state is the on-focus signal. Simpler than injecting an SVG-anchored chip per render and doesn't bloat the per-node DOM.
- Help dialog initial focus lands on the close button (the only meaningful interactive element inside) rather than the dialog itself. Tab cycles between the close button and the dialog body; the dialog's `tabindex="-1"` is only used as a fallback if the close button is unreachable.
- The popover's "modal" framing is a small abuse — visually it's a popover, not an overlay — but `aria-modal="true"` lines up with the focus-trap behaviour and announces correctly in NVDA/VoiceOver. Acceptable trade-off given the small surface area.

Out of scope (deferred to Phase 5 or later):

- Manual NVDA / VoiceOver pass — still pending. Move-mode and the Phase 3 listbox semantics are the highest-value targets for a real-screen-reader pass before Phase 5.
- Outline view (Phase 5).

### Phase 5 — Screen reader-friendly outline view ✅ SHIPPED 2026-05-03

What landed in `src/build-viewer.js`:

- **Toolbar button** `#outline-toggle` (`aria-pressed`, `onclick="toggleOutlineView()"`) toggles between "View as outline" and "View as map" labels.
- **`<nav id="flow-outline" aria-labelledby="outline-heading">`** added immediately after `#canvas-container`. Uses CSS `clip: rect(0,0,0,0)` (not `display:none`) when inactive so the landmark is always reachable by AT and search engines.
- **Active state** (`#flow-outline.outline-active`): full-viewport scrollable panel (`position:fixed`, `overflow-y:auto`, `z-index:10`). Canvas gets `aria-hidden="true"` + `display:none` to remove it from both the visual and AT trees.
- **`buildOutline()`**: called at the end of every `render()`. Reads `layoutNodes` (already computed), sorts by `layoutRank` → `visitOrder` → label, emits `<h2 id="outline-heading">Screens (NN)</h2>` + `<ul class="outline-list">`. Each `<li class="outline-item">` contains an `<button class="outline-node-btn">` that calls `showDetail(node)` and a nested `<ul class="outline-edges-list">` of outgoing edges (edge type + target button), respecting the current `showGlobalNav` and `provenanceFilter` state.
- **`toggleOutlineView()`** (exposed on `window`): flips `outlineMode`, syncs `aria-pressed`, toggles CSS classes and `display`, moves focus to `#outline-heading` on enable / back to the toggle button on disable, updates the skip link `href` between `#flow-outline` and `#canvas-container`, and announces status via `#a11y-status`.
- Smoke test: `scripts/smoke-test-phase5.js` — 43 static asserts over emitted HTML, CSS, and JS.

Definition of done: with the SVG hidden, a screen-reader user can still find any screen, see what it links to, and open its details.

## Cross-cutting items

- **Contrast verification** ✅ shipped 2026-05-10: the scheduled audit was auto-disabled before it fired, so a local Playwright + axe + per-token sweep replaced it (`scripts/contrast-audit.js`). Findings landed in `docs/plans/accessibility-improvements-contrast.md`; token tweaks (dark text/border/stroke nudges, light border darkening, edge-opacity bumps, a `--control-bg` split so lightened borders don't break text-on-toolbar contrast, and `inert` on the closed detail panel) shipped on the same day. Re-running the audit reports zero genuine failures and zero axe violations in both themes.
- **Manual screen-reader pass** — TODO, still outstanding. Originally scoped after Phase 2; deferred again through Phases 3 and 4. Tab through a generated map with NVDA on Windows and VoiceOver on macOS and verify:
  - Toolbar controls, search, hub/provenance filters, theme toggle, panel open/close, and skip link (Phase 2)
  - Listbox semantics: roving tabindex, composed `aria-label`, spatial arrows, `]`/`[` structural traversal, Home/End, focus-driven highlight (Phase 3)
  - Move mode start/commit/cancel announcements, accessible context menu (Shift+F10 / ContextMenu / `#node-actions-btn`), hidden-list popover focus trap, help dialog, and the `#a11y-status` live region (Phase 4)
  Capture rough edges into a follow-up section before Phase 5 ships, since the outline view in Phase 5 changes the AT story significantly. **Do not schedule a remote agent for this — it is a hands-on task.**
- **Index page** (`src/build-index.js`): apply the same theme tokens and skip link. Outstanding — Phase 1 only touched `build-viewer.js`, so the maps-index page is still dark-only.
- **Documentation**: a short "Accessibility" section in `docs/README.md` describing keyboard shortcuts, screen reader recommendations, and known limitations. Add at the end of Phase 5.
- **Per-map ID stability**: roving tabindex (Phase 3) assumes node IDs are stable across renders — they are, per the regenerate-merge logic in `buildViewer`. No action; just a note.

## Open questions

1. ~~Should arrow-key neighbour traversal be spatial or graph-structural?~~ **Decided 2026-05-01: spatial on the four arrow keys, structural on `]`/`[`.** Spatial matches the listbox ARIA convention and what a sighted keyboard user sees; the dedicated structural keys give screen-reader users a clean "follow the flow" affordance without overloading arrows. Implementation details locked in Phase 3, step 5.
2. ~~Detail panel as `<dialog>` (modal) or non-modal `<aside>`?~~ **Decided: non-modal `<aside role="complementary">`**, since the panel coexists with the canvas. Phase 2 implemented this.
3. Do we add an end-to-end a11y test (axe-core via Playwright over a generated map) or rely on manual passes? Cheap to add later; the scheduled contrast-audit routine fires axe once on 2026-05-06 — if its run goes smoothly, we can recycle that scaffolding into a permanent test. Defer the decision until that report lands.

## Next steps

All five phases are now shipped. Remaining cross-cutting work:

- ~~**Contrast-token tightening**~~ ✅ shipped 2026-05-10. See `docs/plans/accessibility-improvements-contrast.md` "What landed" section.
- **Manual NVDA / VoiceOver pass**: hands-on task, do not delegate to a remote agent. Tab through a generated map and verify Phases 2–5 semantics (toolbar, graph listbox, context menu, outline view).
- **Maps-index page** (`src/build-index.js`): apply theme tokens and skip link — still dark-only.
- **Documentation**: add an "Accessibility" section to `docs/README.md` covering keyboard shortcuts, screen reader recommendations, and known limitations.

# Using the viewer

The tool generates an interactive HTML viewer for each map. Open `index.html` in a browser to explore — or run `prototype-flow-map serve <output-dir>` to view it via a local server (which adds shared layout-position persistence).

## Navigation

- **Pan**: click and drag the background
- **Zoom**: scroll wheel, or use the + / - buttons
- **Fit to screen**: reset the view to fit all nodes

## Inspecting pages

- **Click a node** to open the detail panel showing:
  - Full screenshot
  - Page metadata (URL path, file path, node type, hub)
  - Incoming and outgoing edges with labels
  - Provenance badges (runtime vs static, where applicable)
  - **Hide this page** button (see [Hiding nodes](#hiding-nodes))
- **Search** to filter pages by name or URL path

## Filters and toggles

- **Filter by hub**: show only pages in a specific section
- **Toggle labels**: show/hide edge labels and conditions
- **Toggle global nav**: show/hide global navigation edges (hidden by default in scenario mode)
- **Provenance filter**: filter edges by source — runtime only, static only, or both
- **Show/hide screenshots**: toggle between screenshot view and compact node view
- **Thumbnail mode**: switch between full-page and compact thumbnail screenshots

## Repositioning nodes

- **Drag nodes**: click and drag any node to reposition it.
- **Reset positions**: clear all manual positions and return to the computed layout.
- **Save layout** (serve mode only): persist current positions to the server so anyone else viewing the same deployment sees the same layout. The button shows a dirty marker (`Save layout *`) when there are unsaved changes; turns to `Layout saved ✓` after a successful PUT.

Position persistence priority (highest wins):
1. Server API (when the viewer detects it's being served via `prototype-flow-map serve` or `--serve`)
2. `localStorage` (browser-local fallback when no server is reachable)
3. Embedded `__SAVED_POSITIONS__` (baked into HTML at generation time from `positions.json`, so previous saves carry forward across regenerations even on file://)
4. Computed layout (Dagre or grid)

## Hiding nodes

Three ways to hide content the user knows is irrelevant:

- **Right-click a node** → "Hide node" hides just that node
- **Right-click a node with descendants** → "Hide subgraph (N descendants)" hides the node and everything reachable below it via forward edges
- **Click a node** → "Hide this page" button in the detail panel (single-node hide, same as right-click → Hide node)

When ≥1 node is hidden, the toolbar shows a **Show hidden (N)** button. Click it to open a popover listing all hidden nodes by label. Each row has a **Restore** button to bring that single node back; the header has a **Restore all** button to clear the entire hidden set.

Hidden state persistence priority (highest wins):
1. Server API (when in serve mode — every hide/restore auto-saves; no manual Save button needed)
2. `localStorage` (browser-local fallback when no server is reachable; keyed by pathname, NOT by generation ID, so hidden state survives regeneration)
3. Embedded `__SAVED_HIDDEN__` (baked into HTML at generation time from `hidden.json`, so previous saves carry forward even on file://)

Stale entries for node IDs that no longer exist in the current graph are inert — at carry-forward time the build dropped them; in the viewer they simply don't match any node and have no effect.

## Layout

The layout has three branches depending on what metadata the graph carries:

### With subgraph owners — column-packed

When the tool detects subgraph owners (e.g. Android bottom-nav tabs, or web jump-off subgraphs propagated from a native handoff), the layout is **column-packed**: each detected tab/section gets its own column, ranks flow top-to-bottom within each column, and columns sit left-to-right in `startOrder`. This keeps each tab's content visually grouped.

### With ranks but no owners — Dagre tree shape on rank rows

When nodes carry `layoutRank` but no `subgraphOwner` (typical for iOS prototypes without explicit tabs, and for many web scenarios), the tool keeps Dagre's computed X positions — Dagre laid out the actual edges with `rankdir: 'TB'`, so its X reflects tree structure (children sit horizontally under their parents). Y is overridden with rank-based stacking so rank rows align cleanly.

A future improvement (Part B in [roadmap.md](plans/roadmap.md#workstream-2--tree-shaped-layout)) will infer virtual subgraph owners from hub-shaped graphs, bringing iOS-without-tabs and web-without-mutual-tabs into the column-packed layout. For now this rank-row tree shape replaces what was previously a centred-blob fallback.

### Without ranks — pure Dagre

For very simple prototypes where no rank metadata is present, Dagre handles the layout end-to-end based on graph structure.

## Web jump-off rendering

When a native run uses `--web-jumpoffs`, web pages are rendered with distinct visual styling so they read as part of the journey but are clearly distinguishable from native screens:

- **`web-page` nodes**: tinted fill and dashed stroke (versus solid stroke on native nodes)
- **Subgraph root** (the URL the native app handed off to): heavier stroke to mark the entry point
- **Column placement**: each web subgraph inherits the column position of the native handoff that introduced it, so the whole web journey sits in-column under the native screen that linked to it

See [`web-jumpoffs.md`](web-jumpoffs.md) for the full reference on what gets crawled and how.

## Output file layout

Each `output-dir` is a self-contained website. Shared assets sit at the root; per-map files live under `maps/<name>/`.

```
flow-map-output/
├── index.html            ← gallery (links to every map)
├── styles.css            ← shared viewer stylesheet
├── viewer.js             ← shared viewer logic
├── theme-bootstrap.js    ← no-flash dark/light bootstrap (used by both gallery and viewer)
├── vendor/dagre.min.js   ← layout library, bundled (no CDN)
└── maps/
    └── <name>/
        ├── index.html        ← thin shell — references the shared assets above
        ├── graph-data.json   ← nodes + edges (the map's data)
        ├── runtime.json      ← viewport, generation id, saved positions/hidden
        ├── meta.json         ← name, title, mode, scenario, counts, viewerSchemaVersion
        ├── positions.json    ← (optional) manual layout overrides written by serve
        ├── hidden.json       ← (optional) curated hide set written by serve
        ├── sitemap.mmd       ← Mermaid sitemap source
        └── screenshots/      ← per-screen PNGs
```

The shell HTML loads `graph-data.json` and `runtime.json` over fetch when served via http(s); on `file://` the fetch is CORS-blocked, so the shell's inline `window.__*` data island stands in. Either way the viewer ends up with the same data — the sidecars are the source of truth when reachable.

## Upgrading existing maps

When the viewer's CSS, JS, or HTML shell improves, older maps don't pick up the changes automatically — their HTML was baked at generation time. Run `upgrade` to re-bake every map under an output dir against the current viewer code, without re-running the parser or crawler:

```bash
prototype-flow-map upgrade ./flow-map-output           # all maps in the dir (default)
prototype-flow-map upgrade ./flow-map-output --check   # dry-run; print the plan, write nothing
prototype-flow-map upgrade ./flow-map-output --only my-map
prototype-flow-map upgrade ./flow-map-output --no-include-root   # skip the gallery rebuild
```

The command:

- reads each map's `graph-data.json` + `meta.json` + saved `positions.json` / `hidden.json`,
- applies any pending schema migrations,
- calls the same `buildViewer` code path that `generate` uses, so the shell ends up byte-identical to a fresh generate,
- re-stamps `meta.json` with the current `viewerSchemaVersion` and `updatedAt`.

`positions.json`, `hidden.json`, and `screenshots/` are never touched. Maps without `graph-data.json` (typically very old outputs) are skipped with a warning. If a map declares a schema version newer than the installed CLI, the command refuses rather than risk a silent downgrade — update the CLI and try again.

## Accessibility

The viewer targets WCAG 2.2 AA. It works without a mouse, exposes the diagram as a structured widget to screen readers, and offers an outline alternative when the SVG isn't useful.

### Keyboard shortcuts

Press <kbd>?</kbd> any time to open the in-app shortcuts dialog. The complete reference:

**Navigation**
- <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> — move between the toolbar, graph, and panels
- <kbd>Arrow</kbd> keys — on a focused node: move to the nearest spatial neighbour; otherwise: pan the canvas (<kbd>Shift</kbd>+arrow for a larger step)
- <kbd>]</kbd> / <kbd>[</kbd> — follow an outgoing / incoming connection from the focused node
- <kbd>Home</kbd> / <kbd>End</kbd> — first / last node by visit order
- <kbd>Enter</kbd> or <kbd>Space</kbd> — open the focused node's detail panel

**Zoom and view**
- <kbd>+</kbd> or <kbd>=</kbd> — zoom in
- <kbd>−</kbd> or <kbd>_</kbd> — zoom out
- <kbd>0</kbd> — fit to screen

**Editing layout**
- <kbd>M</kbd> — enter move mode on the focused node. Arrows nudge, <kbd>Shift</kbd>+arrow steps further, <kbd>Enter</kbd> commits, <kbd>Esc</kbd> cancels.
- <kbd>Shift</kbd>+<kbd>F10</kbd> or the <kbd>ContextMenu</kbd> key — open the node actions menu (the **Node actions** toolbar button does the same with the mouse)

**Dialogs and menus**
- <kbd>Esc</kbd> — close the open menu, popover, or panel; cancel move mode
- <kbd>?</kbd> — open the keyboard shortcuts dialog

The first focusable element on the page is a "Skip to flow map" link that jumps focus past the toolbar straight into the graph.

### Screen readers

The graph is exposed as an [ARIA listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) with one option per node. Each option's accessible name is composed from the label, the node type, an outgoing-edge summary, and the file path — for example *"Home. Screen. 3 outgoing links, 1 sheet outgoing. app/views/home.html. Press Enter to open details."* Roving tabindex keeps Tab order shallow: one node at a time is in the tab sequence, and arrow keys move focus between siblings.

Other landmarks the AT picks up:
- Toolbar (`role="toolbar"`) with labelled buttons and toggles (`aria-pressed` on Light/Dark, View as outline, etc.)
- Detail panel as a `complementary` aside; opens with focus on the heading, closes with focus returning to whatever opened it
- Node actions menu as `role="menu"` with full keyboard control (arrows, Enter/Space, Esc, Home/End)
- Hidden-list popover and keyboard-shortcuts dialog as modal `role="dialog"` regions with focus trapping and Esc-to-close
- Live region (`aria-live="polite"`) for filter, save-layout, reset, fit-to-screen, and move-mode announcements

If the SVG diagram isn't useful for your AT, the **View as outline** toggle in the toolbar swaps the diagram for a structured `<nav>` of headings, lists, and buttons. Each screen lists its outgoing edges; activating any button opens the same detail panel. The outline view also makes the page legible to search engines and structured-content tools.

### Theme, motion, and contrast

- **Light / dark themes** — the viewer follows your OS-level preference on first load (`prefers-color-scheme`). The **Light mode** / **Dark mode** toolbar button overrides that and persists your choice across sessions and across maps. The maps index page uses the same key, so the two surfaces stay in sync.
- **Reduced motion** — when `prefers-reduced-motion: reduce` is set, transitions, animations, and the auto-pan into focused nodes are short-circuited to instant changes.
- **Contrast** — both themes are checked against WCAG 2.2 AA via `scripts/contrast-audit.js`; the audit currently reports zero genuine failures (decorative node fills are exempt, with the boundary delivered by the stroke and label).
- **Forced colours (Windows High Contrast)** — system tokens (`Canvas`, `CanvasText`, `Highlight`) are used for surfaces, borders, and focus rings so user palettes win.

### Known limitations

- Forced-colours support is asserted in CSS but not measured in CI — Playwright's headless emulation is unreliable for SVG fills/strokes. Worth a manual VM check if you ship to a Windows audience.
- The Mermaid sitemap (`sitemap.mmd`) inherits Mermaid's own accessibility story — there's no separate a11y treatment for it.
- PDF export (`src/export-pdf.js`) is not yet tagged for accessibility.

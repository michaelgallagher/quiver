# Portable viewer + `upgrade` command

> **Status: delivered 2026-05-10.** Phases 1, 2, 3.1 and 3.2 shipped.
> `prototype-flow-map upgrade` re-bakes every map in an output dir against
> the current viewer; sidecars (`graph-data.json`, `runtime.json`) are
> written alongside an inline fallback so `file://` viewing still works.
> See [`../../viewer.md#output-file-layout`](../../viewer.md#output-file-layout)
> and [`../../viewer.md#upgrading-existing-maps`](../../viewer.md#upgrading-existing-maps)
> for current reference. Implementation is in `src/build-viewer.js`,
> `src/upgrade.js`, `src/upgrade-migrations.js`, and the `upgrade`
> subcommand in `bin/cli.js`.
>
> Deferred: `src/upgrade.test.js` — the project doesn't yet have a working
> test harness, so the planned tests for the upgrade walker were skipped.
> Add when a test fixture pattern is established.

## Problem

Map layout and viewer features (toolbar buttons, legend rows, dialogs,
conditional UI) get baked into each map's `index.html` at generation time. So
older maps keep a frozen UI even when the viewer code has moved on. The user
wants improvements to flow through to *all* existing maps without needing to
re-run the parser/crawler for each one.

## Current state (what's already shared vs frozen)

Already shared per output dir (good):
- `flow-map-output/styles.css`
- `flow-map-output/viewer.js`
- Per-map HTML references them via `../../styles.css` / `../../viewer.js`.

Already on disk per map (good — feeds the upgrade path):
- `graph-data.json` — full graph
- `meta.json` — name, title, mode, scenario, counts, `hasScreenshots`,
  `crawlStats`
- `positions.json` (when present) — saved manual layout
- `hidden.json` (when present) — hidden node set
- `screenshots/`

Frozen in each map's `index.html` (the actual problem):
- Toolbar markup and the set of controls (search, hub-filter, screenshot/label
  toggles, outline toggle, fit-to-screen, save-layout, theme toggle, keyboard
  help…).
- Legend markup, including the "Provenance" sub-section.
- Keyboard-help dialog content.
- Detail panel scaffolding.
- Conditional gates evaluated at generation time:
  `hasGlobalNav`, `hasProvenance`, plus screenshot-related toggles.
- Inline data: `window.__GRAPH_DATA__`, `__SAVED_POSITIONS__`,
  `__SAVED_HIDDEN__`, `__VIEWPORT_*`, `__MAP_NAME__`, `__GENERATION_ID__`.
- Theme bootstrap script (no-flash dark/light).
- External CDN reference for dagre.

The root `flow-map-output/index.html` (gallery) is *also* frozen — it has its
own inlined CSS (mirroring the viewer's tokens) and is regenerated only when
`buildIndex()` runs.

## Approach (hybrid, per chat)

1. **Skinny-shell refactor** — collapse `index.html` to a near-empty document
   whose only job is bootstrap (theme, asset links, data references). All
   toolbar / legend / dialog DOM is rendered by `viewer.js` at runtime from the
   graph + meta. Conditional features (`hasGlobalNav`, `hasProvenance`,
   `hasScreenshots`) are detected at runtime instead of being baked in.
2. **`upgrade` CLI command** — walks every map in an output dir and re-emits
   the shell + shared assets without re-running the parser/crawler. Default is
   "all maps in this output dir" (per user's clarification).

The two pieces are independent in principle but reinforcing in practice — the
upgrade command is much more useful once the shell is skinny, because there's
less per-map baked-in markup to drift.

## Step-by-step plan

### Phase 1 — Skinny shell

**1.1 Define a viewer schema version.**
Add `viewerSchemaVersion: 1` to `meta.json` written by `buildViewer()`, and
read by the upgrade command to decide whether a map needs migration vs a
straight rebake. Bump on breaking shape changes only (e.g., field renames in
graph-data).

**1.2 Move toolbar/legend/dialog markup into `viewer.js`.**
Today `generateViewerHtml()` in `src/build-viewer.js` (lines ~98-267) emits
all toolbar rows, legend `<ul>`, keyboard-help dialog, and detail panel as
literal HTML strings with conditional templates. Refactor: have
`viewer.js` build these out of the DOM on `DOMContentLoaded`, gated on the
features it observes in the graph data:
- `graph.edges.some(e => e.isGlobalNav)` → render global-nav toggle.
- `graph.edges.some(e => e.provenance)` → render provenance filter and the
  legend sub-section.
- `graph.nodes.some(n => n.screenshot)` → render screenshot/thumbnail toggles.

Result: the only conditional left in the shell is *no* conditionals. Same HTML
for every map.

**1.3 Externalise graph data — both inline and sidecar.**
Today `__GRAPH_DATA__` is JSON-stringified into a `<script>` tag *and* a
`graph-data.json` sidecar is written. Keep both, but invert the priority:
`viewer.js` tries `fetch('graph-data.json')` first, and falls back to
`window.__GRAPH_DATA__` if the fetch fails (which it will under `file://` in
many browsers due to CORS-on-local-files). This preserves the
"double-click the HTML, it works" story while letting the upgrade command
ship updates without touching inline payloads when the user opens via
`serve`.

Move the *non-graph* runtime knobs (`__SAVED_POSITIONS__`, `__SAVED_HIDDEN__`,
`__VIEWPORT_*`, `__MAP_NAME__`, `__GENERATION_ID__`) into a `runtime.json`
sidecar with the same fetch-first / inline-fallback pattern. Net result: the
shell still contains a (small) inline data island for `file://` portability,
but the *markup* around it is identical across every map.

**1.4 Move the theme bootstrap into a shared file.**
The 10-line no-flash script currently lives inline in every shell. Move to
`flow-map-output/theme-bootstrap.js`, referenced via `<script src="…">` from
the shell. (Inline is technically faster, but with HTTP/2 + a tiny file the
delta is negligible for local viewing.) Same treatment for the gallery page
in `build-index.js` so the two stay in sync.

**1.5 Bundle dagre locally.**
Replace the `cdn.jsdelivr.net` script tag with a local copy at
`flow-map-output/vendor/dagre.min.js`, copied from `node_modules/dagre/dist`
during `buildViewer`. Removes a network dependency and the version drift risk.

**1.6 Result of phase 1.**
Every per-map `index.html` becomes a ~30-line file that links three shared
assets (`styles.css`, `viewer.js`, `theme-bootstrap.js`), one vendor file
(`dagre.min.js`), and points the viewer at `graph-data.json` + `runtime.json`.
No conditional markup, no inlined data — and therefore no layout drift.

### Phase 2 — Upgrade command

**2.1 New CLI subcommand.**
```
prototype-flow-map upgrade [output-dir]
  [--only <name>]     # restrict to one map (default: all)
  [--check]           # report what would change, write nothing
  [--include-root]    # also rebuild the gallery index.html (default: yes)
```
Default `output-dir` is `./flow-map-output`, matching the `serve` subcommand's
convention. Default scope is *every* map in that dir, per the user's ask.

**2.2 Implementation.**
Add `src/upgrade.js`. For each `<output-dir>/maps/<name>/`:
1. Read `graph-data.json` and `meta.json` (skip with a warning if either is
   missing — those maps were generated by something too old to upgrade
   without re-running the parser).
2. Read `positions.json` and `hidden.json` if present (carry-forward semantics
   already implemented in `buildViewer`).
3. Reconstruct the `viewport` from `meta.json` if present, otherwise pass
   `null` so `buildViewer` falls back to its default 375×812.
4. Call the existing `buildViewer(graph, mapOutputDir, hasScreenshots, viewport,
   { name, rootOutputDir })`.

Then `buildIndex(outputDir)` once at the end (gated by `--include-root`).
There's no map-level mode handling needed — `buildViewer` is the single point
of truth.

**2.3 Detect non-named outputs.**
Some older outputs lived directly in `flow-map-output/index.html` (no
`maps/<name>/` nesting). The upgrade walker should handle both:
- If `<output-dir>/maps/` exists, iterate that.
- Else if `<output-dir>/graph-data.json` exists, treat the whole dir as a
  single map.

**2.4 Schema-mismatch handling.**
If `meta.viewerSchemaVersion` is missing or older than the current viewer's,
print a one-line note ("upgrading map X from schema 0 → 1") and apply the
migration. Migrations live in `src/upgrade-migrations.js` as a list of
`{ from, to, migrate(graph, meta) }` functions, applied in order. Keep this
file empty for v1; we only need it the first time a breaking change lands.

**2.5 Dry-run output.**
With `--check`, the command prints a table:
```
Map                                  Schema   Action
breast-screening-clinic-workflow     1 → 1    rebuild shell
nhsapp-ios-demo-v2                   0 → 1    migrate + rebuild shell
android-test                         (none)   skip — graph-data.json missing
```
Useful as a CI gate too.

**2.6 Tests.**
Add `src/upgrade.test.js`:
- Fixture output dir with two maps (one current, one missing `meta.json`).
- Run upgrade; assert HTML shell content is byte-identical to a fresh
  `buildViewer` call against the same inputs.
- Assert `positions.json` / `hidden.json` are preserved (not touched).
- Assert `--check` writes nothing.

### Phase 3 — Compatibility & follow-ups

**3.1 Make `generate` and `upgrade` share the shell template.**
After phase 1, the per-map shell is generated by a single function (call it
`renderMapShell({ name, assetPrefix, hasScreenshots, viewport })`). Both
codepaths call it. No template duplication.

**3.2 Document.**
Add a short note in `docs/viewer.md` explaining the file layout, what each
sidecar is for, and how to run `upgrade`. Add a one-liner to README.

**3.3 Versioned shared assets (optional, later).**
If we ever need to host a single canonical viewer (e.g., for sharing maps
across machines), tagging shared assets as `viewer-<hash>.js` and updating
`index.html` to point at the latest hash is a small, additive next step. Not
needed for the immediate goal.

## Risk / open questions

- **Existing maps without `viewerSchemaVersion`** are treated as schema 0 and
  pass through migrations cleanly. No special handling needed beyond the
  empty migrations list.
- **Maps generated against a newer schema than the installed CLI** — refuse
  to upgrade, print a clear error pointing the user at `npm install -g`. Don't
  silently downgrade.

## Success criteria

- Running `prototype-flow-map upgrade` on a `flow-map-output/` dir produced by
  an older version replaces every per-map `index.html` and the shared
  `styles.css` / `viewer.js`, leaving `graph-data.json`, `meta.json`,
  `positions.json`, `hidden.json`, and `screenshots/` untouched.
- Opening any upgraded map shows the latest toolbar, legend, and keyboard-help
  content — including features added after that map was generated.
- Re-generating a map via the normal `generate` path produces a shell
  byte-identical to what `upgrade` would produce.

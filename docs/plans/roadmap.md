# Roadmap

> Active workstreams for Quiver. Each section is self-contained — a fresh contributor (human or AI) should be able to pick one up without reading the others. Recently delivered workstreams are in [`archive/`](archive/).

## Shared context

Quiver is a CLI tool that generates interactive flow maps from prototype projects. Three platforms (iOS, Android, Web), four execution modes (`scenario`, `record`, `static`, `audit`), and an opt-in web jump-off crawler that splices hosted web journeys into native flow maps. Output is a static HTML viewer (Dagre layout, vanilla JS) plus a JSON graph and screenshots. Optionally serve the output via the built-in Express server for shared persistence of layout positions and hidden-node state.

Code orientation:
- `bin/cli.js` — CLI entry point
- `src/index.js` — pipeline orchestration (`generate` for web, `generateNative` for iOS/Android)
- `src/build-viewer.js` — both the build-time HTML/CSS/JS generator and the viewer's runtime JS (embedded as a string template)
- `src/server.js` — Express server (`serve` subcommand and `--serve` flag), `/api/maps/:name/{positions,hidden}` REST endpoints
- `src/swift-parser.js` / `src/kotlin-parser.js` — native parsers
- `src/swift-injector.js` / `src/swift-spike-runner.js` — iOS fast screenshot pipeline
- `src/web-jumpoff-crawler.js` / `src/web-jumpoff-cache.js` / `src/splice-web-subgraphs.js` — the web jump-off pipeline
- `src/scenario-runner.js`, `src/recorder.js`, `src/crawler.js` — web pipeline

For full architecture see [`../how-it-works.md`](../how-it-works.md).

## Recently delivered (see archive)

| Workstream | Outcome |
|---|---|
| [Layout: subgraph ownership + virtual inference](archive/layout-subgraph-ownership.md) | Extracted shared `assignSubgraphLayout` helper; iOS TabView tab targets now become column starts; `inferVirtualSubgraphOwners` detects hub-shaped iOS graphs without TabView and assigns logical columns. nhsapp-ios-demo-v2 now renders 4 columns (HomeView, Prescriptions, Appointments, Profile). Android byte-identical. |
| [iOS fast screenshot pipeline](archive/ios-screenshots-fast-path.md) | Replaced XCUITest with `simctl` launch-args injection. `xcodebuild build` (no test target) + idempotent code injection + `simctl launch -quiverRoute <route>` + `simctl io screenshot`. ~12× faster (1m 17s vs 13m 36s) with better coverage (26 screenshots vs 17). Handles item:-bound sheets, sub-NavigationStack hosts, and root "home" route. |
| [iOS screenshot coverage: required-param push views](archive/ios-required-param-screenshots.md) | Extended `synthesizeSwiftValue` + `findStoredProperties` to handle `() -> Void` → `{}`, `Binding<T>` → `.constant(...)`, and inline `//` comments on property declaration lines. Added `RowLink(label:, destination:)` parser pattern. Fixed `buildRoutePlan` and both helper generators to attempt synthesis before skipping required-param views. Unlocked `TrustedPersonDetailView` and the full `RemoveTrustedPerson*` chain (~5 new screenshots). |
| [Node hiding](archive/node-hiding.md) | Right-click context menu (hide node / hide subgraph), Show-hidden popover with per-node restore, persistence-key fix so state survives regeneration |
| [Tree-shaped layout — Part A](archive/tree-layout.md) | Replaced the centred-blob fallback with dagre's tree-shaped X positions; iOS and web maps without explicit tabs now look tree-shaped instead of clumped |
| [Server integration](archive/server-integration.md) | `/api/maps/:name/hidden` endpoint pair, viewer-side server detection with localStorage fallback, hidden-state carry-forward via `hidden.json`, `--serve` flag for one-shot generate-and-serve, plus `--port` UX rework |
| [Accessibility improvements](archive/accessibility-improvements.md) | WCAG 2.2 AA pass on the viewer: tokenised CSS with light/dark themes, no-flash theme bootstrap, full keyboard support (listbox semantics with roving tabindex, `]`/`[` for graph edges, `M` for move mode), screen-reader landmarks, outline alternative view, reduced-motion + forced-colours media queries, parallel pass on the maps-index page. |
| [Accessibility: contrast audit](archive/accessibility-improvements-contrast.md) | Phase 1 token follow-up: re-tuned light/dark token contrast and shipped the re-runnable `scripts/contrast-audit.js` (Playwright + axe-core + per-token measurement). Audit reports zero genuine failures in either theme. |
| [Portable viewer + `upgrade` command](archive/portable-viewer-upgrade.md) | Per-map shell is now feature-stable; viewer loads `graph-data.json` + `runtime.json` sidecars over fetch with inline fallback for `file://`. Theme bootstrap + dagre extracted to shared assets. New `quiver upgrade` subcommand re-bakes every map in an output dir against the current viewer without re-running the parser/crawler. |

## Active

### Native session recorder

Bring the web recorder's "watch a real session" approach to the native (iOS/Android) pipeline. Native maps today come only from static parsing + programmatic capture, which carries the **seed-data problem** — Android extracts seed IDs from ViewModel source, iOS needs hand-written `overrides.<view>.steps` — so they map what the parser can reach with fabricated data, not what a real user experiences with real state. A native recorder closes that gap the same way `--record` does for web: the human drives the prototype and Quiver observes.

**Design (full detail in [`native-recorder.md`](native-recorder.md)):** an in-app navigation hook — extending the injectors that already ship (Android `TestHooks` + `LaunchedEffect`; iOS `src/swift-injector.js`) — emits a screen-change event over logcat/oslog; the host listens and captures a screenshot via the existing `adb`/`simctl` path on each event; output is a `.flow` script + the standard `generateNative` viewer. Net-new surface is small: an event observer per injector, a host-side listener, and a `.flow` writer (the web recorder's writer is a near-template).

**Sequence:** Android first (lowest effort — the NavHost injection and `adb` capture already exist), then iOS (medium — label fidelity is the wrinkle; optional `.quiverScreen("Name")` modifier for clean names). A no-injection fallback (Android `AccessibilityService`, or driver/CV) is later, behind the same `SessionEvent → .flow` adapter. No third-party software on the recommended path. See [`native-recorder.md`](native-recorder.md) for "Files to change" and per-platform implementation detail.

Next candidates (in rough priority order) — see [`future-ideas.md`](future-ideas.md) and [`layout-overlap-fixes.md`](layout-overlap-fixes.md) for detail:

1. **Server collaboration features (Phases 2–5)** — comments/annotations, lightweight identity + SQLite, real-time sync, and web-triggered generation, building on the delivered Phase 1 (server + positions). Detail in [`future-ideas.md`](future-ideas.md#server-collaboration-features-phases-25).
2. **Variant comparison mode** — `quiver compare` subcommand for capturing the same screens under multiple variant conditions (branches, flavors, token overrides) and outputting a side-by-side comparison viewer. Plan is in [`variant-comparison.md`](variant-comparison.md).
3. **Layout: node overlap** — screenshot thumbnails still overlap in some maps (tight `ranksep`/`nodesep` constants). Plan is in [`layout-overlap-fixes.md`](layout-overlap-fixes.md); start with Layer 1 (scale sep constants when screenshots are on) and re-measure.
4. **iOS: orphaned nodes** — filter views with no incoming navigation edges from the graph (or badge them in the viewer), so dead code doesn't appear as screenless nodes. See future-ideas.md for Option A vs B tradeoffs.

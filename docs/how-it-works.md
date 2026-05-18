# How it works

## Web prototypes — record mode

1. **Starts the prototype server** and launches a headed (visible) browser
2. **Injects a toolbar** into every page via `page.addInitScript()` for phase control and interaction capture
3. **Setup phase**: the user clicks through login/setup steps, which are recorded as `Goto` and interaction steps
4. **Map phase** (after clicking "Begin mapping"): each page navigation triggers a real-time capture:
   - Hides the toolbar, dismisses modals, repositions fixed elements
   - Takes a full-page screenshot
   - Extracts all links from the rendered DOM
   - Builds a graph node for the page
5. **On finish** (toolbar button or browser close):
   - Builds edges between pages from extracted links, using canonical-to-raw URL mapping to match link targets to visited nodes
   - Groups tab siblings (pages with mutual cross-links) into the same layout rank
   - Generates the viewer, Mermaid sitemap, and metadata
   - Saves a `.flow` script (with dynamic URLs converted to `Snapshot` steps for replay robustness)

Key files: `src/recorder.js`, `src/recorder-inject.js`, `src/flow-serializer.js`

## Web prototypes — static mode

1. **Scans** `app/views/` for all `.html` template files
2. **Parses** each template for `href` links, `<form action>` attributes, JS redirects, and `{% if %}` conditional blocks
3. **Parses** route handlers (`routes.js`, `app.js`) for explicit `res.redirect()` and `res.render()` calls
4. **Builds a directed graph** of pages (nodes) and navigation paths (edges)
5. **Starts the prototype**, crawls every page with Playwright, and takes screenshots
6. **Generates a static HTML viewer** with the graph and screenshots embedded

## Web prototypes — scenario mode

1. **Loads scenario config** from the `scenarios/` directory (`.flow` scenarios, `fragments/` for shared steps, `.set` files for groups) and optional `quiver.config.yml`
2. **Runs static analysis** — scans templates and route handlers for enrichment metadata
3. **Starts the prototype server** and launches a headless browser
4. **For each scenario:**
   - Creates a fresh browser context (isolated cookies/session)
   - Executes setup steps (login, navigate, fill forms)
   - Maps pages via visit-driven steps or BFS crawl within scope
   - Handles interactive steps (`click`, `check`, `select`) and `snapshot` for session-dependent pages
   - Waits for network idle and dismisses modals/overlays/BrowserSync UI before capturing screenshots
   - Captures dynamically-sized screenshots (height based on actual page content)
   - Resolves redirects (e.g. `/clinics` → `/clinics/today`) to preserve edge connections
   - Computes layout ranks for grid arrangement
5. **Enriches** the runtime graph with static analysis metadata (titles, file paths, node types)
6. **Generates** a viewer, Mermaid sitemap, and metadata per scenario
7. **Optionally merges** multiple scenario graphs into a combined view

## iOS prototypes

1. **Scans** for all `.swift` files in the project
2. **Parses each file twice.** Pass 1 walks every file harvesting a project-wide `urlBindings` map from `enum X: ..., WebFlowConfig { var url: URL { switch self { case .name: URL(...)! } } }` declarations (cross-file resolution for native→web handoffs). Pass 2 parses each file's SwiftUI navigation patterns (`NavigationLink`, `.sheet`, `.fullScreenCover`, `.navigationDestination`, web-view covers, `WebView`, `WebLink`, `UIApplication.shared.open`), threading `urlBindings` through to resolve `activeCover = .caseName` assignments via `@State var foo: SomeEnum?` type qualification.
3. **Builds a directed graph** of screens and navigation edges
4. **Generates a temporary XCUITest** that navigates to each screen and takes a screenshot
5. **Runs `xcodebuild test`** in the iOS Simulator, collects the PNG files
6. **Generates a static HTML viewer** with the graph and screenshots embedded

## Android prototypes

1. **Scans** for all `.kt` files in the project
2. **Parses** each file for Jetpack Compose navigation patterns (`navController.navigate()`, NavHost `composable()` entries with their `navArgument {...}` declarations, `BottomNavItem` registrations, `slideIntoContainer` modal transitions, `openTab()` external links)
3. **Extracts seed IDs** from ViewModel source — the parser scans `MutableStateFlow(...)` initializers and `fun default*()` bodies for top-level `id = "..."` literals, plus the return type of `fun get<Xxx>(...)`. When a screen's lambda calls `vm.getTrustedPerson(id)` for a `{id}` param, the parser links that nav arg to a concrete seeded ID so the test can navigate with real data instead of blanks
4. **Builds a directed graph** of screens and navigation edges; the parser records the raw NavHost route template (`message_detail/{messageId}`) and the resolved nav args on each node
5. **Auto-injects** two files into the prototype at run time:
   - `navigation/TestHooks.kt` — a `@VisibleForTesting` singleton exposing `NavHostController?`
   - A single `LaunchedEffect(navController) { TestHooks.navController = navController }` line into whichever `.kt` file hosts the `NavHost` — both are idempotent (skipped if already present)
6. **Generates a temporary `QuiverCapture.kt`** instrumented test that navigates to each screen by calling `navController.navigate("<resolvedRoute>")` directly (not by tapping UI) and captures via `composeTestRule.onRoot().captureToImage()`. Parameterized routes are resolved per placeholder with priority: config override → declared `navArgument` `defaultValue` → extracted seed ID → type-aware fallback (`StringType` → `"1"`, `BoolType` → `"false"`, `Int/LongType` → `"0"`, `FloatType` → `"0.0"`)
7. **Builds debug + androidTest APKs**, installs them, runs `am instrument` directly on the device (skipping `connectedDebugAndroidTest` because that task uninstalls the app before screenshots can be pulled), `adb pull`s PNGs off the device, then uninstalls
8. **Restores all injected files and animation settings** in a `finally` block, leaving the prototype's git status unchanged
9. **Generates a static HTML viewer** with the graph and screenshots embedded

Most parameterized routes resolve automatically. Override values in `quiver.config.yml` only when you want a specific seed record, or when the auto-resolved fallback hits a dead end:

```yaml
overrides:
  message_detail:
    route: "message_detail/demo-msg-1"
  familyCarer/trusted:
    params:
      id: "trusted-2"
```

## Web jump-offs (iOS + Android)

When `--web-jumpoffs` is set on a native run, after the native graph is built but before screenshot capture:

1. **Collects seed URLs** from every `type: "external"` / `web-view` node whose origin is on the configured `webJumpoffs.allowlist`. Native parsers feed in URLs from `WebView`, `WebLink`, `UIApplication.shared.open`, `.webView(...)` covers, `enum X: ..., WebFlowConfig` enums (iOS), and `openTab` / `InAppBrowser` / `CustomTabsIntent.Builder` / `WebFlowConfig(url=...)` bindings (Android)
2. **Per-origin browser context** — each origin gets its own Playwright `BrowserContext` with `addInitScript` injecting the chrome-stripping CSS that the production native InAppBrowser uses (`.hide-on-native { display: none }` plus NHS prototype-kit wrapper paddings, plus belt-and-braces selectors for prototypes that don't tag their chrome with `.hide-on-native`)
3. **Two-phase BFS budget** — phase 1 visits every seed across every origin (so each native handoff gets its root node + screenshot even under tight budgets), phase 2 does round-robin BFS expansion across origin queues until `maxPages` is exhausted
4. **Per-page disk cache** — every visited URL's metadata + screenshot are cached on disk keyed by `sha256(canonical_url + config_fingerprint)`, where the fingerprint covers viewport, `hideNativeChrome`, `injectCss`, screenshots-enabled. Subsequent runs (e.g. running against your iOS prototype after running against the Android one) hit the cache for any URL the first run touched. 24h TTL, errors not cached
5. **Screenshot capture** — `clip: { x: 0, y: 0, width, height }` so web screenshots match the native portrait aspect ratio (375×812 → 750×1624 PNG with deviceScaleFactor 2). Cache hits skip the network round-trip and copy the cached PNG into the run's output dir
6. **Splice into native graph** — pre-existing `external` / `web-view` nodes are upgraded in place: `type` becomes `web-page`, the id is normalised to canonical URL form, pre-existing edges are retargeted, and `subgraphOwner` + `layoutRank` are BFS-propagated from each upgraded root to its descendants so the column-packed viewer layout places the whole web subgraph under its native handoff
7. **Native screenshot phase runs after the splice** so the iOS/Android crawlers never see web nodes

Key files: `src/web-jumpoff-crawler.js` (Playwright BFS + cache integration), `src/web-jumpoff-cache.js` (per-page disk cache), `src/splice-web-subgraphs.js` (in-place node upgrade + rank propagation). See [Web jump-offs](web-jumpoffs.md) for the user-facing reference.

### Hidden-link filtering

When `webJumpoffs.hideNativeChrome` is true (the default), the BFS link extractor in `src/crawler.js` (`extractRuntimeLinks`) walks each `<a>`'s ancestor chain and skips links whose own or ancestor's computed `display`/`visibility` makes them invisible. Mirrors what the user can actually click inside the production InAppBrowser — pages reachable only via hidden chrome (bottom nav, header logo, footer, cookie banner) don't appear as nodes. Reduced edge counts on the Android smoke target from 460 → 152.

## Serving generated maps

The tool can run as a local web server over an output directory:

```bash
npx quiver serve ./quiver-output --port 3000
```

When the viewer detects it's being served (via `GET /api/health`), it switches from `localStorage`-only persistence to API-backed persistence. Layout positions saved with the "Save layout" button go to `PUT /api/maps/:name/positions` and are written to `<output>/maps/<name>/positions.json`. Viewers opened directly from disk (file://) fall back to `localStorage`.

On regeneration, `buildViewer` reads the existing `positions.json` and embeds it as `window.__SAVED_POSITIONS__` so manual layout adjustments survive map updates (for nodes whose IDs still exist).

Key files: `src/server.js`, `src/build-viewer.js`. See [`viewer.md`](viewer.md#repositioning-nodes) for the position-loading priority chain.

## Canonical deduplication

The tool automatically deduplicates parameterised routes. URLs like `/participants/abc123` and `/participants/def456` are recognised as the same canonical pattern (`/participants/:id`), and the crawler visits at most 3 instances per pattern. This prevents the map from exploding when there are hundreds of entity pages.

## Static enrichment

Runtime graphs are enriched with metadata from static template analysis:

- Page titles (from `{% set pageHeading %}` or `<title>`)
- File paths (which template serves each route)
- Node types (form, hub, page, start)
- Conditional branch labels

The runtime graph is always the primary source of truth — static data only supplements.

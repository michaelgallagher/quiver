# Design decisions

> The "why" behind major architectural choices. Useful when picking up the codebase cold or evaluating whether to revisit a decision.
>
> Each entry: what we decided, what we considered, and why we picked the approach we did. If a decision is later overturned, move the entry to `archive/` with a note.

---

## Scenario-first runtime mapping (web)

**Decision:** Web prototypes use scenario-driven runtime mapping as the primary mode. Static template analysis plays a supporting role, used for enrichment metadata but not as the source of truth.

**Considered:**
- **Pure static analysis.** Parse Nunjucks templates and Express routes; build the graph from the template tree. Fast, no browser needed, no flakiness.
- **Pure broad runtime crawl.** Spin up the prototype, crawl every reachable URL with Playwright, capture screenshots.
- **Scenario-first runtime mapping** (chosen). Crawl only from realistic entry points with real session/seed state, following the user-defined scenario.

**Why:** testing on `manage-breast-screening-prototype` showed that broad runtime crawling produced too many technically reachable but contextually invalid screens, black/empty screenshots from pages visited without required session state, and global-nav noise dominating the graph. The output looked like a route inventory, not a user journey map. Scenario-first mapping starts from realistic entry points with real session/seed state, crawls only valid in-scenario navigation, and produces one focused map per scenario. Static analysis still adds value as enrichment (titles, file paths, node types) but is no longer the primary source of truth.

**Where:** `src/scenario-runner.js`, `src/static-enrichment.js`. Runtime graph is always primary; static data only supplements.

---

## `.flow` DSL over YAML for scenarios

**Decision:** Scenarios are authored in a flat `.flow` DSL (one file per scenario), not nested YAML.

**Considered:**
- **YAML-only.** Indented step lists under each scenario, all scenarios in one config file.
- **`.flow` DSL** (chosen). Flat plain-text format, one file per scenario.

**Why:** YAML's indentation requirements made step sequences verbose. One-file-per-scenario in `.flow` format is easier to scan and review in diffs. The flat `Goto`/`Click`/`Visit`/`Snapshot` syntax reads more naturally than nested YAML. YAML config remains useful for global settings (canonicalization, filters), but scenarios themselves are better as `.flow`.

**Where:** `src/flow-parser.js`, `src/flow-serializer.js`. Scenarios live in `scenarios/` directories of prototypes; fragments in `scenarios/fragments/`; scenario sets in `scenarios/*.set`.

---

## Static analysis as enrichment, not source of truth

**Decision:** When both static and runtime data are available, runtime wins. Static data fills in metadata (titles, file paths, node types, conditional branch labels) but doesn't override runtime-discovered nodes or edges.

**Why:** runtime captures what actually happens; static captures what the code says might happen. The discrepancy is often the point of building the map — runtime might reveal the user takes a path the templates don't cleanly express. If static overrode runtime, those discrepancies would be invisible.

**Where:** `src/static-enrichment.js` is called after the runtime graph is built; it merges metadata onto existing nodes and skips nodes the runtime didn't discover.

---

## Direct `am instrument` for Android, not `connectedDebugAndroidTest`

**Decision:** Android screenshot capture invokes `am instrument` directly on a connected device, after manually building+installing the debug and androidTest APKs.

**Considered:**
- **`./gradlew connectedDebugAndroidTest`** — the canonical Gradle path.
- **Direct `am instrument`** (chosen).

**Why:** `connectedDebugAndroidTest` uninstalls the app at the end of the test run as part of its cleanup. The screenshot files are written to the app's `externalCacheDir`, which is wiped when the app is uninstalled. So screenshots vanish before we can `adb pull` them. By invoking `am instrument` directly, we control the lifecycle: build APKs, install, run instrumentation, pull screenshots, then uninstall.

**Where:** `src/android-test-generator.js`. The cleanup logic in a `finally` block restores prototype state (animation settings, injected files) regardless of success or failure.

---

## NavController route navigation, not UI tap navigation (Android)

**Decision:** Android screenshot capture navigates by calling `navController.navigate("<route>")` directly, not by tapping UI elements.

**Considered:**
- **UiAutomator + tap-by-label** — find each tab/button by accessibility label and tap.
- **Compose test rule + UI traversal** — find UI nodes via `composeTestRule.onNodeWith...` and click.
- **Direct navController calls** (chosen).

**Why:** UI-driven navigation is brittle. Buttons may be off-screen (need scroll), labels may be localised (need lookup), splash screens may delay (need timing), conditional rendering may hide expected paths. The parser already produces correct route strings as node IDs — calling `navController.navigate("messages")` directly bypasses all of that and renders the screen exactly as it would be rendered after a real navigation.

**Where:** `src/android-test-generator.js` generates a `QuiverCapture.kt` test that uses `TestHooks.navController` (a `@VisibleForTesting` singleton injected at `LaunchedEffect` time) to navigate to each route. Parameterised routes are resolved per placeholder with priority: config override → declared `navArgument` `defaultValue` → extracted seed ID → type-aware fallback.

---

## Web jump-offs as opt-in, not default

**Decision:** Web jump-off crawling requires `--web-jumpoffs` flag (or `webJumpoffs.enabled: true` in config). Default behavior is to render external URLs as flat chips.

**Why:** crawling is slow, network-dependent, and requires an allowlist (anything else stays a flat external node). Forcing every iOS/Android run to do it would make first-time runs much slower and surprise users with network requests they didn't ask for. Opt-in keeps the default fast and predictable.

**Where:** `src/index.js` (orchestration), `src/flow-map-config.js` (config defaults), `bin/cli.js` (`--web-jumpoffs` / `--no-web-jumpoffs` tri-state).

---

## Per-page disk cache (not per-origin) for web jump-offs

**Decision:** Web jump-off cache keys entries per page (canonical URL + config fingerprint), not per origin.

**Why:** seed sets differ between platforms — iOS and Android jump to different URLs from the same hosted prototype. Per-page granularity means any URL overlap is reused regardless of how the seeds differ. Cross-platform iOS→Android run hits the cache 27/40 times (67%) for shared NHS prototype origins. Per-origin caching would have required all-or-nothing reuse and missed those gains.

**Where:** `src/web-jumpoff-cache.js`. Cache key: `sha256(canonicalUrl + configFingerprint)`. Fingerprint covers viewport, `hideNativeChrome`, `injectCss`, screenshots-enabled (the fields that affect captured output) — NOT `maxDepth`/`maxPages`/`timeoutMs`/`allowlist` (which only affect BFS shape, not what's captured per page).

---

## CSS injection over UA matching for chrome stripping

**Decision:** Web jump-off crawler hides hosted-prototype chrome (header, bottom-nav, footer, cookie banner) by injecting CSS via Playwright's `addInitScript`, not by setting a User-Agent string that the prototype could sniff.

**Considered:**
- **UA matching.** Set User-Agent to `NHSApp/native` (or similar) and let the prototype's own JavaScript hide chrome based on UA detection.
- **CSS injection** (chosen).

**Why:** tested production-style UA strings (`NHSApp/native`, with Android suffix, with iOS suffix) against deployed NHS prototypes — none hid the chrome. The hosted apps don't actually sniff UA. The production native InAppBrowser hides chrome by injecting CSS post-load, so mirroring the CSS path uses the same code path production uses. Belt-and-braces direct selectors handle prototype variation (some wrap chrome in `.hide-on-native`, some don't).

**Where:** `src/web-jumpoff-crawler.js` `NATIVE_APP_CSS` constant + `buildInitScript()` function.

---

## Skip-hidden links as opt-in (not default-on for all crawlers)

**Decision:** The `extractRuntimeLinks(..., { skipHidden: true })` option is only used by the web jump-off crawler. The recorder, scenario runner, and static `crawlAndScreenshot` continue to extract all links.

**Why:** the recorder and scenario runner deliberately drive prototypes; a hidden link the user later reveals (collapsed details, conditional UI) is still legitimate for them to know about. Static `crawlAndScreenshot` doesn't inject chrome-stripping CSS, so the filter has nothing to act on. Web jump-offs are the one context where we actively hide DOM elements via injected CSS; that's the only crawler that opts in.

**Where:** `src/crawler.js` `extractRuntimeLinks` accepts an `options.skipHidden` flag. Currently passed by `src/web-jumpoff-crawler.js` only.

---

## Two-phase BFS budget for web jump-offs

**Decision:** Web jump-off BFS runs in two phases: phase 1 visits every seed across every origin first; phase 2 round-robins BFS expansion across origin queues until `maxPages` is exhausted.

**Considered:**
- **Single-phase BFS.** Treat all origins as one queue.
- **Per-origin budgeting.** Allocate `maxPages / numOrigins` per origin.
- **Two-phase** (chosen).

**Why:** single-phase BFS lets a wide-branching origin (one with many same-origin links) starve narrow ones — the wide one's queue fills up fast, all `maxPages` go to it, and other origins never get visited. Per-origin budgeting wastes budget on origins that don't have many pages worth crawling. Two-phase gives each origin at least its root visit (phase 1) plus a fair share of expansion (phase 2 round-robin).

**Where:** `src/web-jumpoff-crawler.js`.

---

## Init-script defensive deferral pattern

**Decision:** The web jump-off crawler's chrome-stripping init script defers via `readystatechange`, `DOMContentLoaded`, and `MutationObserver` on `document` until a target node is available before attempting to inject CSS.

**Why:** Chromium's init scripts fire before `document.documentElement` exists. A naive `(document.head || document.documentElement).appendChild(style)` throws `Cannot read properties of null (reading 'appendChild')` and silently aborts — no chrome is hidden, but the run otherwise succeeds, so the bug is invisible until a user notices the chrome in screenshots. The deferral pattern guarantees the injection happens once a target node exists.

**Where:** `src/web-jumpoff-crawler.js` `buildInitScript()`.

---

## Express + REST for the server (not raw `http` + RPC)

**Decision:** The viewer server uses Express with REST conventions (`GET /api/maps/:name/positions`, `PUT /api/maps/:name/positions`).

**Considered:**
- **Raw Node `http` module + query-string POST endpoint.** Simpler, no dependencies. (Implemented on the abandoned `saving-and-serving` branch.)
- **Express + REST** (chosen).

**Why:** Express adds a real dependency but pays for itself as soon as we add a second endpoint (`/hidden`, then comments, etc.). REST conventions (GET to read, PUT to write) make the API self-documenting and easy to extend. Validation is cleaner with Express's middleware. The raw `http` approach worked fine for one endpoint but didn't scale to the 2–4 endpoints we'll need over time.

**Where:** `src/server.js`.

---

## Auto-injection of test hooks (Android), not pre-existing hooks

**Decision:** The Android pipeline auto-injects two files at run time: `navigation/TestHooks.kt` and a `LaunchedEffect` line in the NavHost host file. Both injections are idempotent (skipped if already present) and restored in a `finally` block so the prototype's git status is unchanged.

**Considered:**
- **Require the prototype author to commit test hooks.** Documented in setup, manual to add.
- **Auto-injection** (chosen).

**Why:** prototype authors aren't necessarily test-aware, and the test hooks are tool-specific (only meaningful when running Quiver). Requiring hand-written hooks would be a documentation cliff and a footgun (forget to add → confusing error). Auto-injection means the tool just works on any Android prototype. Idempotency + cleanup guarantees no permanent side effect.

**Where:** `src/android-test-generator.js`.

---

## Canonical URL deduplication across parameterised routes

**Decision:** URLs like `/participants/abc123` and `/participants/def456` are recognised as the same canonical pattern (`/participants/:id`); the crawler visits at most 3 instances per pattern.

**Why:** without dedup, prototypes with hundreds of seed records would explode the graph into hundreds of near-identical nodes, none of which add information. The 3-instance cap keeps multi-record patterns visible (so the user sees there ARE multiple records) without overwhelming the map.

**Where:** `src/crawler.js` canonicalization logic.

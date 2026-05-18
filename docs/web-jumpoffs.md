# Web jump-offs

Native iOS and Android prototypes commonly hand off to hosted web prototypes (NHS Prototype Kit apps on Heroku, internal staging URLs, or `nhs.uk` content pages) for parts of the user journey — e.g. a "Start now" button that opens a GP appointment booking flow in an in-app web view.

By default the tool renders these as flat external chips. With `--web-jumpoffs` the tool crawls each linked URL, captures screenshots that match what the user sees inside the production in-app web view, and splices the resulting subgraph into the native flow map so the journey reads as one continuous experience.

## Quick start

```bash
# Add --web-jumpoffs to any iOS or Android run
npx quiver /path/to/native-prototype --web-jumpoffs
```

You'll also need a `quiver.config.yml` in the prototype root with at least one `allowlist` origin — only allowlisted origins are crawled (anything else stays a flat external node):

```yaml
webJumpoffs:
  enabled: true
  allowlist:
    - https://your-prototype.herokuapp.com
    - https://www.nhs.uk
```

## What gets detected

The native parsers recognise the following native→web handoff patterns. Every detected URL becomes a candidate seed for the crawler.

### iOS

| Pattern | Example | Edge type |
|---|---|---|
| `WebView(url:)` | `WebView(url: URL(string: "https://...")!)` | `webview` |
| `WebLink(url:)` | `WebLink(url: URL(string: "..."))` (with adjacent `Button("Label")`) | `safari` |
| `UIApplication.shared.open` | `UIApplication.shared.open(URL(string: "https://...")!)` | `safari` |
| `.webView(URL(string: ...))` | Enum-based `.fullScreenCover` cover | `custom-webview` |
| `.webView(Self.startURL)` | File-local `private static let startURL = URL(...)!` indirection | `custom-webview` |
| `enum X: ..., WebFlowConfig` | `var url: URL { switch self { case .a: URL(...)! } }` resolved via `activeCover = .caseName` at call sites | `custom-webview` |

The `enum X: ..., WebFlowConfig { var url: URL { switch self { ... } } }` form is resolved across files. The enum body lives in one file, the call site (`activeCover = .repeatPrescription`) in another; the parser does a project-wide pass to harvest URL bindings, then looks them up at every assignment site. `var title: String { ... }` provides the human-readable label. The `struct X: WebFlowConfig` form (where the URL is a constructor-bound stored property) is skipped — the URL is only known at runtime.

### Android

| Pattern | Example | Edge type |
|---|---|---|
| `openTab(context, "https://...")` | NHS-app helper | `safari` |
| `InAppBrowser(url = "...")` | Composable that opens an embedded WebView | `custom-webview` |
| `CustomTabsIntent.Builder()...launchUrl(ctx, Uri.parse("..."))` | Direct Chrome Custom Tabs invocation | `safari` |
| `WebFlowConfig(url = "$BASE_URL/path", title = "...")` | Resolved across files via `const val BASE_URL` interpolation, then `activeWebFlow = PrescriptionWebFlow.RepeatPrescription` | `custom-webview` |

## What gets captured

For each crawled URL the tool records:

- **Screenshot** clipped to the native viewport size (default 375 × 812, deviceScaleFactor 2 → 750 × 1624 PNG) so web thumbnails match the aspect ratio of native portrait screens. No full-page tall thumbnails dominating rows.
- **Page title** as the node label (truncated to 80 chars), falling back to the last URL path segment.
- **Same-origin links** (only `<a href>`) for BFS expansion to the next level.

### Links inside hidden chrome are ignored

When `hideNativeChrome` is on (the default), the BFS link-extractor also skips any `<a>` whose own or ancestor's computed `display` is `none`, `visibility` is `hidden`, or final `getBoundingClientRect` is zero-by-zero. This means the chrome we hide visually is also hidden from the graph — pages reachable only via the bottom nav, header logo, footer, or cookie banner don't appear as web-page nodes, because the user can't actually click those links inside the production native InAppBrowser. The crawl phase prints a `Hidden links skipped: N` line summarising how many were filtered. Set `hideNativeChrome: false` to opt out — useful when you want a structural map of the hosted prototype in isolation rather than as it appears inside the native app.

### Native chrome stripping

Hosted NHS prototypes use the same DOM as the production NHS App but render their own header / bottom-nav / footer when served to a plain browser. The production native InAppBrowser hides those elements via injected CSS so the page looks native. The crawler mirrors that injection (Playwright `addInitScript` runs before any page script, equivalent to iOS's `WKUserScript(.atDocumentStart)`):

```css
/* Production parity — what the real native InAppBrowser injects */
.hide-on-native { display: none !important; }
.nhsuk-back-link { margin-bottom: 0 !important; margin-top: 16px !important; }
.nhsuk-main-wrapper { padding-top: 16px !important; }
.app-width-container { padding-top: 0 !important; }

/* Belt-and-braces — direct selectors for prototypes that don't wrap their
   chrome in `.hide-on-native` */
.app-global-navigation-native,
.app-global-navigation-web,
header.nhsuk-header,
.nhsuk-header,
.app-bottom-navigation,
#bottomNav,
.nhsapp-tab-bar,
.nhsuk-footer-container,
.nhsuk-footer,
#nhsuk-cookie-banner,
.nhsuk-cookie-banner,
#cookiebanner { display: none !important; }
```

Set `webJumpoffs.hideNativeChrome: false` to keep the chrome visible. Add custom rules via `webJumpoffs.injectCss: "..."` (plain CSS string, appended to the chrome-stripping CSS).

## Crawl budget and ordering

Two-phase BFS prevents wide-branching origins from starving narrow ones:

1. **Seed phase** — every allowed seed across every origin is visited first, so each native handoff gets at least its root node + screenshot even under tight budgets.
2. **Expansion phase** — round-robin BFS pop-one-from-each-origin until `maxPages` is exhausted.

Defaults: `maxDepth: 3`, `maxPages: 40`, `timeoutMs: 15000`, `sameOriginOnly: true`.

## Caching

The crawl output is cached on disk per page. Subsequent runs (e.g. running the tool against your iOS prototype after running it against the Android one, where both link to the same Heroku origins) skip the network round-trip and screenshot capture for any URL the cache already has.

- **Location**: `$XDG_CACHE_HOME/quiver/web-pages/` (default `~/.cache/quiver/web-pages/`).
- **Key**: `sha256(canonical_url + config_fingerprint)`. The fingerprint covers the fields that change a single page's captured output: viewport, `hideNativeChrome`, `injectCss`, screenshots-enabled. Changing those fields auto-invalidates without manual intervention. `maxDepth`/`maxPages`/`timeoutMs`/`allowlist` are *not* in the fingerprint because they only affect BFS shape, not page content.
- **TTL**: 24 hours by default (`webJumpoffs.cache.ttlMs`). Older entries are pruned automatically before each run.
- **Errors aren't cached** — they retry every run, since they're often transient (timeouts, 503s).

The crawl phase prints a hit/miss summary:

```
3️⃣ b Crawling 12 web jump-off(s) (maxPages=40)...
   Added 28 web-page node(s), upgraded 12 native jump-off(s), added 460 link edge(s)
   Cache: 27 hit(s), 13 miss(es)
```

### Cache CLI flags

- `--no-web-cache` — skip cache lookups for this run only (cache on disk is preserved). Use to force a fresh crawl without losing the cache for next time.
- `--clear-web-cache` — wipe the cache directory before crawling. Use when a hosted prototype has changed and you want to re-capture everything.

## Config reference

Full `webJumpoffs` block in `quiver.config.yml`:

```yaml
webJumpoffs:
  enabled: false           # Opt-in. Set true here, or use --web-jumpoffs flag.
  maxDepth: 3              # BFS depth from each seed
  maxPages: 40             # Total pages across all origins
  timeoutMs: 15000         # Per-page page.goto timeout
  sameOriginOnly: true     # Don't follow links off the seed's origin
  screenshots: true        # Capture PNGs (set false for graph-only)
  hideNativeChrome: true   # Inject the chrome-stripping CSS
  injectCss: null          # Optional extra CSS appended to the above
  allowlist:               # Required — only these origins are crawled
    - https://your-prototype.herokuapp.com
    - https://www.nhs.uk
  cache:
    enabled: true
    ttlMs: 86400000        # 24 hours in ms
    dir: null              # Override cache directory (default: ~/.cache/...)
```

CLI overrides:

| Flag | Effect |
|---|---|
| `--web-jumpoffs` | Force `webJumpoffs.enabled = true` regardless of config |
| `--no-web-jumpoffs` | Force `webJumpoffs.enabled = false` regardless of config |
| `--no-web-cache` | Skip the cache for this run only |
| `--clear-web-cache` | Wipe the cache directory before crawling |

## In the viewer

- Web pages render as `web-page`-typed nodes with a tinted fill and dashed stroke (distinct from the solid native nodes).
- The first node in each crawled subgraph (the URL the native app handed off to) gets a heavier `subgraph-root` stroke.
- The pre-existing native external/web-view node is upgraded in place — its type becomes `web-page` and any pre-existing edges are retargeted to the canonical URL form, so you don't end up with a duplicate node alongside the crawled one.
- Each crawled subgraph inherits the column position of its native handoff via `layoutRank` propagation, so the whole web journey sits in-column under the native screen that linked to it.

## Limitations

- **Form-gated journeys**: BFS follows `<a href>` only. Pages that progress via `<form method="post">` submission ("Start now" buttons that POST) won't be reached. Workaround pending a future scenario-style driver layered on top of the crawler.
- **Authenticated pages**: each crawl creates a fresh browser context per origin with no cookies. Pages behind a login form are unreachable. (Hosted NHS prototypes are typically auth-free.)
- **JS-only navigation**: links that exist only as click handlers (no `<a href>`) are not extracted.

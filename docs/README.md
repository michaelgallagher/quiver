# Documentation

Reference docs and forward-looking plans for quiver.

## What is this tool?

`quiver` generates interactive flow maps from prototype projects. It supports three platforms (web, iOS, Android), four mapping modes (`scenario`, `record`, `static`, `audit`), and an opt-in web jump-off crawler that splices hosted web journeys into native flow maps.

Output is a static HTML viewer (Dagre layout, vanilla JS) plus a JSON graph and screenshots. Optionally serve the output via a built-in Express server for shared layout-position persistence.

## Reference

User-facing documentation. Start here.

| File | What it covers |
|---|---|
| [`how-it-works.md`](how-it-works.md) | End-to-end pipeline architecture for each platform and mode |
| [`cli-reference.md`](cli-reference.md) | Every CLI flag, the `serve` subcommand, output directory layout |
| [`scenarios.md`](scenarios.md) | Writing `.flow` scenarios, fragments, and scenario sets for web prototypes |
| [`recording.md`](recording.md) | Recording scenarios interactively via `--record` mode |
| [`viewer.md`](viewer.md) | Using the generated HTML viewer — pan, zoom, hide, reposition, save, [accessibility](viewer.md#accessibility) |
| [`ios-support.md`](ios-support.md) | iOS / SwiftUI: detected navigation patterns, config overrides, requirements |
| [`android-support.md`](android-support.md) | Android / Jetpack Compose: detected navigation patterns, parameterised routes, requirements |
| [`web-jumpoffs.md`](web-jumpoffs.md) | The opt-in `--web-jumpoffs` crawler — what gets captured, allowlists, caching |
| [`quiver.config.sample.yml`](quiver.config.sample.yml) | Reference example of the YAML config format |
| [`example-scenarios/`](example-scenarios/) | Working `.flow` scenarios + fragments + sets, used for the screening prototype |

## Plans

Forward-looking docs. Read these to pick up where active work left off.

| File | What it covers |
|---|---|
| [`plans/README.md`](plans/README.md) | How the planning docs are organised |
| [`plans/roadmap.md`](plans/roadmap.md) | Active workstreams with full implementation detail |
| [`plans/future-ideas.md`](plans/future-ideas.md) | Deferred items: actionable but not yet scheduled |
| [`plans/design-decisions.md`](plans/design-decisions.md) | The "why" behind major architectural choices |
| [`plans/archive/`](plans/archive/) | Completed or rejected plans, kept for historical context |

## Working with this codebase

If you're picking this up cold (with or without an AI assistant), here's the suggested reading order:

1. **`how-it-works.md`** — get the pipeline architecture in your head
2. **`plans/roadmap.md`** — see what's currently in flight
3. **`plans/design-decisions.md`** — understand why things are shaped the way they are
4. **The relevant platform doc** (`ios-support.md` / `android-support.md` / `scenarios.md` / `recording.md`) for whatever you're working on
5. **`cli-reference.md`** when you need to look up specific flags

When working on a workstream from `plans/roadmap.md`, each section is self-contained: it lists the files to change, the implementation approach, and verification steps. You shouldn't need to read other workstreams unless explicitly cross-referenced.

## Code orientation

| Path | Role |
|---|---|
| `bin/cli.js` | CLI entry point (commander), platform detection, mode dispatch |
| `src/index.js` | Pipeline orchestration: `generate` (web), `generateNative` (iOS/Android) |
| `src/build-viewer.js` | Generates the static HTML viewer + embeds runtime viewer JS as a string template |
| `src/server.js` | Express server (`quiver serve`), REST API for collaborative features |
| `src/flow-map-config.js` | YAML/JSON config loading, scenario/fragment/step validation |
| `src/flow-parser.js` | `.flow` DSL parser |
| `src/flow-serializer.js` | Inverse: recorded steps → `.flow` text |
| `src/scenario-runner.js` | Web scenario execution (Playwright) |
| `src/recorder.js` + `src/recorder-inject.js` | Interactive recording |
| `src/crawler.js` | DOM link extraction, canonicalisation, screenshot capture |
| `src/static-enrichment.js` | Static analysis enrichment of runtime graphs |
| `src/swift-parser.js` | iOS: SwiftUI navigation pattern parser, two-pass for cross-file URL resolution |
| `src/swift-graph-builder.js` | iOS: graph construction from parsed views |
| `src/kotlin-parser.js` | Android: Jetpack Compose navigation pattern parser |
| `src/kotlin-graph-builder.js` | Android: graph construction |
| `src/android-test-generator.js` | Android: generates `QuiverCapture.kt`, runs `am instrument` |
| `src/web-jumpoff-crawler.js` | Web jump-off Playwright BFS, chrome-stripping injection |
| `src/web-jumpoff-cache.js` | Per-page disk cache for jump-off crawls |
| `src/splice-web-subgraphs.js` | Splices crawled web subgraphs into native graphs |
| `src/graph-builder.js` | Web: static graph construction, provenance metadata |
| `src/template-parser.js` | Web: Nunjucks template parsing for static analysis |

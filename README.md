# Quiver

Generate interactive flow maps from Express/Nunjucks prototype kit projects (NHS Prototype Kit, GOV.UK Prototype Kit, etc.). Also supports native iOS/SwiftUI and Android/Jetpack Compose prototypes.

The tool analyses your prototype's templates, routes, and runtime behaviour to produce a visual map of every screen and the connections between them, with screenshots.

![Example flowmap screenshot showing a graph of pages and connections, with a detail panel open for one page showing its screenshot and metadata](docs/assets/example-nhsapp-map.png)

## Features

- **Interactive workflow mapping** — walk through multi-step forms with clicks, fills, checkboxes, and snapshots
- **Scenario-first mapping** — define realistic user journeys and map what users actually experience
- **Combined scenario maps** — run multiple scenarios and produce a merged view with shared nodes
- **Scenario recorder** — click through your prototype in a real browser to generate a flow map and `.flow` script automatically
- **Screenshots** — captured with Playwright, dynamically sized to fit page content
- **Interactive viewer** — pan, zoom, search, drag nodes, filter by provenance
- **Static analysis** — auto-discovers pages from Nunjucks templates and Express route handlers
- **iOS/SwiftUI support** — parses SwiftUI navigation patterns and captures screenshots via XCUITest
- **Android/Jetpack Compose support** — parses Compose navigation + NavHost registrations and captures screenshots via Compose instrumented tests, with automatic seed-ID resolution for parameterized routes
- **Native + web journey joining** — when a native (iOS or Android) prototype hands off to a hosted web prototype, the tool crawls the linked web journey and splices it into the same map, with screenshots that match what the user sees inside the production in-app web view. Per-page disk cache means a second platform run reuses anything the first already captured
- **PDF export** — optional full-canvas or fit-to-screen PDF output

## Quick start

```bash
npm install
npx playwright install chromium
```

### Static mode (default)

This is the basic mode. You give the tool a path to your prototype, and it analyses the Nunjucks templates and Express routes to find all pages and connections. This is a good way to get a quick overview of your prototype's structure, but it won't capture any dynamic behaviour or seed data.

```bash
# Analyse templates and routes without scenarios
npx quiver /path/to/prototype

# Scope to specific start points
npx quiver /path/to/prototype --from "/pages/home,/pages/messages"
```

### Scenario mode

This mode uses a `.flow` script to walk your prototype as a user would, capturing the actual pages visited and interactions performed. This is the recommended way to get a realistic map of your prototype if you rely on seed data (but not only -- it would work for most prototypes). You can write `.flow` scripts by hand or generate them with the recorder.

```bash
# Run a single scenario
npx quiver /path/to/prototype --scenario clinic-workflow

# Run a set of scenarios
npx quiver /path/to/prototype --scenario-set core-user-journeys --desktop

# List available scenarios
npx quiver /path/to/prototype --list-scenarios
```

Scenarios are defined as `.flow` files in a `scenarios/` directory in your prototype. See ["writing scenarios"](docs/scenarios.md) for the full format.

### Record mode

The fastest way to create a flow map. Opens a browser, lets you click through your prototype, and builds the map in real-time from what you do.

```bash
npx quiver --record /path/to/prototype
```

A toolbar at the top of the browser controls the recording. Click through your login/setup steps, then press "Begin mapping" to start capturing pages. When you're done, press "Finish" or close the browser. See the [recording guide](docs/recording.md) for details.

### Upgrading existing maps

After updating Quiver, run `upgrade` to re-bake every map in an output dir against the new viewer — no re-parse, no re-crawl, and saved layouts/hidden state are preserved. See [Upgrading existing maps](docs/viewer.md#upgrading-existing-maps).

```bash
npx quiver upgrade ./quiver-output
```

## Documentation

| Guide | Description |
|---|---|
| [CLI reference](docs/cli-reference.md) | All command-line options, mapping modes, output structure |
| [Using the viewer](docs/viewer.md) | Navigation, filters, repositioning nodes, hiding pages |
| [Writing scenarios](docs/scenarios.md) | `.flow` file format, fragments, scenario sets, visit-driven vs BFS modes |
| [Recording scenarios](docs/recording.md) | Record a flow map by clicking through your prototype in a browser |
| [iOS/SwiftUI support](docs/ios-support.md) | Setup, navigation patterns detected, config overrides |
| [Android/Compose support](docs/android-support.md) | Setup, navigation patterns detected, parameterized-route resolution, config overrides |
| [Web jump-offs](docs/web-jumpoffs.md) | Crawling hosted web prototypes linked from native apps; allowlist, chrome stripping, caching |
| [How it works](docs/how-it-works.md) | Architecture overview for each mode (scenario, static, iOS, Android) |
| [Editor support](editor/README.md) | Syntax highlighting for `.flow` files in VS Code, Zed, Sublime Text, and others |

## Planning and design

Forward-looking docs live in [`docs/plans/`](docs/plans/):

- [`docs/plans/roadmap.md`](docs/plans/roadmap.md) — active workstreams with implementation detail
- [`docs/plans/future-ideas.md`](docs/plans/future-ideas.md) — deferred items
- [`docs/plans/design-decisions.md`](docs/plans/design-decisions.md) — architectural rationale
- [`docs/plans/archive/`](docs/plans/archive/) — completed plans, kept for context

See [`docs/README.md`](docs/README.md) for the full doc index.

## Prerequisites

- Node.js 20+
- For web prototypes: the prototype must be installable and runnable via `node app.js`
- For iOS: Xcode with iOS Simulator
- For Android: Android SDK with `adb` on `PATH`, plus a running emulator or attached device

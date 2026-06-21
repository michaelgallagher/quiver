# iOS / SwiftUI support

The tool supports native iOS prototypes built with SwiftUI. It auto-detects iOS projects (by looking for `.xcodeproj` / `.xcworkspace` files) or you can force it with `--platform ios`.

```bash
npx quiver /path/to/ios-prototype --platform ios
```

## How it works

1. Scans for all `.swift` files in the project
2. Parses each file for SwiftUI navigation patterns
3. Builds a directed graph of screens and navigation edges
4. Generates a temporary XCUITest that navigates to each screen and takes a screenshot
5. Runs `xcodebuild test` in the iOS Simulator and collects the PNG files
6. Generates a static HTML viewer with the graph and screenshots embedded

## Recording a real session (`--record`)

> **Status: experimental — first working version on the `native-recorder` branch.** The iOS sibling of the [Android recorder](android-support.md#recording-a-real-session---record); same host↔device design, same output. Has known rough edges (below and [`plans/native-recorder.md`](plans/native-recorder.md)).

The static path above maps *what the parser can reach with synthesised data*. The recorder instead maps *what you actually do* — you drive the app in the Simulator and Quiver captures each screen you land on. Same output as the web/Android recorders: a flow map viewer plus a replayable `.flow` script.

```bash
npx quiver --record --platform ios --name my-journey /path/to/ios-prototype
```

How it works:

1. It injects a **`UIViewController.viewDidAppear` swizzle** into the prototype's `@main` App file: a `QuiverRecorder` enum + a `UIViewController` extension appended to that file, plus a one-line `QuiverRecorder.install()` trigger inside the `App` struct. On each screen appearance the hook logs `QUIVER_NAV|<screen>|` to the unified log under subsystem `quiver.recorder`. Idempotent, restored afterwards — the code is appended to an **existing** file (never a new one) so it compiles without touching Xcode target membership, the same way the static injector works.
2. **Screen identity** is the SwiftUI view type. A pushed `NavigationStack` destination is hosted in a `UIHostingController` whose root view *is* that destination view, so the hook reads the hosting controller's `rootView` type (via `Mirror`) and reduces it to a leaf name (`ModifiedContent<HomeView, …>` → `HomeView`). This works whether or not the prototype uses the typed `NavigationStack(path:)` pattern the static fast-path needs. Container controllers (`UINavigationController`, `UITabBarController`, …) are skipped.
3. It builds the app (`xcodebuild build`, no test target), installs it on a booted Simulator, starts streaming `simctl spawn <udid> log stream` (begun **before** launch — the unified log has no backlog), then launches it.
4. On each appearance event it waits for the screen to settle, captures via `simctl io <udid> screenshot`, and records a `Visit` step plus an edge from the previously-observed screen — in the order you actually navigated.
5. **Single-phase:** every appearance from launch is captured; each unique screen once. Press **Enter** to finish — the graph, viewer, and `.flow` are built and the injected hook is removed (restore runs even on Ctrl-C). The app is **left installed**. Press **SPACE** to capture the current screen as a fallback (in-app `WKWebView` pages, UIKit alerts).

### Options & device selection

- `--module <substring>` — for repos with **more than one** Xcode project/workspace, selects which one to build/record (matched against the project filename). Without it, the first found is used.
- `--name <slug>` / `--title <title>` — names the map and the `.flow` file (same as the static path).
- **Which Simulator:** the recorder uses the first booted iPhone Simulator, or boots the newest available one.

### Known rough edges & open bugs

- **Screen-name fidelity.** Identity is the SwiftUI view type, so well-named screens (`HomeView`) map cleanly, but views wrapped heavily or named generically can produce rough labels. A future `.quiverScreen("Name")` opt-in modifier would give clean names where wanted.
- **Reflection dependency.** Reading a `UIHostingController`'s `rootView` via `Mirror` is best-effort and can change across iOS versions; it falls back to the controller class name.
- **Full-screen screenshots** include the status bar (no cropping yet), like the Android recorder.
- **In-app web views** aren't auto-captured yet (the Android `WebViewClient` hook has no direct UIKit/`WKWebView` analogue here) — use **Space**. External handoffs are still handled by [`--web-jumpoffs`](#web-jump-offs).
- **Verification status.** Static checks pass (injection against real prototype source, host parse/graph logic), but the on-Simulator runtime path (swizzle, log streaming) has not been re-run yet — you run the recorder.

## Navigation patterns detected

- `NavigationLink`, `NavigationStack` — push navigation
- `TabView` with `.tabItem` — tab navigation
- `.sheet(isPresented:)` / `.sheet(item:)` — modal sheets
- `.fullScreenCover(isPresented:)` / `.fullScreenCover(item:)` — full-screen modals
- `.navigationDestination(for:)` — type-based navigation
- `RowLink`, `HubRowLink` — custom push navigation components
- `WebView(url:)` — web view edges
- `WebLink(url:)` — external Safari links
- `UIApplication.shared.open(URL(string:))` — full handoff to native Safari
- `.webView(URL(string:), ...)` and `.webView(Self.startURL, ...)` — enum-based full-screen covers, with file-local `private static let startURL = URL(...)!` indirection resolved
- `enum X: ..., WebFlowConfig` — cross-file resolution of `var url: URL { switch self { case .a: URL(...)! } }` bodies, looked up from `activeCover = .caseName` assignments at call sites. Optional `var title: String { ... }` provides labels. The `struct X: WebFlowConfig` form (constructor-bound URL) is skipped because the URL is only known at runtime.

## Requirements

- Xcode installed (with iOS Simulator)
- The project must have a UI Testing Bundle target (e.g. `MyAppUITests`)
- At least one `.swift` file in the UITest target (the tool temporarily replaces it)

## Config file (`.quiver.json`)

For screens that auto-detection can't handle — data-dependent UI, custom button components, item-based sheets — you can place a `.quiver.json` file in the prototype root.

```json
{
  "exclude": [
    "SomeEmbeddedComponent",
    "AnotherNonScreen"
  ],
  "overrides": {
    "AppointmentDetailView": {
      "steps": [
        "tap:Appointments",
        "tap:Manage GP appointments",
        "tapContaining:Appointment on"
      ]
    }
  }
}
```

### `exclude`

An array of view names to remove from the graph entirely. Use this for embedded components that the parser picks up as screens but aren't actually navigable destinations.

### `overrides`

A map of view name to custom test steps. Each step is a string in the format `command:arguments`.

| Step | Example | Description |
|---|---|---|
| `tap:Label` | `tap:Appointments` | Tap a button or element matching this label |
| `tapTab:Label:index` | `tapTab:Messages:1` | Tap a tab bar button by label and index (zero-based) |
| `tapContaining:text` | `tapContaining:Appointment on` | Tap the first element whose label contains this text |
| `tapCell:index` | `tapCell:0` | Tap a list cell by index (zero-based) |
| `tapSwitch:index` | `tapSwitch:0` | Tap a toggle/switch by index |
| `swipeLeft:firstCell` | `swipeLeft:firstCell` | Swipe left on the first cell |
| `swipeLeft:index` | `swipeLeft:2` | Swipe left on a cell at a specific index |
| `wait:seconds` | `wait:1.5` | Wait for a number of seconds |

## Web jump-offs

When an iOS prototype hands off to a hosted web prototype (via `WebView`, `UIApplication.shared.open`, a `.webView(...)` cover, or an `enum X: ..., WebFlowConfig` binding), add `--web-jumpoffs` to crawl the linked web journey and splice it into the map. The crawler's screenshots match what the user sees inside the production WKWebView (chrome-stripped via the same CSS the production app injects, viewport-clipped to native portrait dimensions), and a per-page disk cache means a second run against your Android prototype reuses anything this run already captured.

See [Web jump-offs](web-jumpoffs.md) for the full feature reference — detected handoff patterns, config block, allowlist, caching, CLI flags.

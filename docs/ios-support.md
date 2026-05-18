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

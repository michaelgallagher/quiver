# Android / Jetpack Compose support

The tool supports native Android prototypes built with Jetpack Compose + Navigation Compose. It auto-detects Android projects (by looking for `build.gradle.kts` or `settings.gradle.kts` files with an `com.android.application` module) or you can force it with `--platform android`.

```bash
npx quiver /path/to/android-prototype --platform android
```

## How it works

1. Scans for all `.kt` files in the project
2. Parses each file for Jetpack Compose navigation patterns
3. Extracts seed IDs from ViewModel source so parameterized routes can be resolved to real data
4. Builds a directed graph of screens and navigation edges
5. Auto-injects `TestHooks.kt` + a `LaunchedEffect` hook into the app's NavHost file (idempotent, restored afterwards)
6. Generates a temporary `QuiverCapture.kt` instrumented test that navigates to each screen and captures a PNG via `composeTestRule.onRoot().captureToImage()`
7. Builds debug + androidTest APKs, installs them, runs `am instrument` directly on the device, `adb pull`s the PNGs, then uninstalls
8. Generates a static HTML viewer with the graph and screenshots embedded

See [how-it-works.md](how-it-works.md) for the full pipeline.

## Recording a real session (`--record`)

> **Status: experimental — first working version on the `native-recorder` branch.** Builds an end-to-end map, with known rough edges (see below and [`plans/native-recorder.md`](plans/native-recorder.md)).

The static path above maps *what the parser can reach with fabricated seed data*. The recorder instead maps *what you actually do* — you drive the app on a connected device/emulator and Quiver captures each screen you land on. Same output as the web recorder ([`recording.md`](recording.md)): a flow map viewer plus a replayable `.flow` script.

```bash
npx quiver --record --platform android --module demonhsapp2 --name my-journey /path/to/android-prototype
```

How it differs from the static path:

1. Instead of `TestHooks.kt` + `QuiverCapture.kt`, it injects a single `DisposableEffect` into the NavHost file that registers a `NavController.OnDestinationChangedListener`. On each navigation the listener logs `QUIVER_NAV|<route>|<args>` to logcat (tag `QUIVER`). Idempotent, restored afterwards — same contract as the static injection.
2. It builds **only** `:app:assembleDebug` (no androidTest APK — the app runs for real, not under instrumentation), installs, and launches it.
3. The host streams `adb logcat -s QUIVER:I`. On each nav event it waits for the screen to settle, then captures the device screen via `adb exec-out screencap -p` and records a `Visit` step plus a route→route edge in the order you actually navigated.
4. **Single-phase:** every navigation from launch is captured (no Setup/Map split). Each unique screen is captured once. Press **Enter** in the terminal to finish — the graph, viewer, and `.flow` script are then built, and the injected hook is removed (restore + uninstall run even on Ctrl-C).

### Options & device selection

- `--module <substring>` — for repos with **more than one** application module, selects which one to build/record (matched case-insensitively against the module path, e.g. `demonhsapp2`). Without it, the first module found is used and a warning tells you how to override.
- `--name <slug>` / `--title <title>` — same as the static path; names the map and the `.flow` file.
- **Which device:** the recorder targets the first device in `adb devices`. With both an emulator and a phone attached, set `ANDROID_SERIAL` to choose (e.g. `ANDROID_SERIAL=emulator-5554 npx quiver --record …`).

### Known rough edges

- **Full-device screenshots.** `screencap` grabs the whole screen including the status/navigation bars, where the static path's `captureToImage()` captures the Compose tree only. Cropping is not yet applied.
- **Settle timing.** A fixed delay is used before each capture; very fast navigations or long transition animations may capture mid-transition.
- **Dynamic routes in the `.flow`.** Parameterised routes (e.g. `message_detail/{id}`) are written as `Snapshot` steps for replay robustness, mirroring the web recorder.

## Navigation patterns detected

- `NavHost { composable("route") { ... } }` — registered screens become nodes
- `composable("route", arguments = listOf(navArgument("id") { type = NavType.StringType; defaultValue = ... }))` — parameterized routes, with nav-arg types and defaults preserved
- `navController.navigate("route")` — push edges
- `BottomNavItem(...)` / bottom nav bars — tab edges + lateral edges between sibling tabs
- `composable(..., enterTransition = { slideIntoContainer(Up, ...) })` — modal edges
- `openTab(url)` / external URL helpers — safari (external) edges

## Requirements

- Android SDK installed with `adb` on `PATH`
- A running emulator or attached device (`adb devices` shows one in `device` state). Set `ANDROID_SERIAL` to pick a specific one when multiple are attached.
- The prototype must build via its own `./gradlew` wrapper
- The prototype must use Jetpack Compose + Navigation Compose (`androidx.navigation:navigation-compose`)
- Compose Test already on the `androidTestImplementation` classpath (standard for Compose projects)

## What gets injected (and restored)

On each run the tool touches two files in the prototype's main source tree and one in its `androidTest` tree:

| File | Action | Restore |
|---|---|---|
| `app/src/main/java/<pkg>/navigation/TestHooks.kt` | Created if missing — a `@VisibleForTesting` singleton holding the `NavHostController` | Deleted if created by us; left alone if already present |
| `app/src/main/java/<pkg>/navigation/AppNavigation.kt` (or whichever file hosts the `NavHost`) | One `LaunchedEffect(navController) { TestHooks.navController = navController }` line inserted after `val navController = rememberNavController()` | Original restored |
| `app/src/androidTest/java/<pkg>/QuiverCapture.kt` | Generated fresh each run | Deleted |

Injections are idempotent — if the prototype already has the hooks (e.g. you kept them from a previous run), the tool detects them and leaves them in place. Animation settings (`window_animation_scale`, etc.) are also saved and restored.

## Parameterized routes

Routes like `message_detail/{messageId}` need a concrete value before `navigate()` will render them. The tool resolves each `{placeholder}` in this order:

1. **Config override** — `overrides.<nodeId>.params.<name>` or a fully substituted `overrides.<nodeId>.route`
2. **Declared `defaultValue`** — from the matching `navArgument("name") { defaultValue = ... }` in the `composable(...)` registration (empty-string defaults are ignored because they'd create invalid empty path segments)
3. **Seed ID extracted from the ViewModel** — when the screen's lambda calls something like `vm.getTrustedPerson(id)`, the parser looks for `MutableStateFlow(listOf(TrustedPerson(id = "trusted-1", ...)))` in the ViewModel and uses that ID
4. **Type-aware fallback** — `StringType` → `"1"`, `BoolType` → `"false"`, `Int/LongType` → `"0"`, `FloatType` → `"0.0"`

In practice most routes resolve automatically. Add an override only when you want a specific seed record, or when the auto-resolved fallback hits a dead end.

## Config file (`quiver.config.yml`)

Android overrides are simpler than iOS — no tap steps needed, just a concrete route or param values.

```yaml
overrides:
  # Either provide the full route
  message_detail:
    route: "message_detail/demo-msg-1"

  # Or just the params (the tool does the substitution)
  familyCarer/trusted:
    params:
      id: "trusted-2"

  prescriptionPharmacyDetail:
    params:
      pharmacyId: "pharmacy-1"
```

The iOS `steps: [...]` form is ignored on Android; Android's `route` / `params` are ignored on iOS. One config file covers both platforms if a prototype has both.

## Web jump-offs

When an Android prototype hands off to a hosted web prototype (via `openTab`, `InAppBrowser`, `CustomTabsIntent.Builder`, or a `WebFlowConfig(url = ...)` binding), add `--web-jumpoffs` to crawl the linked web journey and splice it into the map. The crawler's screenshots match what the user sees inside the production native InAppBrowser (chrome-stripped, viewport-clipped to native portrait dimensions), and a per-page disk cache means a second run against your iOS prototype reuses anything this run already captured.

See [Web jump-offs](web-jumpoffs.md) for the full feature reference — detected handoff patterns, config block, allowlist, caching, CLI flags.

## Limitations

- **WebView screens**: Compose `onRoot().captureToImage()` captures the Compose tree only. Screens that embed an `AndroidView { WebView(...) }` may show a blank region where the WebView renders. Future work could fall back to UiAutomator for those specific nodes. (For externally-hosted web prototypes linked from the native app, use `--web-jumpoffs` — see above.)
- **Onboarding**: the generated test uses `@BeforeClass` to set the `onboarding/completed` shared-pref to `true` before the activity launches. If your prototype uses a different shared-pref name/key for its onboarding gate, you'll need to adjust — currently this is hardcoded.
- **NavHost anchor**: auto-injection looks for `val navController = rememberNavController()` to place its hook. If the prototype names the controller differently, the tool prints a clear error and leaves the file alone.

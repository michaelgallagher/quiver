# Native session recorder

> **Status: active workstream** (see [`roadmap.md`](roadmap.md)). Brings the web recorder's "watch a real session" approach to the native (iOS/Android) pipeline, so native maps can be built from a real human click-through instead of static parsing + programmatic navigation.

## Current status (`native-recorder` branch)

**Step 1 (Android in-app recorder) — landed, experimental.** It runs end to end: build → inject nav hook → install → launch → observe → capture → graph + viewer + `.flow`. Proven against `native-nhsapp-android-prototype` (the `DemoNHSApp2` module).

What's implemented (`src/android-recorder.js`, `src/kotlin-crawler.js`, `bin/cli.js`):

- **Host-side recorder.** Single-phase — every navigation from launch is captured; press Enter to finish. Injects a `DisposableEffect` + `NavController.OnDestinationChangedListener` that logs `QUIVER_NAV|<route>|<args>` to logcat (tag `QUIVER`); host streams `adb logcat -s QUIVER:I`, captures via `adb exec-out screencap -p`, dedups by canonical route, builds the graph via the shared `assignSubgraphLayout`, then the standard viewer/Mermaid/meta/index. Writes a `.flow` to `scenarios/` (dynamic routes → `Snapshot`). Injected file restored in a `finally` (survives Ctrl-C).
- **Helpers exported** from `src/kotlin-crawler.js` (`findAppModule`, `findDevice`, `adb`, `adbShell`, `findNavHostFile`, …) for reuse; `findAppModule` gained a `moduleHint` arg so multi-app repos can target a module.
- **CLI:** `--record` detects/accepts `--platform android`; new `--module <substring>` flag (multi-app repos); iOS `--record` returns a clear "not implemented yet".

**Fixed after first real runs (2026-06-21):**

- Recorder used to **uninstall** the prototype on finish → it now leaves the user's app installed (their device, their app). The `finally` no longer calls `adb uninstall`.
- **Play Protect "send this app for a security check"** prompt on each adb install → recorder temporarily sets `verifier_verify_adb_installs 0` and restores it on exit (save/restore like animations).
- Install now uses `-g` (grant runtime permissions) — this did **not** fix the first-screen prompt (see below) but is correct hygiene against permission dialogs.
- Added a **Space** key for on-demand manual capture (web-recorder-style `Snapshot`).

**WebView page-load hook — landed (2026-06-21).** Bug 2 below is fixed. The injector now also instruments every `WebViewClient.onPageFinished` in the app's source to emit `QUIVER_WEB|<url>|<webViewId>` per page load; the host captures each in-app web page as its own node with the **real URL as identity**, chaining off the previously-observed screen so an N-screen web journey maps as a vertical chain `launch → page1 → page2 → …`. Revisits dedup by URL (fragment + trailing slash dropped, query kept). The **Space** fallback now also chains consecutive snapshots instead of fanning out. Chrome Custom Tabs remain out of scope (Space-only). Implemented in `src/android-recorder.js` (`injectWebViewHooks`/`injectWebViewLog`, `onWeb`/`parseWebLine`/`normalizeWebUrl`/`webUrlToLabel`).

**Multi-web-view anchoring — fixed (2026-06-21).** A web view dismisses back to its native screen *without* a NavController event, so `lastRoute` would stay on the last web page; opening a second web view from the same screen wrongly chained it off the first. The `onPageFinished` hook now also emits the WebView's `System.identityHashCode` as `<webViewId>`; the host tracks `lastNativeRoute` + `currentWebSession` and anchors each *new* web-view session (and any native navigation after a dismissed web view) to the native screen it opened from, while pages within one session still chain. **Unverified on-device** — the user re-runs.

### Agreed plan — still to build (2026-06-21)

1. **Bug — "Android app compatibility" warning captured on the first screen.** On a Samsung device (One UI), launching the debug build shows a one-time compatibility/"app is being tested" warning that has no reliable cross-device adb suppression. **Fix: a one-keypress "ready?" gate.** After `am start`, the recorder waits and prompts the user to dismiss any OS dialog and reach their starting screen, then press Enter; it then captures the *current* screen as the start node and begins auto-capturing navigations. This is **not** a return to the web recorder's Setup/Map split — just a "begin" gate. Device-agnostic; sidesteps identifying the dialog. (Pre-gate nav events are buffered so the start node still gets its real route label.)

2. ~~**Bug — web-view screens must map like native screens (linear chain), not fan out.**~~ **Done** — see "WebView page-load hook — landed" above. Kept for context: the fix injects a page-load hook so a linear N-screen web-view journey maps as a vertical chain with the real URL as node identity; **Chrome Custom Tabs stay out of scope** (Space-only).

**Known bugs / still open:**

- **First-screen compatibility warning** — until the "ready?" gate lands, the first captured screen may show the Samsung warning.
- Full-device screenshots (`screencap` includes status/nav bars) vs the static path's Compose-only `captureToImage()` — no cropping yet.
- Fixed settle delay before capture; fast navigations / long transitions can capture mid-animation.
- `--module` is recorder-only; the static path still picks the first module. Consider promoting `--module` pipeline-wide.
- **All on-device fixes are unverified** — they pass syntax/load checks but haven't been re-run on the device (the user runs the recorder; see [`../android-support.md`](../android-support.md#recording-a-real-session---record)).

**Not started:** Step 2 (iOS recorder), Step 3 (no-injection fallback).

## Why

Quiver has two ways to build a map today, and the native path only has the harder one:

- **Web** has both a **scenario/static** path *and* a **recorder** (`--record`, `src/recorder.js`, [`../recording.md`](../recording.md)). The recorder opens the prototype in a real browser, watches you click through it, and builds the map from exactly what you visited — capturing screenshots and links live. It also saves a `.flow` script as a replayable secondary output.
- **Native (iOS/Android)** only has the **static-parse + programmatic-capture** path ([`../ios-support.md`](../ios-support.md), [`../android-support.md`](../android-support.md)): parse the source for navigation patterns, then drive a Simulator/emulator to each detected screen and screenshot it.

The native path carries a cost the recorder doesn't: **the seed-data problem.** To render a parameterised screen programmatically, the tool has to manufacture data it never observed —

- Android resolves `message_detail/{messageId}` by *extracting seed IDs from ViewModel source*, falling back to type-defaults (`StringType → "1"`).
- iOS needs hand-written `overrides.<view>.steps` (`tap:Appointments`, `tapContaining:Appointment on`) and synthesised values (`Binding<T> → .constant(...)`) to reach data-dependent screens.

That machinery is clever but lossy: it maps *what the parser can reach with fabricated data*, not *what a real user experiences with real state*. Screens behind a flow the parser can't synthesise either go screenshot-less or need manual config. This is precisely the gap the web recorder closes for web — and the reason to build a native equivalent.

**A native recorder produces realistic maps that match the real experience, with real state, and no seed-data synthesis** — because the human drives the session and Quiver just observes.

## What it produces

The same artifacts as the web recorder, so it plugs into everything downstream unchanged:

1. **A flow map + viewer** — identical output to the static native path (Dagre layout, embedded screenshots, `graph-data.json` + `runtime.json` sidecars). The viewer, layout, node-hiding, and server persistence are all platform-agnostic already.
2. **A `.flow` script** — the recorded session as replayable steps, saved to `scenarios/`, editable by hand. Reuse the existing `.flow` grammar (`Visit`, `Snapshot`, `ClickButton "…"`, etc.) so native recordings replay through the same runner concepts and can be combined into sets.

Keeping the `.flow`/graph contract means the recorder is a new **capture front-end**, not a new pipeline.

## Architecture

The recommended design splits **device** (emits navigation events) from **host** (captures screenshots + assembles the map), reusing capture tooling Quiver already drives:

```
human drives app  ──►  in-app hook fires on each screen change
                            │  emits {route/label, timestamp} over
                            │  logcat (Android) / oslog (iOS) / local socket
                            ▼
host watches the event stream  ──►  on each event:
   • adb exec-out screencap  /  simctl io screenshot   (existing tooling)
   • append a Visit/Snapshot step to the .flow script
                            ▼
            build graph + viewer (existing generateNative path)
```

Two things make this cheap:

- **The injection already exists.** The Android pipeline already injects `TestHooks.kt` + a `LaunchedEffect(navController) { TestHooks.navController = navController }` into the prototype's NavHost (idempotent, restored afterwards). The iOS pipeline already injects via `src/swift-injector.js` + `simctl` launch args. The recorder extends these injectors to *also* register an observer that emits an event on each navigation — it does not invent a new injection mechanism.
- **The screenshot path already exists.** Host-side capture via `adb`/`simctl` is already how native screenshots are taken. The recorder just triggers a capture on an *observed* event instead of after a *programmatic* navigation.

Net new surface is small: an event observer in each injector, a host-side event listener, and a `.flow` writer (the web recorder's writer is a near-template).

## Capture backends (ranked)

### 1. In-app navigation hook — recommended (extends existing injection)

- **Android:** register a `NavController.OnDestinationChangedListener` on the controller the tool already captures in `TestHooks`. Each change → emit `{route, args}`. This is a few lines on top of injection that already ships. **Lowest effort of anything here.**
- **iOS:** add a screen-appearance observer to the injected code — observe `NavigationStack` path changes, or swizzle `UIViewController.viewDidAppear` (SwiftUI screens are hosted in `UIHostingController`s, so pushes/sheets fire it). Emit `{label}` per appearance. Labels are rougher than Android routes (class-name-ish); an optional `.quiverScreen("Name")` modifier gives clean names where the prototype opts in.
- **Why preferred:** highest-fidelity identity and labels, real state, runs on Simulator/emulator (or a real device), and reuses both existing injectors and the existing screenshot path. **No third-party software.**

### 2. Accessibility tree (no injection)

- **Android:** an `AccessibilityService` can read any app's UI tree (`getRootInActiveWindow`) and fires on `WINDOW_STATE_CHANGED` — nodes + edges + tapped element with **zero changes to the prototype**. Good for prototypes we can't (or don't want to) inject into.
- **iOS:** no equivalent on-device cross-app observer — falls through to backend 3 or 4.

### 3. External automation driver (no injection, both platforms)

Run the session under Appium/XCUITest/UiAutomator/Maestro and dump page-source + screenshot on each tap. Zero prototype change, both platforms, but needs a driver session (tethered/lab) and the driver can interfere with touch feel. Introduces a **third-party dependency** (Appium/Maestro, open-source) unless written directly against XCUITest/UiAutomator.

### 4. Screen video + CV (most app-agnostic, fuzziest)

Record the screen (ReplayKit / MediaProjection — OS-level, no app change), then diff frames for transitions and cluster visually-similar frames into nodes. Works on the participant's own device; identity is the fuzziest. CV may pull in open-source libraries but no service unless a cloud vision API is used (which would be an IG concern).

## Per-platform plan

### Android — low effort (reuses the most)

The Android pipeline already injects into the NavHost and already captures via `adb`. The recorder is mostly:

1. Extend the Kotlin injector to add an `OnDestinationChangedListener` that logs `QUIVER_NAV <route> <args>` (tag-filtered) inside a `DisposableEffect`, alongside the existing `TestHooks` hook.
2. Host-side: `adb logcat -s QUIVER` listener; on each line, `adb exec-out screencap -p` and append a `Visit`/`Snapshot` step.
3. Build the graph from the visited routes + observed transitions (route → route edges), then the existing `generateNative` viewer build.
4. Restore the injected files exactly as the static path already does.

### iOS — medium effort

1. Extend `src/swift-injector.js` to add a screen-appearance observer (NavigationStack path or `viewDidAppear` swizzle) that prints `QUIVER_NAV <label>` to oslog.
2. Host-side: `simctl spawn booted log stream --predicate 'eventMessage CONTAINS "QUIVER_NAV"'`; on each event, `simctl io booted screenshot` and append a step.
3. Same graph/viewer build + file restore as the static iOS path.
4. Optional `.quiverScreen("Name")` SwiftUI modifier for clean labels where auto-derived names are poor.

## Third-party dependencies

The recommended path (backend 1) needs **none** — it reuses Quiver's own injectors plus `adb`/`simctl` (already required for native support) and Apple/Google platform APIs. This keeps the recorder fully in-house and on-device, which matters for NHS information governance. Third-party software only appears in the no-injection fallbacks (Appium/Maestro for backend 3; optional open-source CV libs for backend 4), and both are open-source and avoidable.

## Trade-offs & open questions

- **Screen identity.** Android routes are clean node keys (like web URLs); SwiftUI often has no global route, so iOS identity leans on labels/appearance and is fuzzier. Decide whether to key iOS nodes on view type, nav-path, or an a11y/structure fingerprint — and how to dedup revisits (the web recorder captures each unique page once; mirror that rule).
- **Dynamic routes in replay.** The web recorder already rewrites session-specific URLs into `Snapshot` steps for robust replay. Native needs the same treatment for parameterised routes (`message_detail/{id}` captured with a real id → `Snapshot`, not a hard route).
- **Live capture vs test-context capture.** The static Android path screenshots via `composeTestRule.onRoot().captureToImage()` *inside an instrumented test*. The recorder runs a *normal* app session, so capture must be host-side (`adb screencap` / `simctl io screenshot`) — same tools, different trigger. Confirm fidelity (status bar, animations) matches the static path's output.
- **Where does the human interact?** Default to the Simulator/emulator Quiver already boots (consistent with the existing native harness). A real-device variant (and the participant's-own-device variant) connects this to the remote-testing direction.
- **Hand-off to web jump-offs.** A recorded native session that opens a `WebView`/InAppBrowser should still splice in the web jump-off subgraph — confirm the recorder emits the handoff edge the existing `--web-jumpoffs` splice expects.

## Recommended sequence

1. **Android in-app recorder** — ✅ **landed (experimental)**, see [Current status](#current-status-native-recorder-branch). Reuses the existing NavHost injection and `adb` capture; proved the host↔device event-stream + `.flow` writer design end-to-end.
2. **iOS in-app recorder** — *next.* Same design via `swift-injector` + `simctl`, accepting the label-fidelity wrinkle (+ optional `.quiverScreen` modifier).
3. **(Later) a no-injection fallback** — Android `AccessibilityService` or a driver/CV backend, for prototypes that can't be injected, behind the same `SessionEvent → .flow` adapter.

## Files to change (when promoted)

- `src/kotlin-parser.js` / the Android injection step in `src/index.js` (`generateNative`) — add the `OnDestinationChangedListener` emit alongside the existing `TestHooks` injection; ensure restore.
- `src/swift-injector.js` — add the screen-appearance observer + oslog emit.
- `src/recorder.js` — generalise the `.flow` writer and dynamic-route→`Snapshot` rewrite for native sources (or add a sibling `native-recorder.js` that shares the writer).
- `bin/cli.js` — `--record` accepts `--platform ios|android` and routes to the native recorder.
- `src/index.js` — assemble the graph from recorded events and hand off to the existing `generateNative` viewer build.
- `docs/recording.md` / `docs/ios-support.md` / `docs/android-support.md` — document the native `--record` flow.

## Related

- Web recorder reference: [`../recording.md`](../recording.md)
- Existing native pipelines: [`../ios-support.md`](../ios-support.md), [`../android-support.md`](../android-support.md)
- The feasibility analysis that seeded this plan lives outside the repo (research notes on capture mechanisms, per-platform asymmetry, and third-party-dependency posture).

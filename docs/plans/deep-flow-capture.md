# Deep-flow capture (NavigationLink chains inside sheets/covers)

> **Status: planned, not started.** This is "fix B" from the iOS fast-path
> capture-coverage investigation (2026-06-25). The cheaper companion fixes —
> following `destinationView(for:)` delegation so hub screens stop appearing as
> spurious "start" columns, and marking unreachable screens as **NOT CAPTURED**
> in the map — have landed. This doc captures the remaining, larger fix so it can
> be picked up later.

## The issue

In the static `--web-jumpoffs` / launch-args fast path (`src/swift-spike-runner.js`
+ `src/swift-injector.js`), **linear flows that advance via `NavigationLink`-style
pushes inside a plain `NavigationStack` presented by a sheet/cover are only
captured one screen deep.**

Concrete example — the prescription-order flow in `nhsapp-ios-demo-v2`:

```
PrescriptionsView --(fullScreenCover)--> Step2 --> Step3 --> Step4 --> Step5 --> Step6
```

- `Step2` **is** captured (the cover is opened by the injected `.task` that flips
  `showNativePrescriptionOrderFlow = true`).
- `Step3`–`Step6` are **not** captured.
- `Step1` is also not captured (it has no incoming edge — the cover opens directly
  at `Step2`, so `Step1` is effectively unreached/dead in this prototype).

After the companion fix, these screens are now flagged `captureStatus:
"unreachable"` and render as **NOT CAPTURED** placeholders rather than mysterious
blanks — but they still aren't screenshotted.

## Why it happens

The launch-args navigation strategy can only drive two things:

1. **Path-based** stacks — `NavigationStack(path: $navigationPath)` — by appending
   typed/`String` segments to the bound path (the injected `.task` route
   dispatcher + `.navigationDestination(for: String.self)` + `quiverSubDestination`
   helper).
2. **Sheet/cover `@State` triggers** — flip a `Bool`/`item` to present a modal
   (the injected sheet-trigger `.task`).

The prescription cover's content is a **plain** `NavigationStack { Step2View(...) }`
(no `path:`), and each step advances with:

```swift
NHSNavigationButton(title: "Continue") {
    PrescriptionOrderStep3View(flowData: flowData, isPresented: $isPresented)
}
```

i.e. a `NavigationLink`-style push. There is **no bound path to append to**, and
the launch-args path cannot programmatically activate a `NavigationLink`. So:

- The route plan (`buildRoutePlan`) produces exactly one route for this flow —
  `prescriptions/PrescriptionOrderStep2View` — and `subNavigationHosts` is empty
  (sub-host handling currently requires `NavigationStack(path:)`, which the cover
  doesn't use). Verified 2026-06-25.
- Steps 3–6 get no routes → no captures.

This is an architectural limit of the static fast path, not a one-line bug.

## Proposed fix (B): inject a path-based driver for these flows

Extend the existing **sub-navigation-host** machinery (`injectIntoSubNavigationHost`,
`generateSubHostHelperFunction`, etc.) to also handle a sheet/cover whose content
is a plain `NavigationStack` containing a `NavigationLink` chain. Sketch:

1. **Detect** the pattern during injection: a `.sheet`/`.fullScreenCover` whose
   closure contains `NavigationStack { … }` (no `path:`) and whose descendants are
   reached by `NavigationLink`/`NHSNavigationButton { DestView(...) }` pushes.
   These descendants are already edges in the graph (`type: "link"`), so the chain
   is known — walk it from the cover's root step.
2. **Convert** the plain `NavigationStack { Root }` into a path-driven one:
   inject `@State private var quiverPath = NavigationPath()` (or reuse a synthesized
   binding), rewrite `NavigationStack { Root }` → `NavigationStack(path: $quiverPath) { Root }`,
   and add `.navigationDestination(for: String.self) { quiverSubNavDestination($0) }`
   plus a generated `quiverSubNavDestination` helper that maps each step name →
   `StepNView(...)`.
3. **Synthesize step constructors.** Each step needs its params, e.g.
   `PrescriptionOrderStep3View(flowData: PrescriptionFlowData(), isPresented: .constant(true))`.
   The injector already has `synthesizeSwiftValue` and binding synthesis used for
   `item:`-bound sheets and required-param views — reuse it. `isPresented`-style
   `@Binding var` params resolve to `.constant(true)`; `flowData`-style value params
   resolve via `synthesizeSwiftValue`.
4. **Emit compound routes** `prescriptions/PrescriptionOrderStep2View/PrescriptionOrderStep3View/…`
   so the runner launches once per depth, appending the chain to `quiverPath`.

Most of this is "make plain-NavigationStack covers look like the sub-hosts we
already support." The driver, helper generation, and compound-route emission all
have direct analogues in the current sub-host path.

## Risks / open questions

- **Injection surface.** Every iOS bug in the 2026-06-25 session was an injection
  landing in the wrong scope or producing invalid Swift. Rewriting a
  `NavigationStack { … }` in place and adding a synthesized path var is more
  invasive than the current additive injections — higher chance of build breaks.
  Must be gated behind robust detection and fall back cleanly (capture Step2 only)
  when unsure.
- **Param synthesis fidelity.** Steps that read real `flowData` may render
  differently under a synthesized value (empty/default data). Acceptable for a map
  thumbnail, but worth noting the screenshots may not match a real session.
- **Binding identity.** Replacing `$isPresented` with `.constant(true)` inside the
  driver means "dismiss"/"back" buttons won't function — fine for one-shot capture,
  but the chain must be driven by path, not by the buttons.
- **Generality.** `NHSNavigationButton { … }` is a prototype-specific wrapper. The
  detection should key off the graph's `link` edges (already abstracted) rather
  than the component name, so it generalizes beyond this prototype.
- **Cycles / branches.** The plan assumes a mostly linear chain. Branching flows
  (a step with multiple `NavigationLink`s) need the same per-target compound-route
  expansion the main host BFS already does.

## Alternatives considered

- **XCUITest tap-driven fallback** for these flows — actually taps "Continue".
  Most faithful, but ~18× slower per the original fast-path rationale and abandons
  the launch-args approach. Rejected for the fast path; could be an opt-in
  `--deep-capture` mode later.
- **Do nothing beyond marking.** Already shipped (companion fix A). Keeps the map
  honest but leaves the screens blank.

## Acceptance criteria

- For `nhsapp-ios-demo-v2`, the prescription-order flow captures `Step2`–`Step6`
  (Step1 stays unreached/dead, which is correct for this prototype).
- No regression in build success or in flows already captured.
- Detection fails safe: prototypes without this pattern are untouched; covers where
  synthesis is uncertain fall back to capturing the root step only.

## Pointers

- `src/swift-injector.js` — `injectIntoSubNavigationHost`, `insertStringHandlerIntoSubNavigationStack`,
  `generateSubHostTaskCode`, `generateSubHostHelperFunction`, `insertHelperIntoNamedStruct`,
  `synthesizeSwiftValue`; `buildRoutePlan` (`subNavigationHosts`, `sheetRoutes`).
- `src/swift-spike-runner.js` — capture loop + `captureStatus` marking (companion fix A).
- Evidence: `PrescriptionOrderStep2View.swift` (`NHSNavigationButton { Step3View(...) }`),
  `PrescriptionsView.swift` (`.fullScreenCover { NavigationStack { Step2View } }`).

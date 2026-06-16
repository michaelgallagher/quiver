# Future ideas

> Items not yet promoted to active workstreams. Each entry has enough context to be picked up when its time comes — but they're explicitly NOT scheduled. The active list is in [`roadmap.md`](roadmap.md).
>
> Items here may eventually:
> - Get promoted to a roadmap workstream (when the user signals it's time)
> - Get formally deprecated (move to `archive/` with a "rejected" status)
> - Stay here indefinitely as parking-lot ideas

---

## Native session recorder

Bring the web recorder's "watch a real session" approach to the native (iOS/Android) pipeline. Today native maps come only from static parsing + programmatic capture, which carries the **seed-data problem** (Android extracts seed IDs from ViewModels; iOS needs hand-written `overrides.<view>.steps`) — so they map what the parser can reach with fabricated data, not what a real user experiences with real state. A native recorder closes that gap the same way the web recorder does for web.

Full plan — architecture (in-app nav hook emitting events over logcat/oslog, screenshots via the existing `adb`/`simctl` path, output as `.flow` + the standard viewer), capture-backend ranking, per-platform effort (Android low / iOS medium), third-party-dependency posture (none for the recommended path), and the recommended sequence — is in [`native-recorder.md`](native-recorder.md).

**Why deferred:** the static native path works for current needs; the recorder is an accuracy/realism upgrade, not a blocker. Strong candidate to promote once native map fidelity (real-state journeys, screens behind un-synthesisable flows) becomes the priority — and it dovetails with remote-testing directions.

---

## Server collaboration features (Phases 2–5)

Originally documented in [`archive/webapp-collaboration.md`](archive/webapp-collaboration.md). Phase 1 (server + positions) is delivered; what's below is what remains.

### Comments and annotations (Phase 2)

Allow users to leave notes on maps and individual nodes for review/discussion.

**API endpoints:**
- `GET /api/maps/:name/comments` — list all comments for a map
- `POST /api/maps/:name/comments` — add a comment, optionally with `nodeId` to attach to a specific node
- `PATCH /api/maps/:name/comments/:id` — edit/resolve
- `DELETE /api/maps/:name/comments/:id`

**Data model:** `{ id, nodeId?, text, author, createdAt, resolved }` stored in `comments.json`.

**Viewer UI:**
- Comment icon/badge on nodes that have comments
- Comment thread in the node detail panel
- General "page comments" panel for non-node-specific notes
- Simple "What's your name?" prompt on first comment, stored in localStorage

**Why deferred:** the user hasn't asked for it yet, and the use case (collaborative review of generated maps) is downstream of more pressing items.

### Lightweight identity + SQLite (Phase 3)

Currently positions and (future) comments are stored as JSON files. As the data grows, JSON-on-disk becomes harder to manage (concurrent writes can corrupt; growing files slow page loads).

**Approach:**
- Switch from JSON files to SQLite (single `.sqlite` per output dir)
- Simple identity: "What's your name?" prompt on first visit, stored as a cookie (no passwords, no OAuth)
- Change attribution: positions and comments record who and when
- Optional "last edited by X, 2 hours ago" indicators

**Why deferred:** SQLite adds a native dependency (`better-sqlite3`) and migration complexity. Worth it once we have ≥2 collaborative features sharing the data layer.

### Real-time sync (Phase 4)

WebSocket layer (Socket.IO or plain `ws`) alongside Express:
- Drag a node → moves for everyone in real time
- Comments appear immediately for everyone
- Presence indicators (who's currently viewing the map)
- Last-write-wins conflict resolution for positions; comments are append-only

**Why deferred:** large effort, only worth it once Phases 2–3 have generated enough collaborative usage to justify it.

### Web-triggered generation (Phase 5)

Allow non-developers to generate maps without running the CLI locally:
- UI to point at a Git repo URL or upload a prototype zip
- Background job runner (worker process)
- WebSocket-based progress updates
- Optional scheduled regeneration on Git push via webhook

**Why deferred:** large effort. Currently the CLI-locally workflow is fine for the developer audience. Revisit if non-developer audiences become a real ask.

---

## Layout polish

### Node overlap in long linear chains

Dagre does not account for node size when positioning nodes — it treats each node as a point and then assigns rank/order coordinates. When nodes have non-trivial width and height (especially screenshot thumbnails), adjacent nodes in the same rank or tight vertical chains can overlap in the rendered SVG.

This became visible after the `RemoveTrustedPerson*` chain was added: a five-node linear sequence all parented under `ProfileSwitcherView` lands in a narrow column with nodes overlapping.

**Root cause:** Dagre's `ranksep` and `nodesep` options are set to fixed pixel values that assume small/labelOnly nodes. They don't scale with screenshot thumbnail size.

**Options (pick one or combine):**

**Option A: Increase `ranksep`/`nodesep` globally** — simplest fix; raise the constants in the dagre config in `src/build-viewer.js`. Downside: makes all maps more spread out, including ones that don't have the problem.

**Option B: Node-size-aware sep** — pass actual node width/height to dagre via `node.width` and `node.height` on each graph node before calling `dagre.layout()`. Dagre uses these to compute minimum separation. Requires knowing the rendered size at layout time (or using a fixed thumbnail size constant).

**Option C: Post-layout overlap removal pass** — after dagre assigns coordinates, run a sweep that detects overlapping bounding boxes and nudges positions apart. Platform-agnostic; doesn't require changes to the dagre call.

**Recommended starting point:** Option B — the thumbnail size is a known constant (set in CSS), so we can pass fixed `width`/`height` to dagre without measuring the DOM. This is the most principled fix and directly solves the root cause.

**Files to change** when promoted:
- `src/build-viewer.js` — set `node.width` and `node.height` on each dagre graph node before calling `dagre.layout()`; also tune `ranksep`/`nodesep` as needed.

**Why deferred:** the overlap is a visual annoyance but doesn't break usability — nodes can be dragged apart. The fix is straightforward once prioritised.

### Virtual subgraph-owner inference for web static maps

`src/infer-subgraph-owners.js` is shipped and wired into `generateNative` (iOS + Android). It is intentionally **not** wired into `generate` (web static mode) yet.

**Why not web static:** Testing on the breast screening prototype in `--mode static` showed the heuristic produces ~80 orphan columns because form-gated pages are unreachable from static link analysis (no BFS crawl). The virtual owners themselves are correct, but the orphan explosion makes the map unusable. The guard needs a coverage threshold — e.g. "virtual owners' subtrees must cover ≥50% of all nodes" — before enabling for web.

**What to do when promoted:**
1. Add coverage guard to `inferVirtualSubgraphOwners`: compute `coveredCount = sum(1 + descendantCount(c) for c in candidates)`; skip if `coveredCount / graph.nodes.length < 0.5`.
2. Add call in the `generate` function in `src/index.js` (same placement as `generateNative`).
3. Verify on breast screening `--mode static`: either fires correctly or still skips cleanly.
4. Verify on a simpler web prototype with a clear hub structure.

### Reingold-Tilford / proper subtree-width-aware tree layout

If Part A and (eventually) the virtual subgraph-owner pass aren't enough, the next step is a proper Reingold-Tilford-style layout that sizes each subtree's horizontal slot based on its descendants.

**Why deferred:** Dagre + virtual owners should be sufficient for typical NHS prototype sizes. Only worth pursuing if we hit cases where they aren't.

### iOS tab-pattern detection

Some iOS apps DO use tabs (`TabView`, custom tab containers, etc.). Detecting these natively would replace virtual subgraph inference for those apps and produce a more accurate map.

**Why deferred:** virtual subgraph inference covers the same ground for the no-tabs case, which is the immediate need. iOS-specific tab detection is purely an accuracy improvement.

### Hierarchical clustering for very large graphs

For graphs over ~200 nodes (rare today), the current layout becomes unwieldy. A clustering pass would group related nodes and show clusters at low zoom levels, expanding on zoom-in.

**Why deferred:** no current prototype hits this scale. Revisit if/when one does.

---

## iOS screenshot coverage

### Parallel Simulator instances

Run two Simulators in parallel, each capturing half the screens.

**Why deferred:** each Simulator boot is heavy and disk-intensive. Unclear it's actually faster — needs investigation. Probably not worth it unless the per-screenshot wall-clock cost dominates.

### Physical-device screenshot capture

Tests on a connected iPhone via USB. Faster than Simulator boot, but adds device-management overhead and doesn't scale to CI.

**Why deferred:** narrow use case (developers with a connected device, not running CI).

---

## Web crawler depth

### Form-gated journey crawl

Web jump-off BFS only follows `<a href>`. Pages reached via `<form method="post">` submission ("Start now" buttons that POST) aren't reached, so prototypes that gate progression behind form submits show only the entry page.

**Approach:** layer a scenario-style driver on top of the crawler. Detect known form patterns (e.g. NHS Prototype Kit's "Start now" button) and synthesize a scenario step that submits the form before continuing BFS.

**Why deferred:** no current smoke target is form-gated. Revisit when one is.

### Authenticated page crawl

Each web jump-off crawl creates a fresh browser context with no cookies. Pages behind a login form are unreachable.

**Approach:** allow the user to specify a setup scenario (`scenarios/web-jumpoff-setup.flow`) that runs once per origin to log in. Subsequent BFS uses the authenticated context.

**Why deferred:** hosted NHS prototypes are typically auth-free. Revisit if we encounter auth-gated content worth crawling.

### JS-only navigation extraction

Links that exist only as JavaScript click handlers (no `<a href>`) aren't extracted. Could be addressed by injecting a click-trap that records `event.target` for synthetic navigation.

**Why deferred:** vanishingly rare in NHS prototype kit content; not worth the implementation cost yet.

---

## Tooling and DX

### Mural export (resurrect or formally drop)

The `mural-export` branch contains a `src/export-mural.js` (302 lines) implementing a Mural board export, with the commit message "doesn't actually work yet". Either:
- **Resurrect**: finish the implementation, support exporting a flow map to a Mural board for collaborative annotation
- **Formally drop**: delete the branch with a note that Mural export was explored and abandoned

**Why deferred:** unclear whether Mural is actually a valuable export target compared to direct collaborative features in our own viewer (covered by server Phases 2–4). Decision needed before further investment.

### Automated tests

The test infrastructure exists (`package.json` has `"test": "node --test src/**/*.test.js"`) but coverage is sparse. Priorities for testing:

- **`.flow` parser** (`src/flow-parser.js`) — well-defined input/output, easy unit test target
- **Config validation** (`src/flow-map-config.js`) — many edge cases, currently only manually verified
- **Scenario runner** (`src/scenario-runner.js`) — needs Playwright fixtures, harder but high value
- **Web jump-off cache** (`src/web-jumpoff-cache.js`) — pure function, easy target

Plus error-recovery tests: what happens when an interactive step fails mid-scenario? The current behavior is "fail the scenario"; we may want "skip to next scenario" with a clear failure indicator.

**Why deferred:** active feature work has been the priority; tests will be added once the surface area stabilises.

### CLI improvements

- **Auto-detection improvements.** Currently auto-detects iOS/Android by file presence. Could be more aggressive (read `package.json` to detect web prototype kit, etc.).
- **`quiver init`.** Generate a starter `quiver.config.yml` based on auto-detection.
- **`quiver list`.** Show all generated maps in the output dir with metadata (generated date, run duration, node count).

**Why deferred:** quality-of-life only, no active blockers.

---

## iOS: orphaned nodes — hide or explain

The iOS parser creates graph nodes for every Swift struct that conforms to `View`,
including views that are never reachable via declarative navigation (no
`NavigationLink`, `RowLink`, `.sheet`, or `.fullScreenCover` pointing to them).
These appear in the graph as disconnected nodes — or as nodes with outgoing edges
but no incoming edges — and always have `screenshot: null` because the launch-args
pipeline can't navigate to them.

**Known examples in `nhsapp-ios-demo-v2`:**
- `PrescriptionOrderStep1View` through `Step6View` — View structs that exist in
  the project but are not referenced from any main-app navigation. Likely dead code
  from a native flow that was replaced by the Heroku-hosted web flow
  (`PrescriptionFlow` enum). Only the old XCUITest file references them.
- `NoAppointmentsView` — rendered inline and conditionally (`if appointments.isEmpty`),
  not a navigation destination. The parser detects it as a View struct and creates a
  node, but there's no navigation edge pointing to it.

**Two options — pick one:**

**Option A: Filter orphaned nodes from the graph** — in `swift-graph-builder.js`,
after building the graph, remove any node with no incoming edges that is also not a
known entry point (tab root, NavigationStack host). This keeps the viewer clean but
loses information about views that exist but aren't reachable.

**Option B: Add a viewer note** — in the viewer, show a visual indicator (e.g. grey
border, "orphaned" badge) on nodes with `screenshot: null` and no incoming edges,
with a tooltip explaining why. Add a section to `docs/ios-support.md` explaining
the limitation.

**Recommended starting point:** Option A (filter by default), with an `--include-orphans`
flag to opt back in for audit purposes. The viewer showing a screenless dead-end node
misleads the reader into thinking it's a reachable screen.

**Why deferred:** not blocking — the tool is usable without this fix. Address once the
screenshot pipeline is otherwise complete.

---

## Open design questions

These don't have clear answers yet — leaving them parked for now:

- **Visit-driven vs BFS auto-detection.** Should the tool auto-detect when scenario steps form a complete journey (visit-driven) versus when BFS expansion is needed? Currently explicit in config.
- **More than two scenarios in merged maps.** Combined views currently support 2-up; should they support arbitrary scenario counts in a grid?
- **Cross-prototype stitching.** When a `WebView` URL in the iOS app matches a web prototype page we've also generated a map for, should we stitch them together at viewer load time? (Different from web jump-offs, which crawl hosted prototypes — this would link iOS+web prototypes the user owns.)
- **Per-edge "via" provenance.** "This page was reachable via the bottom nav, which is why we hid it." Possible v2 of hidden-link filtering. Useful for debugging but adds UI complexity.
- **Shared "anchor" nodes across scenarios beyond automatic dedup.** Allow scenarios to declare `Anchor /dashboard` so all scenarios pin the dashboard at the same coordinates.

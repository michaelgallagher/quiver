/**
 * Generates a Swift XCUITest file that navigates to every screen in the
 * parsed graph and writes a PNG screenshot directly to a temp directory.
 *
 * Strategy:
 *  - BFS from the root node(s) using only "link" and "tab" edges.
 *  - For each reachable screen, produce a test method that launches the app
 *    fresh, taps through the path, then writes a screenshot to disk.
 *  - Tab taps use XCUIApplication.tabBars; all other taps use a helper
 *    that tries both the edge label and the destination node's display label,
 *    since HubRowLink accessibility labels come from hubType.title which may
 *    differ from the enum case name stored on the edge.
 */

const { toLabel } = require("./swift-parser");

const NAVIGABLE_EDGE_TYPES = new Set(["link", "tab"]);
const MODAL_EDGE_TYPES = new Set(["sheet", "full-screen"]);

/**
 * Sanitize a node ID for use as a filesystem filename / Swift identifier.
 * Replaces all non-alphanumeric characters with `_` and truncates to 200 chars.
 */
function sanitizeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 200);
}

/**
 * Extract the first significant keyword from a PascalCase view name.
 * "AppointmentDetailView" → "Appointment"
 * "PrescriptionOrderStep1View" → "Prescription"
 * Skips generic suffixes like View, Page, Screen, Detail, etc.
 */
function extractKeyword(viewName) {
  const words = viewName
    .replace(/(?:View|Page|Screen|Controller)$/, "")
    .split(/(?=[A-Z])/)
    .filter(Boolean);
  const generic = new Set(["Detail", "Order", "Step", "Start", "List", "Item", "Modal"]);
  for (const word of words) {
    if (!generic.has(word) && word.length > 2) return word;
  }
  return words[0] || null;
}

/**
 * Generate the full Swift test file content.
 *
 * @param {object} graph - { nodes, edges }
 * @param {string} screenshotsDir - absolute path on the Mac host where PNGs are written
 * @param {object} overrides - map of viewName → { steps: string[] } from config
 * @returns {string} Swift source code
 */
function generateXCUITest(graph, screenshotsDir, overrides = {}) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Find root nodes: screen nodes that are true navigation roots (like MainTabView).
  // A true root has no incoming edges of any type AND has outgoing navigable edges.
  // Screens reachable only via modal edges (sheet/full-screen) are NOT roots —
  // they are handled by collectModalScreens() which navigates to the parent first.
  const hasIncoming = new Set(
    graph.edges
      .filter((e) => NAVIGABLE_EDGE_TYPES.has(e.type))
      .map((e) => e.target),
  );
  const hasModalIncoming = new Set(
    graph.edges
      .filter((e) => MODAL_EDGE_TYPES.has(e.type))
      .map((e) => e.target),
  );
  const rootIds = graph.nodes
    .filter((n) => {
      if (n.type !== "screen") return false;
      if (hasIncoming.has(n.id)) return false; // has navigable incoming — not a root
      if (hasModalIncoming.has(n.id)) return false; // reachable via modal — handled by collectModalScreens
      // No incoming navigable or modal edges. True root if it has outgoing navigable edges.
      const outgoing = graph.edges.filter((e) => e.source === n.id && NAVIGABLE_EDGE_TYPES.has(e.type));
      return outgoing.length > 0;
    })
    .map((n) => n.id);

  if (rootIds.length === 0) return null;

  // The default tab target is the first tab child of the root (usually "Home").
  // When the app launches it starts on this view, so we can skip tapping it.
  let defaultTabTarget = null;
  for (const e of graph.edges) {
    if (rootIds.includes(e.source) && e.type === "tab") {
      defaultTabTarget = e.target;
      break;
    }
  }

  // BFS to compute edge-paths from roots to every reachable node
  const edgePaths = bfsEdgePaths(graph, rootIds);

  // Pre-compute tab index for each tab target (order in TabView = accessibility index)
  const tabIndexMap = new Map();
  let tabIdx = 0;
  for (const edge of graph.edges) {
    if (edge.type === "tab") tabIndexMap.set(edge.target, tabIdx++);
  }

  // Track which screens have config overrides — they get custom test methods
  const overrideNodeIds = new Set(Object.keys(overrides));

  // Generate one test method per reachable screen node (skip overrides)
  const methods = [];
  for (const [nodeId, edgePath] of edgePaths) {
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== "screen") continue;
    if (overrideNodeIds.has(nodeId)) continue; // handled below

    const taps = buildTaps(edgePath, nodeMap, defaultTabTarget, tabIndexMap);
    methods.push(generateMethod(nodeId, taps, screenshotsDir));
  }

  // Generate modal test methods for sheet/fullScreenCover/web-view screens (skip overrides)
  const modalScreens = collectModalScreens(graph, edgePaths);
  for (const [nodeId, { parentEdgePath, triggerEdge }] of modalScreens) {
    if (overrideNodeIds.has(nodeId)) continue; // handled below
    const parentTaps = buildTaps(parentEdgePath, nodeMap, defaultTabTarget, tabIndexMap);
    methods.push(generateModalMethod(nodeId, parentTaps, triggerEdge, screenshotsDir));
  }

  // Generate test methods for screens reachable via link edges FROM modal screens.
  // These are multi-step flows inside modals (e.g. prescription steps inside a fullScreenCover).
  // BFS from each modal screen using link edges to find children not yet covered.
  const coveredNodes = new Set([...edgePaths.keys(), ...modalScreens.keys(), ...overrideNodeIds]);
  for (const [modalNodeId, { parentEdgePath, triggerEdge }] of modalScreens) {
    const modalChildPaths = bfsEdgePaths(graph, [modalNodeId]);
    for (const [childId, childEdgePath] of modalChildPaths) {
      if (childId === modalNodeId) continue; // skip the modal root itself
      if (coveredNodes.has(childId)) continue;
      if (overrideNodeIds.has(childId)) continue;
      const childNode = nodeMap.get(childId);
      if (!childNode || childNode.type !== "screen") continue;

      coveredNodes.add(childId);
      // Build taps: parent path to modal source + modal trigger + link path within modal
      const parentTaps = buildTaps(parentEdgePath, nodeMap, defaultTabTarget, tabIndexMap);
      const childTaps = buildTaps(childEdgePath, nodeMap, null, tabIndexMap); // no default tab inside modal
      methods.push(generateModalChildMethod(childId, parentTaps, triggerEdge, childTaps, screenshotsDir));
    }
  }

  // Generate override test methods — custom steps from config file
  for (const [nodeId, override] of Object.entries(overrides)) {
    methods.push(generateOverrideMethod(nodeId, override.steps, screenshotsDir, tabIndexMap));
  }

  if (methods.length === 0) return null;

  return generateTestFile(methods, screenshotsDir);
}

// ---------------------------------------------------------------------------
// Modal screen collection
// ---------------------------------------------------------------------------

/**
 * Collect screens reachable only via modal edges (sheet, full-screen, web-view).
 * Returns Map<nodeId, { parentEdgePath, triggerEdge }> where parentEdgePath is
 * the BFS path to the source screen and triggerEdge is the modal-opening edge.
 * Skips safari edges and nodes already reachable via regular BFS.
 */
function collectModalScreens(graph, edgePaths) {
  const modalScreens = new Map();

  // Two passes: first collect edges with real trigger labels (from source code),
  // then fill in remaining with fallback-label edges. This ensures we prefer
  // edges where the parser found the actual button text over auto-generated labels.
  const candidateEdges = graph.edges.filter(
    (e) => MODAL_EDGE_TYPES.has(e.type) && edgePaths.has(e.source) && !edgePaths.has(e.target)
  );

  // Pass 1: edges with real trigger labels (label doesn't match auto-generated toLabel)
  for (const edge of candidateEdges) {
    if (modalScreens.has(edge.target)) continue;
    const fallbackLabel = toLabel(edge.target);
    if (edge.label && edge.label !== fallbackLabel) {
      modalScreens.set(edge.target, {
        parentEdgePath: edgePaths.get(edge.source),
        triggerEdge: edge,
      });
    }
  }

  // Pass 2: remaining edges (fallback labels)
  for (const edge of candidateEdges) {
    if (modalScreens.has(edge.target)) continue;
    modalScreens.set(edge.target, {
      parentEdgePath: edgePaths.get(edge.source),
      triggerEdge: edge,
    });
  }

  return modalScreens;
}

// ---------------------------------------------------------------------------
// BFS
// ---------------------------------------------------------------------------

function bfsEdgePaths(graph, startIds) {
  // Returns Map<nodeId, Array<edge>>
  // where edge-array is the sequence of edges from a root to that node.
  const visited = new Map();
  const queue = [];

  for (const id of startIds) {
    visited.set(id, []);
    queue.push(id);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currentPath = visited.get(current);

    for (const edge of graph.edges) {
      if (edge.source !== current) continue;
      if (!NAVIGABLE_EDGE_TYPES.has(edge.type)) continue;
      if (visited.has(edge.target)) continue;

      const newPath = [...currentPath, edge];
      visited.set(edge.target, newPath);
      queue.push(edge.target);
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Tap building
// ---------------------------------------------------------------------------

/**
 * Convert a sequence of graph edges to an array of tap descriptors.
 * Each tap has { kind: "tab"|"element", candidates: [string] }
 * where candidates are tried in order until one is found in the UI.
 */
function buildTaps(edgePath, nodeMap, defaultTabTarget, tabIndexMap = new Map()) {
  const taps = [];

  for (const edge of edgePath) {
    if (edge.type === "tab") {
      // Skip tapping the default tab — the app already starts there.
      if (edge.target === defaultTabTarget) continue;
      const tabIndex = tabIndexMap.get(edge.target) ?? -1;
      taps.push({ kind: "tab", candidates: [edge.label].filter(Boolean), tabIndex });
    } else if (edge.type === "link") {
      // Candidate labels to try in the UI, in preference order:
      //  1. The edge label (RowLink title / button text) — the actual tappable text.
      //  2. The destination node's display label (from navigationTitle) — fallback
      //     for HubRowLink buttons whose text comes from hubType.title.
      // Deduplication removes redundant candidates.
      const destNode = nodeMap.get(edge.target);
      const destLabel = destNode?.label ?? null;
      const edgeLabel = edge.label || null;

      const candidates = [...new Set([edgeLabel, destLabel].filter(Boolean))];
      if (candidates.length === 0) continue;
      taps.push({ kind: "element", candidates });
    }
  }

  return taps;
}

// ---------------------------------------------------------------------------
// Swift code generation
// ---------------------------------------------------------------------------

function generateMethod(nodeId, taps, screenshotsDir) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);

  const tapLines = taps.map((tap) => {
    if (tap.kind === "tab") {
      const label = swiftEscape(tap.candidates[0] || "");
      const idx = tap.tabIndex ?? -1;
      return `        guard tapTab("${label}", index: ${idx}, in: app) else { print("⚠️ [flow-map] tapTab failed: ${label}"); return }`;
    }
    // Build a Swift array literal of candidate strings
    const candidatesLiteral = tap.candidates
      .map((c) => `"${swiftEscape(c)}"`)
      .join(", ");
    // For the print message, escape the inner quotes so they're valid inside a Swift string
    const candidatesPrint = tap.candidates
      .map((c) => `\\"${swiftEscape(c)}\\"`)
      .join(", ");
    return `        guard tapElement(matching: [${candidatesLiteral}], in: app) else { print("⚠️ [flow-map] tapElement failed: [${candidatesPrint}]"); return }`;
  });

  // When there are no taps (e.g. the home screen / default tab), the app
  // launches directly to that screen. We need a longer initial wait to let
  // the splash screen dismiss and content load. Other screens already get
  // this delay via tapTab()'s built-in 2.5s splash wait.
  const preSleepTime = taps.length === 0 ? "5.0" : "2.0";

  return `
    func testCapture_${safeName}() {
        print("📸 [flow-map] Capturing: ${safeName}")
        let app = XCUIApplication()
        app.launch()
${tapLines.join("\n")}
        Thread.sleep(forTimeInterval: ${preSleepTime})
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
        print("✅ [flow-map] Captured: ${safeName}")
    }`;
}

/**
 * Generate a test method that navigates to a parent screen, taps the modal
 * trigger, waits for the animation, then captures the modal screen.
 */
function generateModalMethod(nodeId, parentTaps, triggerEdge, screenshotsDir) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);
  const waitTime = triggerEdge.type === "web-view" ? "4.0" : "2.0";

  const lines = parentTaps.map((tap) => {
    if (tap.kind === "tab") {
      const label = swiftEscape(tap.candidates[0] || "");
      const idx = tap.tabIndex ?? -1;
      return `        guard tapTab("${label}", index: ${idx}, in: app) else { print("⚠️ [flow-map] tapTab failed: ${label}"); return }`;
    }
    const lit = tap.candidates.map((c) => `"${swiftEscape(c)}"`).join(", ");
    const litPrint = tap.candidates.map((c) => `\\"${swiftEscape(c)}\\"`).join(", ");
    return `        guard tapElement(matching: [${lit}], in: app) else { print("⚠️ [flow-map] tapElement failed: [${litPrint}]"); return }`;
  });

  if (triggerEdge.label) {
    const trigLit = swiftEscape(triggerEdge.label);
    const fallbackLabel = toLabel(triggerEdge.target);
    const isFallback = triggerEdge.label === fallbackLabel;
    if (isFallback) {
      // Auto-generated label — use guard so a wrong screenshot is never taken
      lines.push(`        guard tapElement(matching: ["${trigLit}"], in: app) else { print("⚠️ [flow-map] tapElement failed (auto-label): [\\"${trigLit}\\"]"); return }`);
    } else {
      lines.push(`        guard tapElement(matching: ["${trigLit}"], in: app) else { print("⚠️ [flow-map] tapElement failed: [\\"${trigLit}\\"]"); return }`);
    }
  }

  return `
    func testCapture_modal_${safeName}() {
        print("📸 [flow-map] Capturing modal: ${safeName}")
        let app = XCUIApplication()
        app.launch()
${lines.join("\n")}
        Thread.sleep(forTimeInterval: ${waitTime})
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
        print("✅ [flow-map] Captured modal: ${safeName}")
    }`;
}

/**
 * Generate a test method for a screen reachable via link edges INSIDE a modal.
 * Navigates to the modal parent, opens the modal, then follows link edges within it.
 */
function generateModalChildMethod(nodeId, parentTaps, triggerEdge, childTaps, screenshotsDir) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);

  const lines = [];

  // Navigate to the modal's parent screen
  for (const tap of parentTaps) {
    if (tap.kind === "tab") {
      const label = swiftEscape(tap.candidates[0] || "");
      const idx = tap.tabIndex ?? -1;
      lines.push(`        guard tapTab("${label}", index: ${idx}, in: app) else { print("⚠️ [flow-map] tapTab failed: ${label}"); return }`);
    } else {
      const lit = tap.candidates.map((c) => `"${swiftEscape(c)}"`).join(", ");
      const litPrint = tap.candidates.map((c) => `\\"${swiftEscape(c)}\\"`).join(", ");
      lines.push(`        guard tapElement(matching: [${lit}], in: app) else { print("⚠️ [flow-map] tapElement failed: [${litPrint}]"); return }`);
    }
  }

  // Open the modal
  if (triggerEdge.label) {
    const trigLit = swiftEscape(triggerEdge.label);
    lines.push(`        guard tapElement(matching: ["${trigLit}"], in: app) else { print("⚠️ [flow-map] tapElement failed: [\\"${trigLit}\\"]"); return }`);
  }

  // Navigate within the modal via link edges
  for (const tap of childTaps) {
    if (tap.kind === "tab") {
      const label = swiftEscape(tap.candidates[0] || "");
      const idx = tap.tabIndex ?? -1;
      lines.push(`        guard tapTab("${label}", index: ${idx}, in: app) else { print("⚠️ [flow-map] tapTab failed: ${label}"); return }`);
    } else {
      const lit = tap.candidates.map((c) => `"${swiftEscape(c)}"`).join(", ");
      const litPrint = tap.candidates.map((c) => `\\"${swiftEscape(c)}\\"`).join(", ");
      lines.push(`        guard tapElement(matching: [${lit}], in: app) else { print("⚠️ [flow-map] tapElement failed: [${litPrint}]"); return }`);
    }
  }

  return `
    func testCapture_modalChild_${safeName}() {
        print("📸 [flow-map] Capturing modal child: ${safeName}")
        let app = XCUIApplication()
        app.launch()
${lines.join("\n")}
        Thread.sleep(forTimeInterval: 2.0)
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
        print("✅ [flow-map] Captured modal child: ${safeName}")
    }`;
}

/**
 * Generate a test method from config override steps.
 * Steps are strings like:
 *   "tap:Label"              → tapElement(matching: ["Label"])
 *   "tapTab:Label:index"     → tapTab("Label", index: N)
 *   "tapContaining:text"     → tap button whose label CONTAINS text
 *   "tapCell:index"          → tap cell at index N
 *   "swipeLeft:firstCell"    → swipe left on first cell (e.g. to reveal delete)
 *   "wait:seconds"           → Thread.sleep
 */
function generateOverrideMethod(nodeId, steps, screenshotsDir, tabIndexMap) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);

  const lines = steps.map((step) => {
    const colonIdx = step.indexOf(":");
    const command = colonIdx >= 0 ? step.slice(0, colonIdx) : step;
    const args = colonIdx >= 0 ? step.slice(colonIdx + 1) : "";

    switch (command) {
      case "tap": {
        const label = swiftEscape(args);
        return `        guard tapElement(matching: ["${label}"], in: app) else { print("⚠️ [flow-map] override tap failed: ${label}"); return }`;
      }
      case "tapTab": {
        const parts = args.split(":");
        const label = swiftEscape(parts[0]);
        const idx = parseInt(parts[1], 10) || 0;
        return `        guard tapTab("${label}", index: ${idx}, in: app) else { print("⚠️ [flow-map] override tapTab failed: ${label}"); return }`;
      }
      case "tapContaining": {
        const text = swiftEscape(args);
        return [
          `        do {`,
          `            let pred = NSPredicate(format: "label CONTAINS[c] %@", "${text}")`,
          `            let btn = app.buttons.matching(pred).firstMatch`,
          `            guard btn.waitForExistence(timeout: 3) else { print("⚠️ [flow-map] override tapContaining failed: ${text}"); return }`,
          `            btn.tap()`,
          `            Thread.sleep(forTimeInterval: 0.5)`,
          `        }`,
        ].join("\n");
      }
      case "tapCell": {
        const idx = parseInt(args, 10) || 0;
        return [
          `        do {`,
          `            let cell = app.cells.element(boundBy: ${idx})`,
          `            guard cell.waitForExistence(timeout: 3) else { print("⚠️ [flow-map] override tapCell failed: index ${idx}"); return }`,
          `            cell.tap()`,
          `            Thread.sleep(forTimeInterval: 0.5)`,
          `        }`,
        ].join("\n");
      }
      case "swipeLeft": {
        if (args === "firstCell") {
          return [
            `        do {`,
            `            let cell = app.cells.firstMatch`,
            `            guard cell.waitForExistence(timeout: 3) else { print("⚠️ [flow-map] override swipeLeft failed"); return }`,
            `            cell.swipeLeft()`,
            `            Thread.sleep(forTimeInterval: 0.5)`,
            `        }`,
          ].join("\n");
        }
        const idx = parseInt(args, 10) || 0;
        return [
          `        do {`,
          `            let cell = app.cells.element(boundBy: ${idx})`,
          `            guard cell.waitForExistence(timeout: 3) else { print("⚠️ [flow-map] override swipeLeft failed: index ${idx}"); return }`,
          `            cell.swipeLeft()`,
          `            Thread.sleep(forTimeInterval: 0.5)`,
          `        }`,
        ].join("\n");
      }
      case "tapSwitch": {
        const idx = parseInt(args, 10) || 0;
        return [
          `        do {`,
          `            let sw = app.switches.element(boundBy: ${idx})`,
          `            guard sw.waitForExistence(timeout: 3) else { print("⚠️ [flow-map] override tapSwitch failed: index ${idx}"); return }`,
          `            sw.tap()`,
          `            Thread.sleep(forTimeInterval: 0.5)`,
          `        }`,
        ].join("\n");
      }
      case "wait": {
        const seconds = parseFloat(args) || 2.0;
        return `        Thread.sleep(forTimeInterval: ${seconds})`;
      }
      default:
        return `        // Unknown override step: ${swiftEscape(step)}`;
    }
  });

  return `
    func testCapture_override_${safeName}() {
        print("📸 [flow-map] Capturing (override): ${safeName}")
        let app = XCUIApplication()
        app.launch()
${lines.join("\n")}
        Thread.sleep(forTimeInterval: 2.0)
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
        print("✅ [flow-map] Captured (override): ${safeName}")
    }`;
}

function generateTestFile(methods, screenshotsDir) {
  const escapedDir = swiftEscape(screenshotsDir);
  return `import XCTest

// Auto-generated by quiver.
// This file is temporary — it is restored after screenshot capture.

final class QuiverCapture: XCTestCase {

    override func setUpWithError() throws {
        // Continue on failure so all screens get a capture attempt.
        continueAfterFailure = true
    }

    // MARK: - Helpers

    /// Tap a tab bar button by label and/or index. Returns false if the tab was not found.
    /// Uses index-based tapping as the primary strategy (immune to label mismatches),
    /// with label-based fallbacks for robustness.
    @discardableResult
    func tapTab(_ label: String, index: Int, in app: XCUIApplication) -> Bool {
        // Wait for the splash screen to clear by waiting for the tab bar to settle.
        // Use a known home-screen element as the "ready" signal instead of just the tab bar,
        // since the tab bar element may exist in the hierarchy before the splash dismisses.
        Thread.sleep(forTimeInterval: 2.5) // cover the 2s splash + buffer
        let pred = NSPredicate(format: "label CONTAINS[c] %@", label)
        // 1. Index-based tap — reliable regardless of label text or badge counts
        if index >= 0 {
            let tabBar = app.tabBars.firstMatch
            if tabBar.exists {
                let btn = tabBar.buttons.element(boundBy: index)
                if btn.exists { btn.tap(); Thread.sleep(forTimeInterval: 0.5); return true }
            }
        }
        // 2. Exact label match within tab bar
        let exact = app.tabBars.buttons[label]
        if exact.exists { exact.tap(); Thread.sleep(forTimeInterval: 0.5); return true }
        // 3. Contains match within tab bar
        let fuzzy = app.tabBars.buttons.matching(pred).firstMatch
        if fuzzy.exists { fuzzy.tap(); Thread.sleep(forTimeInterval: 0.5); return true }
        // 4. Search all buttons (SwiftUI may not expose tab items under tabBars)
        let anyBtn = app.buttons.matching(pred).firstMatch
        if anyBtn.exists { anyBtn.tap(); Thread.sleep(forTimeInterval: 0.5); return true }
        return false
    }

    /// Find any tappable element matching one of the candidate labels and tap it.
    /// Prioritises interactive elements (buttons, cells) over static text to avoid
    /// accidentally tapping section headers or navigation titles.
    @discardableResult
    func tapElement(matching candidates: [String], in app: XCUIApplication) -> Bool {
        for (index, candidate) in candidates.enumerated() {
            let isLast = index == candidates.count - 1
            // 1. Button — exact label match (most common for navigation links)
            let btn = app.buttons[candidate]
            if btn.waitForExistence(timeout: 3) {
                btn.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            // 2. Button — CONTAINS match (for buttons whose label includes subtitle text)
            let containsPred = NSPredicate(format: "label CONTAINS[c] %@", candidate)
            let fuzzyBtn = app.buttons.matching(containsPred).firstMatch
            if fuzzyBtn.waitForExistence(timeout: 0.5) {
                fuzzyBtn.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            // 3. List / table cell
            let cell = app.cells[candidate]
            if cell.waitForExistence(timeout: 0.5) {
                cell.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            // 4. Accessibility identifier
            let identPred = NSPredicate(format: "identifier ==[c] %@", candidate)
            let identEl = app.descendants(matching: .any).matching(identPred).firstMatch
            if identEl.waitForExistence(timeout: 0.5) {
                identEl.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
            // 5. Scroll and retry — only for the last candidate to avoid wasting time
            if isLast {
                var swiped = 0
                for _ in 0..<2 {
                    app.swipeUp()
                    swiped += 1
                    if btn.waitForExistence(timeout: 0.5) {
                        btn.tap()
                        Thread.sleep(forTimeInterval: 0.5)
                        return true
                    }
                    if cell.waitForExistence(timeout: 0.5) {
                        cell.tap()
                        Thread.sleep(forTimeInterval: 0.5)
                        return true
                    }
                }
                // Restore scroll position so subsequent taps/screenshots aren't affected
                for _ in 0..<swiped { app.swipeDown() }
            }
        }
        // No candidate found — leave the screen as-is and continue.
        return false
    }

    /// Write the current screen as a PNG to the given directory.
    func writeScreenshot(name: String, to dir: String) {
        let dirURL = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        let fileURL = dirURL.appendingPathComponent("\\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: fileURL)
    }

    // MARK: - Screen captures
${methods.join("\n")}
}
`;
}

function swiftEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

module.exports = { generateXCUITest, sanitizeFilename };

/**
 * Idempotently injects quiver launch-args route-handler code into
 * a SwiftUI prototype for the simctl-based screenshot pipeline.
 *
 * Requires the prototype to use iOS 16+ NavigationStack(path:) with a typed
 * navigationDestination(for:) modifier. Call detectNavigationStackPattern()
 * first to gate — if it returns false, fall back to the XCUITest path.
 *
 * Inject targets:
 *  1. App entry point (@main struct) — skip splash/loading animation
 *  2. NavigationHost (owns NavigationStack(path:)) — .task dispatcher,
 *     .navigationDestination(for: String.self), quiverSubDestination() helper
 *  3. Parent views with sheet/fullScreenCover children — .task to open modals
 *
 * All injections are idempotent (guarded by a sentinel comment) and are
 * reverted by calling the cleanup function returned by injectQuiverRouteHandler.
 */

const fs = require("fs");
const path = require("path");
const { globSync } = require("glob");

const SENTINEL = "// [quiver-injected]";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether the prototype uses the iOS 16+ NavigationStack(path:) pattern
 * that the launch-args injector supports. Call before injecting.
 *
 * @param {string} prototypePath
 * @returns {boolean}
 */
function detectNavigationStackPattern(prototypePath) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const f of swiftFiles) {
    const content = fs.readFileSync(f, "utf-8");
    if (
      content.includes("NavigationStack(path:") ||
      content.includes("NavigationStack(path :")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Inject the flow-map route-handler code into the prototype.
 *
 * @param {object} graph - { nodes, edges } from swift-graph-builder
 * @param {string} prototypePath
 * @param {object[]} parsedViews - array of parsed view objects from swift-parser
 * @returns {{ cleanup: function, routePlan: object }} cleanup restores files;
 *   routePlan is the set of routes the runner should loop over.
 */
function injectQuiverRouteHandler(graph, prototypePath, parsedViews) {
  const backups = []; // { filePath, original }

  function backup(filePath, content) {
    backups.push({ filePath, original: content });
  }

  // Build a map of viewName → parsed view data for fast lookup
  const viewMap = new Map(parsedViews.map((v) => [v.viewName, v]));

  // 1. Find the NavigationHost file
  const hostInfo = findNavigationHost(prototypePath);
  if (!hostInfo) {
    throw new Error(
      "Could not find a NavigationStack(path:) host view. " +
        "Ensure the prototype uses iOS 16+ path-based navigation.",
    );
  }
  const { filePath: hostFile, enumType } = hostInfo;
  const hostContent = fs.readFileSync(hostFile, "utf-8");

  // 2. Parse enum-case → view-name mapping from the existing navigationDestination switch
  const caseMap = parseCaseMap(hostContent, enumType, prototypePath);

  // 3. Build the full route plan from the graph
  // Extract the host view name so buildRoutePlan can add the root "home" route
  const hostViewNameMatch = hostContent.match(/\bstruct\s+(\w+)\s*:\s*(?:some\s+)?View\b/);
  const hostViewName = hostViewNameMatch ? hostViewNameMatch[1] : null;
  const routePlan = buildRoutePlan(graph, caseMap, parsedViews, prototypePath, hostViewName);

  // 4. Inject NavigationHost
  if (!hostContent.includes(SENTINEL)) {
    const injected = injectIntoNavigationHost(hostContent, routePlan, enumType, parsedViews, prototypePath);
    backup(hostFile, hostContent);
    fs.writeFileSync(hostFile, injected, "utf-8");
  }

  // 5. Inject App.swift splash-skip
  const appInfo = injectAppSplashSkip(prototypePath, backup);
  void appInfo; // may be null if no splash pattern found

  // 6. Inject parent-view sheet/cover triggers
  injectSheetTriggers(graph, viewMap, prototypePath, routePlan, backup);

  // 7. Inject into sub-NavigationStack hosts (sheet children that own NavigationStack(path:))
  for (const [subHostViewName, subHost] of routePlan.subNavigationHosts) {
    const parsedView = viewMap.get(subHostViewName);
    if (!parsedView || !parsedView.filePath) continue;
    const filePath = parsedView.filePath;
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(SENTINEL)) continue;
    const injected = injectIntoSubNavigationHost(content, subHost, parsedViews, prototypePath);
    backup(filePath, content);
    fs.writeFileSync(filePath, injected, "utf-8");
  }

  function cleanup() {
    for (const { filePath, original } of backups) {
      try {
        fs.writeFileSync(filePath, original, "utf-8");
      } catch (err) {
        console.warn(`   ⚠️  Could not restore ${filePath}: ${err.message}`);
      }
    }
  }

  return { cleanup, routePlan };
}

// ---------------------------------------------------------------------------
// Route plan
// ---------------------------------------------------------------------------

/**
 * Build the set of routes we'll capture, derived from the graph.
 *
 * Returns an object:
 *   routePlan.level1Routes  — [{ routeKey, viewName, caseExpr }]
 *   routePlan.pushRoutes    — [{ routeKey, viewName }]
 *   routePlan.allRoutes     — [{ route, nodeId }]
 *   routePlan.sheetRoutes   — [{ route, parentViewName, stateVar, nodeId }]
 *   routePlan.pushableViews — Set<string>
 *   routePlan.subNavigationHosts — Map<viewName, { viewName, pushRoutes, pushableViews }>
 *     Sub-NavigationStack hosts: sheet children that own their own NavigationStack(path:).
 *     Their push-reachable children get compound routes and dedicated injection.
 */
function buildRoutePlan(graph, caseMap, parsedViews, prototypePath, hostViewName) {
  // Build adjacency: source → [{ target, edgeType }]
  const adj = new Map();
  for (const edge of graph.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source).push({ target: edge.target, type: edge.type });
  }

  const level1Routes = [];
  const pushRoutes = [];
  const allRoutes = [];
  const sheetRoutes = [];
  const subNavigationHosts = new Map();

  // BFS: for each level-1 node, collect its push-reachable descendants
  for (const [routeKey, viewName] of caseMap) {
    const l1Node = graph.nodes.find((n) => n.id === viewName || n.label === viewName);
    if (!l1Node) continue;

    const caseExpr = `.${routeKey}`;
    level1Routes.push({ routeKey, viewName, caseExpr });
    allRoutes.push({ route: routeKey, nodeId: l1Node.id });

    // BFS from level-1 node for push-navigation descendants
    const visited = new Set([l1Node.id]);
    const queue = [{ nodeId: l1Node.id, prefix: routeKey }];

    while (queue.length > 0) {
      const { nodeId, prefix } = queue.shift();
      for (const { target, type } of adj.get(nodeId) || []) {
        if (visited.has(target)) continue;
        visited.add(target);

        const targetNode = graph.nodes.find((n) => n.id === target);
        if (!targetNode) continue;

        if (type === "link") {
          // Push navigation — can address via String path
          const routeKey2 = targetNode.id;
          const fullRoute = `${prefix}/${routeKey2}`;
          pushRoutes.push({ routeKey: routeKey2, viewName: targetNode.id });
          allRoutes.push({ route: fullRoute, nodeId: targetNode.id });
          queue.push({ nodeId: target, prefix: fullRoute });
        } else if (type === "sheet" || type === "full-screen") {
          // Sheet/cover — triggered by parent view's .task, not path push
          const parentViewName = nodeId;
          const fullRoute = `${prefix}/${targetNode.id}`;
          sheetRoutes.push({
            route: fullRoute,
            parentViewName,
            stateVar: null, // resolved later by injectSheetTriggers
            nodeId: targetNode.id,
          });
          allRoutes.push({ route: fullRoute, nodeId: targetNode.id });

          // If the sheet child owns its own NavigationStack, BFS its push children
          // to generate compound routes (e.g. profile/ProfileSwitcherView/AddCareProfileView).
          if (!subNavigationHosts.has(targetNode.id) &&
              viewOwnsNavigationStack(targetNode.id, parsedViews, prototypePath)) {
            const subPushRoutes = [];
            const subVisited = new Set([targetNode.id]);
            const subQueue = [{ nodeId: targetNode.id, prefix: fullRoute }];

            while (subQueue.length > 0) {
              const { nodeId: subNodeId, prefix: subPrefix } = subQueue.shift();
              for (const { target: subTarget, type: subType } of adj.get(subNodeId) || []) {
                if (subVisited.has(subTarget)) continue;
                subVisited.add(subTarget);
                if (subType !== "link") continue;

                const subTargetNode = graph.nodes.find((n) => n.id === subTarget);
                if (!subTargetNode) continue;

                // Skip views we can't instantiate — but try synthesis first before giving up
                if (hasRequiredInitParams(subTargetNode.id, parsedViews, prototypePath) &&
                    !synthesizeSwiftValue(subTargetNode.id, prototypePath)) continue;

                const subFullRoute = `${subPrefix}/${subTargetNode.id}`;
                subPushRoutes.push({ routeKey: subTargetNode.id, viewName: subTargetNode.id });
                allRoutes.push({ route: subFullRoute, nodeId: subTargetNode.id });
                subQueue.push({ nodeId: subTarget, prefix: subFullRoute });
              }
            }

            if (subPushRoutes.length > 0) {
              subNavigationHosts.set(targetNode.id, {
                viewName: targetNode.id,
                pushRoutes: subPushRoutes,
                pushableViews: new Set(subPushRoutes.map((r) => r.viewName)),
              });
            }
          }
        }
      }
    }
  }

  // The NavigationHost (e.g. HomeView) is never a NavigationDestination case —
  // add it as a "home" route so we capture the root screen.
  if (hostViewName) {
    const hostNode = graph.nodes.find((n) => n.id === hostViewName);
    if (hostNode) {
      allRoutes.push({ route: "home", nodeId: hostNode.id });
    }
  }

  // Deduplicate pushRoutes by viewName
  const seenPush = new Set();
  const dedupedPushRoutes = pushRoutes.filter(({ viewName }) => {
    if (seenPush.has(viewName)) return false;
    seenPush.add(viewName);
    return true;
  });

  const pushableViews = new Set(dedupedPushRoutes.map((r) => r.viewName));

  return { level1Routes, pushRoutes: dedupedPushRoutes, allRoutes, sheetRoutes, pushableViews, subNavigationHosts };
}

/**
 * Return true if the named view owns a NavigationStack(path:) in its file.
 */
function viewOwnsNavigationStack(viewName, parsedViews, prototypePath) {
  if (!parsedViews || !prototypePath) return false;
  const view = parsedViews && parsedViews.find((v) => v.viewName === viewName);
  let filePath = view && view.filePath;
  if (!filePath) {
    const candidates = globSync(`**/${viewName}.swift`, {
      cwd: prototypePath, absolute: true, ignore: ["**/*Tests*/**", "**/Pods/**"],
    });
    filePath = candidates[0] || null;
  }
  if (!filePath) return false;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.includes("NavigationStack(path:");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// NavigationHost injection
// ---------------------------------------------------------------------------

/**
 * Find the Swift file that contains NavigationStack(path: $...) — the NavigationHost.
 * Returns { filePath, enumType } or null.
 */
function findNavigationHost(prototypePath) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const filePath of swiftFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes("NavigationStack(path:") && !content.includes("NavigationStack(path :")) {
      continue;
    }
    // Extract the enum type from: navigationDestination(for: <Type>.self)
    const enumMatch = content.match(/\.navigationDestination\(for:\s*([A-Z][A-Za-z0-9_]+)\.self/);
    if (!enumMatch) continue;
    return { filePath, enumType: enumMatch[1] };
  }
  return null;
}

/**
 * Parse the existing navigationDestination switch in the NavigationHost to build
 * a Map of routeKey → viewName.
 *
 * Looks for patterns like:
 *   case .messages: MessagesView()
 *   case .profile: ProfileView()
 */
function parseCaseMap(hostContent, enumType, prototypePath) {
  const caseMap = new Map();

  // Find the switch block inside navigationDestination(for: EnumType.self)
  const ndPattern = new RegExp(
    `\\.navigationDestination\\(for:\\s*${enumType}\\.self[^{]*\\{[^{]*switch[^{]*\\{([\\s\\S]*?)\\}\\s*\\}\\s*\\}`,
    "m",
  );
  const ndMatch = hostContent.match(ndPattern);
  if (!ndMatch) return caseMap;

  const switchBody = ndMatch[1];

  // Match: case .<caseName>: <ViewName>(...)  or  case .<caseName>:\n  <ViewName>(...)
  const casePattern = /case\s+\.([a-z][A-Za-z0-9_]*):\s*\n?\s*([A-Z][A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = casePattern.exec(switchBody)) !== null) {
    caseMap.set(m[1], m[2]); // routeKey → viewName
  }

  return caseMap;
}

/**
 * Inject the flow-map code into the NavigationHost file content.
 *
 * Three insertions:
 *  A. Inside the NavigationStack content (after existing navigationDestination(for: EnumType.self)):
 *     .navigationDestination(for: String.self) { ... }
 *
 *  B. Outside the NavigationStack (as a .task on the List/root, or after closing brace):
 *     .task { ... route dispatcher ... }
 *
 *  C. Bottom of struct: quiverSubDestination() @ViewBuilder helper
 */
function injectIntoNavigationHost(content, routePlan, enumType, parsedViews, prototypePath) {
  const { level1Routes, pushRoutes, pushableViews } = routePlan;

  // -- A: .navigationDestination(for: String.self) --
  // Insert it after the existing .navigationDestination(for: EnumType.self) { ... } block
  const ndEnumPattern = new RegExp(
    `(\\.navigationDestination\\(for:\\s*${enumType}\\.self[^{]*\\{[\\s\\S]*?^\\s*\\})`,
    "m",
  );
  // The block ends at the closing } of the closure — we need to find it with brace-counting
  const ndStringHandler = `\n            .navigationDestination(for: String.self) { viewName in\n                ${SENTINEL}\n                quiverSubDestination(viewName)\n            }`;

  let result = content;

  // Find the navigationDestination(for: EnumType.self) block and insert after it
  const insertAfterEnum = insertAfterNavigationDestination(content, enumType, ndStringHandler);
  if (insertAfterEnum) {
    result = insertAfterEnum;
  }

  // -- B: .task dispatcher --
  // Insert as a modifier on the NavigationStack (after its closing brace + .id() if present)
  const taskCode = generateTaskCode(level1Routes, pushableViews, enumType);
  result = insertTaskAfterNavigationStack(result, taskCode);

  // -- C: quiverSubDestination helper --
  const helperCode = generateHelperFunction(pushRoutes, parsedViews, prototypePath);
  result = insertHelperAtStructBottom(result, helperCode);

  return result;
}

function insertAfterNavigationDestination(content, enumType, insertion) {
  // Find the start of .navigationDestination(for: EnumType.self)
  const startPattern = new RegExp(
    `\\.navigationDestination\\(for:\\s*${enumType}\\.self`,
  );
  const startMatch = startPattern.exec(content);
  if (!startMatch) return null;

  // Count braces from the opening { of the trailing closure
  let pos = startMatch.index + startMatch[0].length;
  // Skip to the first {
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return null;

  // Count balanced braces to find the closing } of the closure
  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
    end++;
  }

  // Check if String handler already injected
  if (content.slice(startMatch.index, end + 200).includes("for: String.self")) return null;

  return content.slice(0, end) + insertion + content.slice(end);
}

function insertTaskAfterNavigationStack(content, taskCode) {
  // Don't re-inject if already present (check for something specific to the task,
  // not the general SENTINEL which may already be written by the String handler)
  if (content.includes("navigationPath.append(level1)")) return content;

  // Find the NavigationStack's closing brace by brace-counting from "NavigationStack(path:"
  const nsStart = content.search(/NavigationStack\(path:/);
  if (nsStart === -1) return content;

  // Find the opening { of the NavigationStack content
  let pos = nsStart + "NavigationStack(path:".length;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return content;

  // Count braces to find closing }
  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
    end++;
  }

  // Skip past .id(...) if present
  const afterNs = content.slice(end);
  const idMatch = afterNs.match(/^(\s*\.id\([^)]+\))/);
  if (idMatch) end += idMatch[1].length;

  return content.slice(0, end) + "\n" + taskCode + content.slice(end);
}

function insertHelperAtStructBottom(content, helperCode) {
  // We need to insert INSIDE the struct, before its closing }.
  // The struct closing } is the last \n} before the first \n#Preview (or end of file).
  const previewIdx = content.search(/\n#Preview/);
  const searchBefore = previewIdx !== -1 ? previewIdx : content.length;

  // Find the last \n} before searchBefore — this is the struct closing brace
  const structCloseIdx = content.lastIndexOf("\n}", searchBefore);
  if (structCloseIdx !== -1) {
    return (
      content.slice(0, structCloseIdx) +
      "\n\n" +
      helperCode +
      "\n" +
      content.slice(structCloseIdx)
    );
  }
  return content + "\n" + helperCode;
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generateTaskCode(level1Routes, pushableViews, enumType) {
  const cases = level1Routes
    .map(
      ({ routeKey, caseExpr }) =>
        `            case "${routeKey}": level1 = ${caseExpr}`,
    )
    .join("\n");

  const pushableArray = [...pushableViews]
    .map((v) => `                "${v}"`)
    .join(",\n");

  return `        .task {
            ${SENTINEL}
            // quiver: read -quiverRoute launch arg and dispatch navigation.
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-quiverRoute"), i + 1 < args.count else { return }
            let segments = args[i + 1].split(separator: "/").map(String.init)
            guard let first = segments.first else { return }
            let level1: ${enumType}?
            switch first {
${cases}
            default: level1 = nil
            }
            guard let level1 else { return }
            let pushableViews: Set<String> = [
${pushableArray}
            ]
            navigationPath = NavigationPath()
            navigationPath.append(level1)
            for segment in segments.dropFirst() {
                guard pushableViews.contains(segment) else { break }
                navigationPath.append(segment)
            }
        }`;
}

function generateHelperFunction(pushRoutes, parsedViews, prototypePath) {
  const cases = pushRoutes
    .flatMap(({ viewName }) => {
      if (!hasRequiredInitParams(viewName, parsedViews, prototypePath)) {
        return [`        case "${viewName}": ${viewName}()`];
      }
      const initCall = synthesizeSwiftValue(viewName, prototypePath);
      return initCall ? [`        case "${viewName}": ${initCall}`] : [];
    })
    .join("\n");

  return `    // quiver: resolve String navigation path segments to views.
    ${SENTINEL}
    @ViewBuilder
    private func quiverSubDestination(_ viewName: String) -> some View {
        switch viewName {
${cases}
        default: EmptyView()
        }
    }`;
}

/**
 * Return true if the SwiftUI view struct has required stored properties
 * (i.e. cannot be instantiated with just `ViewName()`).
 * Heuristic: looks for `let name: Type` or `var name: Type` without a default
 * value and without a property wrapper, before `var body`.
 *
 * Checks parsedViews first (fast path), then falls back to scanning all Swift
 * files in the prototype directory (for views not picked up by the parser
 * because they have no navigation patterns).
 */
function hasRequiredInitParams(viewName, parsedViews, prototypePath) {
  if (!prototypePath) return false;

  // Resolve the file path: parsedViews fast path, then glob fallback
  let filePath = null;
  const view = parsedViews && parsedViews.find((v) => v.viewName === viewName);
  if (view && view.filePath) {
    filePath = view.filePath;
  } else {
    // Fall back: find the file that defines this struct
    const candidates = globSync(`**/${viewName}.swift`, {
      cwd: prototypePath,
      absolute: true,
      ignore: ["**/*Tests*/**", "**/Pods/**"],
    });
    if (candidates.length > 0) filePath = candidates[0];
  }

  if (!filePath) return false;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Isolate the struct's body up to `var body`
    const bodyStart = content.search(/\bvar\s+body\b/);
    if (bodyStart === -1) return false;
    const beforeBody = content.slice(0, bodyStart);

    const lines = beforeBody.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (/^(?:let|var)\s+\w+\s*:/.test(t) && !t.includes("=") && !t.startsWith("@")) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// App.swift splash-skip injection
// ---------------------------------------------------------------------------

/**
 * Find the @main App struct and inject a splash-skip when -quiverRoute is present.
 * Targets the common pattern of an @State showSplash / isLoading bool.
 *
 * Returns true if injected, false if no matching pattern found (non-fatal).
 */
function injectAppSplashSkip(prototypePath, backup) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const filePath of swiftFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes("@main")) continue;
    if (content.includes(SENTINEL)) continue; // already injected

    // Look for a common splash State pattern — with or without explicit `: Bool` annotation.
    // Matches: @State private var showSplash: Bool  or  @State private var showSplash = true
    const splashVarMatch = content.match(
      /@State\s+(?:private\s+)?var\s+(show(?:Splash|Loading|Launch)|isLoading|isSplashVisible)\s*(?::\s*Bool|=\s*true\b)/,
    );
    if (!splashVarMatch) continue;

    const varName = splashVarMatch[1];

    // Inject an init() that sets the var to false when -quiverRoute is present.
    // Strategy: find the struct declaration line and insert init() after the
    // State property declarations block.
    const initInjection = `
    ${SENTINEL}
    init() {
        // quiver: skip splash/animation when launched with -quiverRoute.
        if ProcessInfo.processInfo.arguments.contains("-quiverRoute") {
            self._${varName} = State(initialValue: false)
        }
    }
`;

    // Insert after the last @State property declaration block, before `var body`
    const bodyIdx = content.search(/\n\s{4}var body\s*:/);
    if (bodyIdx === -1) continue;

    const injected = content.slice(0, bodyIdx) + "\n" + initInjection + content.slice(bodyIdx);
    backup(filePath, content);
    fs.writeFileSync(filePath, injected, "utf-8");
    return { filePath, varName };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sheet/cover trigger injection
// ---------------------------------------------------------------------------

/**
 * For each sheet/fullScreenCover route in the plan, find the parent view file
 * and inject a .task that reads the launch arg and sets the controlling @State var.
 */
function injectSheetTriggers(graph, viewMap, prototypePath, routePlan, backup) {
  // Group sheet routes by parentViewName
  const byParent = new Map();
  for (const sr of routePlan.sheetRoutes) {
    if (!byParent.has(sr.parentViewName)) byParent.set(sr.parentViewName, []);
    byParent.get(sr.parentViewName).push(sr);
  }

  for (const [parentViewName, sheetRoutes] of byParent) {
    const parsedView = viewMap.get(parentViewName);
    if (!parsedView || !parsedView.filePath) continue;

    const filePath = parsedView.filePath;
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(SENTINEL)) continue;

    // For each sheet route, find the @State var that controls it
    const triggers = resolveSheetStateVars(content, sheetRoutes);
    if (triggers.length === 0) continue;

    // Synthesize default values for item:-bound triggers
    for (const trigger of triggers) {
      if (trigger.kind === "item") {
        trigger.synthesizedValue = synthesizeSwiftValue(trigger.itemType, prototypePath);
        if (trigger.synthesizedValue === null) {
          console.warn(`   ⚠️  Could not synthesize ${trigger.itemType} for ${trigger.stateVar} in ${parentViewName} — sheet screenshot skipped`);
        }
      }
    }

    const taskCode = generateSheetTriggerTask(parentViewName, triggers);
    if (!taskCode) continue;

    // Insert before the first .alert( or .sheet( or end-of-body
    const injected = insertSheetTriggerTask(content, taskCode);
    backup(filePath, content);
    fs.writeFileSync(filePath, injected, "utf-8");
  }
}

/**
 * For each sheet route, find the @State var that controls it.
 * Handles both isPresented: (Bool) and item: (Optional<T>) bindings.
 * Returns triggers with kind: "bool" | "item". Item triggers also carry itemType.
 */
function resolveSheetStateVars(content, sheetRoutes) {
  const triggers = [];

  function extractClosureBody(content, matchEnd) {
    let pos = matchEnd;
    while (pos < content.length && content[pos] !== "{") pos++;
    if (pos >= content.length) return null;
    let depth = 0, end = pos;
    while (end < content.length) {
      if (content[end] === "{") depth++;
      else if (content[end] === "}") { depth--; if (depth === 0) break; }
      end++;
    }
    return content.slice(pos, end + 1);
  }

  // Pass 1: isPresented: $boolVar
  const isPresentedPattern =
    /\.(sheet|fullScreenCover)\(\s*isPresented\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = isPresentedPattern.exec(content)) !== null) {
    const stateVar = m[2];
    const closureBody = extractClosureBody(content, m.index + m[0].length);
    if (!closureBody) continue;
    for (const sr of sheetRoutes) {
      if (closureBody.includes(sr.nodeId)) {
        const segments = sr.route.split("/");
        triggers.push({
          kind: "bool",
          stateVar,
          routeSegment: segments[segments.length - 1],
          routeFull: sr.route,
          parentViewName: sr.parentViewName,
        });
      }
    }
  }

  // Pass 2: item: $itemVar — extract the binding type from the @State declaration
  const itemPattern =
    /\.(sheet|fullScreenCover)\(\s*item\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = itemPattern.exec(content)) !== null) {
    const stateVar = m[2];
    const closureBody = extractClosureBody(content, m.index + m[0].length);
    if (!closureBody) continue;

    // Find @State var stateVar: ItemType? in the file
    const typeMatch = content.match(
      new RegExp(`@State\\s+(?:private\\s+)?var\\s+${stateVar}\\s*:\\s*([A-Z][A-Za-z0-9_]+)\\??`),
    );
    if (!typeMatch) continue;
    const itemType = typeMatch[1];

    for (const sr of sheetRoutes) {
      if (closureBody.includes(sr.nodeId)) {
        const segments = sr.route.split("/");
        triggers.push({
          kind: "item",
          stateVar,
          itemType,
          synthesizedValue: null, // filled in by injectSheetTriggers
          routeSegment: segments[segments.length - 1],
          routeFull: sr.route,
          parentViewName: sr.parentViewName,
        });
      }
    }
  }

  return triggers;
}

function generateSheetTriggerTask(parentViewName, triggers) {
  const parentSegment = triggers[0]?.routeFull.split("/")[0] ?? "";
  const parentSegmentGuess = parentViewName;

  // Use segments.contains(routeSegment) rather than switching on the last segment.
  // This lets the trigger fire correctly for deeper routes like
  // profile/ProfileSwitcherView/AddCareProfileView (where the leaf is not the sheet name).
  const checks = triggers
    .filter((t) => t.kind === "bool" || t.synthesizedValue !== null)
    .map(({ stateVar, routeSegment, kind, synthesizedValue }) => {
      const rhs = kind === "item" ? synthesizedValue : "true";
      return `            if segments.contains("${routeSegment}") { ${stateVar} = ${rhs} }`;
    })
    .join("\n");

  if (!checks) return null;

  return `        .task {
            ${SENTINEL}
            // quiver: open sheet/cover when route targets a modal child.
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-quiverRoute"), i + 1 < args.count else { return }
            let segments = args[i + 1].split(separator: "/").map(String.init)
            guard segments.count > 1 else { return }
            guard segments.contains("${parentSegmentGuess}") || segments.first == "${parentSegment}" else { return }
${checks}
        }`;
}

function insertSheetTriggerTask(content, taskCode) {
  // Insert before the first .alert( modifier, or before .sheet(isPresented:,
  // or as the last modifier before the closing brace of body.
  const alertIdx = content.search(/\n\s+\.alert\(/);
  if (alertIdx !== -1) {
    return content.slice(0, alertIdx) + "\n" + taskCode + content.slice(alertIdx);
  }
  // Fallback: insert before the first .sheet(
  const sheetIdx = content.search(/\n\s+\.sheet\(/);
  if (sheetIdx !== -1) {
    return content.slice(0, sheetIdx) + "\n" + taskCode + content.slice(sheetIdx);
  }
  // Last resort: before final closing brace
  const lastBrace = content.lastIndexOf("\n    }");
  if (lastBrace !== -1) {
    return content.slice(0, lastBrace) + "\n" + taskCode + content.slice(lastBrace);
  }
  return content + "\n" + taskCode;
}

// ---------------------------------------------------------------------------
// Sub-NavigationStack injection
// ---------------------------------------------------------------------------

/**
 * Inject route-handler code into a sheet child that owns its own NavigationStack(path:).
 * Adds: .navigationDestination(for: String.self), .task, and quiverSubNavDestination helper.
 */
function injectIntoSubNavigationHost(content, subHost, parsedViews, prototypePath) {
  const { viewName, pushRoutes, pushableViews } = subHost;
  const pathVar = extractNavigationStackPathVar(content) || "path";

  // A: insert .navigationDestination(for: String.self) inside the NavigationStack content
  const ndStringHandler = `\n            .navigationDestination(for: String.self) { viewName in\n                ${SENTINEL}\n                quiverSubNavDestination(viewName)\n            }`;
  let result = insertStringHandlerIntoSubNavigationStack(content, ndStringHandler);

  // B: insert .task after the NavigationStack's closing brace
  const taskCode = generateSubHostTaskCode(viewName, pushableViews, pathVar);
  result = insertTaskAfterNavigationStack(result, taskCode);

  // C: insert quiverSubNavDestination helper into the named struct (not just "last struct in file")
  const helperCode = generateSubHostHelperFunction(pushRoutes, parsedViews, prototypePath);
  result = insertHelperIntoNamedStruct(result, viewName, helperCode);

  return result;
}

/**
 * Insert .navigationDestination(for: String.self) inside a NavigationStack content closure
 * that has no existing navigationDestination. Inserts just before the closing } of the
 * NavigationStack's content closure.
 */
function insertStringHandlerIntoSubNavigationStack(content, ndStringHandler) {
  if (content.includes("for: String.self")) return content;

  const nsStart = content.search(/NavigationStack\(path:/);
  if (nsStart === -1) return content;

  let pos = nsStart;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return content;

  // Brace-count to find the closing } of the NavigationStack content closure
  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }

  // Insert the handler before the closing } (at position end)
  return content.slice(0, end) + ndStringHandler + "\n        " + content.slice(end);
}

/**
 * Generate the .task Swift code for a sub-NavigationStack host.
 * Finds the host's own view name in the route segments, then pushes the next segment.
 * Sleeps 300ms first to allow the parent sheet animation to complete.
 */
function generateSubHostTaskCode(viewName, pushableViews, pathVar) {
  const pushableArray = [...pushableViews]
    .map((v) => `                "${v}"`)
    .join(",\n");

  return `        .task {
            ${SENTINEL}
            // quiver: push route within sub-NavigationStack after sheet opens.
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-quiverRoute"), i + 1 < args.count else { return }
            let segments = args[i + 1].split(separator: "/").map(String.init)
            guard let myIdx = segments.firstIndex(of: "${viewName}"), myIdx + 1 < segments.count else { return }
            let subPushableViews: Set<String> = [
${pushableArray}
            ]
            let targetSegments = Array(segments[(myIdx + 1)...])
            guard let firstTarget = targetSegments.first, subPushableViews.contains(firstTarget) else { return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            for segment in targetSegments {
                ${pathVar}.append(segment)
            }
        }`;
}

/**
 * Generate the quiverSubNavDestination @ViewBuilder helper for a sub-NavigationStack host.
 */
function generateSubHostHelperFunction(pushRoutes, parsedViews, prototypePath) {
  const cases = pushRoutes
    .flatMap(({ viewName }) => {
      if (!hasRequiredInitParams(viewName, parsedViews, prototypePath)) {
        return [`        case "${viewName}": ${viewName}()`];
      }
      const initCall = synthesizeSwiftValue(viewName, prototypePath);
      return initCall ? [`        case "${viewName}": ${initCall}`] : [];
    })
    .join("\n");

  return `    // quiver: resolve sub-NavigationStack path segments to views.
    ${SENTINEL}
    @ViewBuilder
    private func quiverSubNavDestination(_ viewName: String) -> some View {
        switch viewName {
${cases}
        default: EmptyView()
        }
    }`;
}

/**
 * Insert helperCode just before the closing } of a named struct.
 * Used so that helpers land in the correct struct when a file defines multiple structs.
 */
function insertHelperIntoNamedStruct(content, structName, helperCode) {
  // Find the struct declaration
  const structStart = content.search(new RegExp(`\\bstruct\\s+${structName}\\b`));
  if (structStart === -1) return insertHelperAtStructBottom(content, helperCode); // fallback

  // Brace-count from the struct's opening { to find its closing }
  let pos = structStart;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return insertHelperAtStructBottom(content, helperCode);

  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }

  // end is now the position of the struct's closing }
  return (
    content.slice(0, end) +
    "\n\n" +
    helperCode +
    "\n" +
    content.slice(end)
  );
}

/**
 * Extract the name of the @State path variable from NavigationStack(path: $varName).
 */
function extractNavigationStackPathVar(content) {
  const m = content.match(/NavigationStack\(path:\s*\$([A-Za-z_][A-Za-z0-9_]*)\)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Swift value synthesizer (for item:-bound sheet triggers and required-param views)
// ---------------------------------------------------------------------------

/**
 * Extract the Swift type from a type+default string like `String = "foo"` or `() -> Void`.
 * Strips everything from the first top-level `=` onwards.
 * Tracks `()`, `[]`, `{}` depth only — intentionally ignores `<>` so that
 * `->` in closure types does not confuse the bracket counter.
 */
function extractTopLevelType(str) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0) return str.slice(0, i).trim();
  }
  return str.trim();
}

const PRIMITIVE_DEFAULTS = {
  String: '""',
  Int: "0", Int8: "0", Int16: "0", Int32: "0", Int64: "0",
  UInt: "0", UInt8: "0", UInt16: "0", UInt32: "0", UInt64: "0",
  Double: "0.0", Float: "0.0", CGFloat: "0.0",
  Bool: "false",
  Date: "Date()",
  UUID: "UUID()",
  URL: 'URL(string: "https://example.com")!',
};

/**
 * Synthesize a Swift expression that produces a default value of the given type.
 * Returns a Swift expression string, or null if synthesis is not possible.
 */
function synthesizeSwiftValue(typeName, prototypePath, depth = 0) {
  if (depth > 3) return null;

  // Primitives
  if (PRIMITIVE_DEFAULTS[typeName]) return PRIMITIVE_DEFAULTS[typeName];

  // Optional: any T? → nil
  if (typeName.endsWith("?")) return "nil";

  // Closure: () -> Void → {}; other closures can't be safely synthesized
  if (typeName.includes("->")) return typeName.endsWith("-> Void") ? "{}" : null;

  // Binding<T> → .constant(default for T)
  if (typeName.startsWith("Binding<") && typeName.endsWith(">")) {
    const inner = typeName.slice(8, -1);
    const innerVal = synthesizeSwiftValue(inner, prototypePath, depth + 1);
    return innerVal !== null ? `.constant(${innerVal})` : null;
  }

  // Arrays: [T] → []
  if (typeName.startsWith("[") && typeName.endsWith("]")) return "[]";

  // Set<T> → [] (Swift accepts array literal for Set init)
  if (typeName.startsWith("Set<")) return "[]";

  // Dictionary: [K:V] → [:]
  if (typeName.startsWith("[") && typeName.includes(":")) return "[:]";

  // Custom struct: find its stored properties and build a memberwise call
  const props = findStoredProperties(typeName, prototypePath);
  if (!props) return null;

  const args = [];
  for (const { name, type, hasDefault, isOptional } of props) {
    if (hasDefault) continue; // memberwise init omits props that have a default value
    // Optional properties ARE included in the memberwise init (no automatic nil default)
    const val = isOptional ? "nil" : synthesizeSwiftValue(type, prototypePath, depth + 1);
    if (val === null) return null; // required field can't be synthesized → give up
    args.push(`${name}: ${val}`);
  }

  return `${typeName}(${args.join(", ")})`;
}

/**
 * Find and parse the stored (non-computed) properties of a Swift struct.
 * Returns an array of { name, type, hasDefault, isOptional }, or null if
 * the struct can't be found or is not a struct.
 */
function findStoredProperties(typeName, prototypePath) {
  // Try TypeName.swift first (common convention), then scan all files
  let content = null;
  const direct = globSync(`**/${typeName}.swift`, {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });
  if (direct.length > 0) {
    content = fs.readFileSync(direct[0], "utf-8");
  } else {
    const allFiles = globSync("**/*.swift", {
      cwd: prototypePath,
      absolute: true,
      ignore: ["**/*Tests*/**", "**/Pods/**"],
    });
    for (const f of allFiles) {
      const c = fs.readFileSync(f, "utf-8");
      if (new RegExp(`\\bstruct\\s+${typeName}\\b`).test(c)) { content = c; break; }
    }
  }

  if (!content) return null;
  if (!new RegExp(`\\bstruct\\s+${typeName}\\b`).test(content)) return null;

  // Find the struct opening brace
  const structStart = content.search(new RegExp(`\\bstruct\\s+${typeName}\\b`));
  let pos = structStart;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return null;

  const props = [];
  const lines = content.slice(pos + 1).split("\n");

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    // Stop at first method, init, or nested type
    if (/^(?:(?:private|public|internal|fileprivate|static)\s+)*(?:func|init|struct|class|enum)\b/.test(t)) break;
    // Stop at standalone closing brace (end of struct)
    if (t === "}") break;

    // Computed properties end their declaration line with {
    if (t.match(/\{\s*$/)) continue;

    // @Binding: include with inner type wrapped in Binding<...>
    const bindingMatch = t.match(
      /^@Binding\s+(?:(?:private|public|internal|fileprivate)\s+)?var\s+(\w+)\s*:\s*(.+)$/,
    );
    if (bindingMatch) {
      const innerType = extractTopLevelType(bindingMatch[2]);
      props.push({ name: bindingMatch[1], type: `Binding<${innerType}>`, hasDefault: false, isOptional: false });
      continue;
    }

    // Skip all other property wrapper lines (@State, @Environment, etc.)
    if (t.startsWith("@")) continue;

    // Strip trailing inline comment (`\s+//...`) before property parsing.
    // The \s+ guard avoids false positives on `//` inside string literals like URLs.
    const tClean = t.replace(/\s+\/\/.*$/, "");

    // Match stored property name: [modifiers] let|var name:
    const nameMatch = tClean.match(
      /^(?:(?:private|public|internal|fileprivate|static|lazy|weak)\s+)*(?:let|var)\s+(\w+)\s*:/,
    );
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const afterColon = tClean.slice(tClean.indexOf(":") + 1).trim();
    let type = extractTopLevelType(afterColon);
    const hasDefault = type !== afterColon; // extractTopLevelType strips '= ...' if present
    const isOptional = type.endsWith("?");
    if (isOptional) type = type.slice(0, -1).trim();

    props.push({ name, type, hasDefault, isOptional });
  }

  return props;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectNavigationStackPattern,
  injectQuiverRouteHandler,
  buildRoutePlan, // exported for testing
  parseCaseMap,   // exported for testing
};

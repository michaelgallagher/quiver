const { spawn, spawnSync } = require("child_process");
const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const {
  findXcodeProject,
  getScheme,
  findOrBootSimulator,
  findBuiltApp,
  extractBundleId,
  findDeveloperDir,
} = require("./swift-spike-runner");
const { sanitizeFilename } = require("./android-test-generator");
const { assignSubgraphLayout } = require("./layout-ranks");
const { serializeFlow } = require("./flow-serializer");
const { buildViewer } = require("./build-viewer");
const { buildMermaid } = require("./build-mermaid");
const { buildIndex } = require("./build-index");

// os_log subsystem the injected recorder emits under; the host filters the
// simulator's unified log on it (`log stream --predicate 'subsystem == …'`).
const LOG_SUBSYSTEM = "quiver.recorder";
// Marker prefix on each emitted line: "QUIVER_NAV|<screen>|".
const NAV_MARKER = "QUIVER_NAV";
// Let a pushed/presented screen settle before grabbing the screenshot.
const SETTLE_MS = 900;

/**
 * Start an interactive iOS recording session.
 *
 * The iOS sibling of src/android-recorder.js. Injects a viewDidAppear swizzle
 * into the prototype's @main App file that emits the appearing SwiftUI screen's
 * name to the unified log, builds + installs the app on a booted Simulator,
 * launches it, then streams `simctl spawn <udid> log stream` and captures a
 * screenshot via `simctl io <udid> screenshot` on each observed appearance.
 * Press Enter to finish; the same graph + viewer + .flow the Android recorder
 * produces are then assembled.
 *
 * Single-phase: every screen appearance from launch is captured. Screen
 * identity is the SwiftUI view type (a pushed NavigationStack destination is
 * hosted in a UIHostingController whose root view is that destination view), so
 * this works whether or not the prototype uses the typed NavigationStack(path:)
 * pattern the static fast-path needs.
 */
async function startIosRecording({
  prototypePath,
  outputDir,
  name,
  title,
  module: moduleHint,
  open, // eslint-disable-line no-unused-vars -- opening is handled by the CLI
}) {
  const xcodeProject = resolveXcodeProject(prototypePath, moduleHint);
  const isWorkspace = xcodeProject.endsWith(".xcworkspace");
  const projectFlag = isWorkspace ? "-workspace" : "-project";
  console.log(`   Xcode project: ${path.relative(prototypePath, xcodeProject)}`);

  const scheme = getScheme(xcodeProject, projectFlag);
  console.log(`   Scheme: ${scheme}`);

  const appFile = findAppEntryFile(prototypePath);
  console.log(`   App entry: ${path.relative(prototypePath, appFile)}`);

  const simulator = findOrBootSimulator();
  console.log(`   Simulator: ${simulator.name} (${simulator.udid})`);

  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;
  const screenshotsDir = path.join(mapOutputDir, "screenshots");

  // ─── Recording state (declared here so it survives the try/finally) ──
  const nodes = new Map(); // screen id → graph node
  const edges = [];
  const edgeKeys = new Set();
  const mapSteps = []; // .flow steps
  let firstRoute = null;
  let lastRoute = null;
  let stepNumber = 0;

  // Serialises async captures so two fast appearances don't race on screenshot.
  let captureChain = Promise.resolve();

  // Inject the appearance hook; restored in finally.
  const injections = injectRecorderHook(appFile);

  const projectSlug = path.basename(prototypePath).replace(/[^a-zA-Z0-9_-]/g, "-");
  const derivedDataPath = `/tmp/flow-map-recorder-derived-${projectSlug}`;

  let logStream = null;
  let bundleId = null;

  try {
    // 1. Build the app (no test target — it runs for real).
    console.log("   Building app (this may take a few minutes)...");
    const buildResult = spawnSync(
      "xcodebuild",
      [
        "build",
        projectFlag,
        xcodeProject,
        "-scheme",
        scheme,
        "-destination",
        `platform=iOS Simulator,id=${simulator.udid}`,
        "-derivedDataPath",
        derivedDataPath,
        "-quiet",
      ],
      {
        cwd: prototypePath,
        timeout: 600_000,
        encoding: "utf-8",
        env: { ...process.env, DEVELOPER_DIR: findDeveloperDir() },
      },
    );
    if (buildResult.status !== 0) {
      const out = [buildResult.stdout, buildResult.stderr]
        .filter(Boolean)
        .join("\n");
      throw new Error(`xcodebuild build failed:\n${out.slice(-3000)}`);
    }

    // 2. Install.
    const appPath = findBuiltApp(derivedDataPath);
    bundleId = extractBundleId(appPath);
    console.log(`   Bundle ID: ${bundleId}`);
    spawnSync("xcrun", ["simctl", "install", simulator.udid, appPath], {
      encoding: "utf-8",
    });

    // ─── Capture helpers ────────────────────────────────────────────

    // Screenshot the simulator into <id>.png. Returns the node's screenshot
    // fields, or null on failure.
    function grabScreen(id) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `${sanitizeFilename(id)}.png`;
      const destFile = path.join(screenshotsDir, filename);
      const res = spawnSync(
        "xcrun",
        ["simctl", "io", simulator.udid, "screenshot", destFile],
        { encoding: "utf-8", timeout: 15_000 },
      );
      if (res.status !== 0 || !fs.existsSync(destFile) || fs.statSync(destFile).size === 0) {
        console.warn(
          `   ⚠️  screenshot failed for ${id}: ${res.stderr || `status ${res.status}`}`,
        );
        return null;
      }
      const dims = pngDimensions(fs.readFileSync(destFile));
      return {
        screenshot: `screenshots/${filename}`,
        ...(dims ? { screenshotAspectRatio: dims.height / dims.width } : {}),
      };
    }

    function recordNode(node, note = "") {
      nodes.set(node.id, node);
      stepNumber++;
      console.log(`   📸 ${String(stepNumber).padStart(2)}. ${node.id}${note}`);
    }

    // Automatic capture, triggered by a screen appearance event.
    async function onAppear(rawName) {
      const id = rawName;
      if (firstRoute === null) firstRoute = id;

      // Edge from the previously-observed screen (real appearance order).
      if (lastRoute && lastRoute !== id) {
        addEdge(edges, edgeKeys, lastRoute, id);
      }
      lastRoute = id;

      // Capture each unique screen once (matches the web recorder's rule).
      if (nodes.has(id)) return;

      mapSteps.push({ type: "visit", url: id });

      await sleep(SETTLE_MS);
      const shot = grabScreen(id);
      if (!shot) return;
      recordNode({
        id,
        label: nameToLabel(id),
        urlPath: id,
        rawRoute: id,
        hub: null,
        filePath: null,
        type: "screen",
        navArgs: [],
        ...shot,
      });
    }

    // Manual capture (Space): grabs whatever is on screen right now — a
    // fallback for screens the appearance hook can't see (an in-app WKWebView
    // page, a UIKit alert). Consecutive snapshots chain.
    let snapshotCount = 0;
    async function manualCapture() {
      snapshotCount++;
      const id = `snapshot-${snapshotCount}`;
      const shot = grabScreen(id);
      if (!shot) {
        snapshotCount--;
        return;
      }
      recordNode(
        {
          id,
          label: `Snapshot ${snapshotCount}`,
          urlPath: id,
          rawRoute: id,
          hub: null,
          filePath: null,
          type: "screen",
          navArgs: [],
          ...shot,
        },
        " (manual)",
      );
      if (lastRoute && lastRoute !== id) {
        addEdge(edges, edgeKeys, lastRoute, id);
      }
      lastRoute = id;
      mapSteps.push({ type: "snapshot" });
    }

    function queueAppear(rawName) {
      captureChain = captureChain.then(() => onAppear(rawName)).catch(() => {});
    }
    function queueManualCapture() {
      captureChain = captureChain.then(() => manualCapture()).catch(() => {});
    }

    // 3. Start streaming the unified log BEFORE launch (it has no backlog, so a
    //    late start would miss the first screen). Filter to our subsystem.
    logStream = spawn("xcrun", [
      "simctl",
      "spawn",
      simulator.udid,
      "log",
      "stream",
      "--level",
      "info",
      "--style",
      "compact",
      "--predicate",
      `subsystem == "${LOG_SUBSYSTEM}"`,
    ]);
    let buf = "";
    logStream.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const parsed = parseNavLine(line);
        if (parsed) queueAppear(parsed.name);
      }
    });
    await sleep(800); // let the stream attach

    // 4. Launch.
    spawnSync("xcrun", ["simctl", "terminate", simulator.udid, bundleId], {
      encoding: "utf-8",
    });
    const launchResult = spawnSync(
      "xcrun",
      ["simctl", "launch", simulator.udid, bundleId],
      { encoding: "utf-8", timeout: 20_000 },
    );
    if (launchResult.status !== 0) {
      throw new Error(`simctl launch failed: ${launchResult.stderr}`);
    }

    // 5. Record until the user presses Enter.
    console.log(
      `\n   Recording.\n` +
        `     • navigate the app — each new screen is captured automatically\n` +
        `     • press SPACE to capture the current screen (web views, dialogs)\n` +
        `     • press ENTER to finish\n`,
    );
    await awaitFinish(queueManualCapture);

    // 6. Flush any in-flight captures before tearing down.
    console.log(`\n   Finishing captures...`);
    await captureChain;
  } finally {
    if (logStream) logStream.kill();
    // NB: we deliberately do NOT uninstall — it's the user's prototype on their
    // Simulator. The source file is restored so the next normal build is clean.
    restoreInjections(injections);
  }

  // ─── Build the graph (off-device) ──────────────────────────────────
  const graph = { nodes: Array.from(nodes.values()), edges };

  if (graph.nodes.length === 0) {
    console.log(
      `\n   No screens were captured. Did the app navigate, and did the appearance hook inject (see ${path.relative(prototypePath, appFile)})?`,
    );
  } else {
    assignSubgraphLayout({
      nodes: graph.nodes,
      edges: graph.edges,
      primaryStarts: firstRoute ? [{ id: firstRoute, order: 0 }] : [],
      lateralEdgePairs: new Set(),
    });

    console.log(
      `\n   Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
    );
    console.log(`   Building viewer...`);
    await buildViewer(graph, mapOutputDir, true, null, {
      name,
      title: title || path.basename(prototypePath),
      rootOutputDir: name ? outputDir : null,
    });
    console.log(`   Viewer built`);

    buildMermaid(graph, mapOutputDir);
    console.log(`   Mermaid sitemap written`);

    if (name) {
      const meta = {
        name,
        title: title || path.basename(prototypePath),
        updatedAt: new Date().toISOString(),
        mode: "recorded",
        platform: "ios",
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        hasScreenshots: true,
      };
      fs.mkdirSync(mapOutputDir, { recursive: true });
      fs.writeFileSync(
        path.join(mapOutputDir, "meta.json"),
        JSON.stringify(meta, null, 2),
      );
      buildIndex(outputDir);
      console.log(`   Collection index built`);
    }

    console.log(`\n   Flow map: ${path.join(mapOutputDir, "index.html")}`);
  }

  // ─── Save the .flow script ─────────────────────────────────────────
  const flowFilePath = writeFlowFile(prototypePath, name, firstRoute, mapSteps);
  console.log(
    `   Scenario saved: ${path.relative(process.cwd(), flowFilePath)}`,
  );
  console.log(
    `   ${mapSteps.length} steps recorded, ${graph.nodes.length} screens captured.\n`,
  );

  return {
    flowFilePath,
    viewerPath:
      graph.nodes.length > 0 ? path.join(mapOutputDir, "index.html") : null,
  };
}

// ---------------------------------------------------------------------------
// Injection: a viewDidAppear swizzle that emits the SwiftUI screen name
// ---------------------------------------------------------------------------

/**
 * Inject the recorder hook into the prototype's @main App file: (a) a one-line
 * install trigger inside the App struct, and (b) the QuiverRecorder swizzle +
 * helpers appended to the same file (so it compiles without touching Xcode
 * target membership — the same reason the static injector never adds new files).
 * Returns an injections list for restoreInjections. Idempotent.
 */
function injectRecorderHook(appFile) {
  const injections = [];
  const original = fs.readFileSync(appFile, "utf-8");
  if (original.includes("enum QuiverRecorder")) {
    return injections; // leave a prior injection (e.g. interrupted run) in place
  }
  const modified = injectAppearanceHook(original);
  fs.writeFileSync(appFile, modified, "utf-8");
  injections.push({ type: "modify", path: appFile, original });
  console.log(`   Injected appearance hook into ${path.basename(appFile)}`);
  return injections;
}

/**
 * Add `import UIKit`/`import os` (if missing), a `private let _quiverInstall`
 * trigger right after the `struct …: App {` line, and the QuiverRecorder code
 * at the end of the file.
 */
function injectAppearanceHook(source) {
  let out = source;

  // 1. Ensure imports.
  for (const imp of ["import UIKit", "import os"]) {
    if (!new RegExp(`^${imp}\\b`, "m").test(out)) {
      out = addImport(out, imp);
    }
  }

  // 2. Install trigger inside the App struct.
  const appRe = /(struct\s+[A-Za-z_]\w*\s*:\s*App\s*\{)/;
  const m = out.match(appRe);
  if (!m) {
    throw new Error(
      "Could not find a `struct …: App {` declaration to anchor the recorder hook.",
    );
  }
  const insertAt = m.index + m[0].length;
  out =
    out.slice(0, insertAt) +
    `\n    private let _quiverInstall: Void = { QuiverRecorder.install() }()` +
    out.slice(insertAt);

  // 3. Append the recorder implementation.
  out = out.replace(/\s*$/, "\n") + "\n" + QUIVER_RECORDER_SWIFT + "\n";
  return out;
}

/** Insert an import after the last existing top-level import line. */
function addImport(source, importLine) {
  const importRe = /^import\s.+$/gm;
  let lastEnd = -1;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return importLine + "\n" + source;
  return source.slice(0, lastEnd) + "\n" + importLine + source.slice(lastEnd);
}

// The injected Swift. Swizzles UIViewController.viewDidAppear and logs the
// appearing SwiftUI screen's name. cleanTypeName reduces a wrapped SwiftUI type
// string (e.g. "ModifiedContent<HomeView, …>") to its leaf screen name.
const QUIVER_RECORDER_SWIFT = `// ─── Quiver recorder (injected for --record; removed afterwards) ───
import SwiftUI
import os

enum QuiverRecorder {
    private static let log = OSLog(subsystem: "${LOG_SUBSYSTEM}", category: "QUIVER")
    private static var didInstall = false

    static func install() {
        guard !didInstall else { return }
        didInstall = true
        guard
            let original = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.viewDidAppear(_:))),
            let swizzled = class_getInstanceMethod(UIViewController.self, #selector(UIViewController.quiver_viewDidAppear(_:)))
        else { return }
        method_exchangeImplementations(original, swizzled)
    }

    static func emit(for vc: UIViewController) {
        guard let label = screenName(for: vc), !label.isEmpty else { return }
        os_log("${NAV_MARKER}|%{public}@|", log: log, type: .info, label)
    }

    private static func screenName(for vc: UIViewController) -> String? {
        let typeName = String(describing: type(of: vc))
        if typeName.contains("UIHostingController") {
            if let root = Mirror(reflecting: vc).children.first(where: { $0.label == "rootView" })?.value {
                return cleanTypeName(String(reflecting: type(of: root)))
            }
        }
        if vc is UINavigationController || vc is UITabBarController
            || vc is UISplitViewController || vc is UIPageViewController {
            return nil
        }
        return cleanTypeName(typeName)
    }

    private static func cleanTypeName(_ raw: String) -> String {
        let wrappers: Set<String> = [
            "ModifiedContent", "AnyView", "TupleView", "Optional", "Group",
            "EnvironmentReaderView", "ConditionalContent", "LazyView", "EquatableView",
            "UIHostingController", "NavigationStack", "NavigationView", "ZStack",
            "VStack", "HStack", "List", "ScrollView",
        ]
        let tokens = raw.split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == "_" || $0 == ".") })
        for token in tokens {
            let leaf = String(token.split(separator: ".").last ?? token)
            if leaf.isEmpty || leaf.hasPrefix("_") || wrappers.contains(leaf) { continue }
            if let first = leaf.first, first.isUppercase { return leaf }
        }
        return raw
    }
}

extension UIViewController {
    @objc func quiver_viewDidAppear(_ animated: Bool) {
        self.quiver_viewDidAppear(animated) // original (implementations exchanged)
        QuiverRecorder.emit(for: self)
    }
}`;

function restoreInjections(injections) {
  for (const injection of injections.reverse()) {
    try {
      if (injection.type === "create") {
        if (fs.existsSync(injection.path)) fs.unlinkSync(injection.path);
      } else if (injection.type === "modify") {
        fs.writeFileSync(injection.path, injection.original);
      }
    } catch (err) {
      console.warn(`   ⚠️  Failed to restore ${injection.path}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a unified-log line into { name } if it carries a nav marker. */
function parseNavLine(line) {
  const idx = line.indexOf(`${NAV_MARKER}|`);
  if (idx === -1) return null;
  const rest = line.slice(idx + NAV_MARKER.length + 1);
  const sep = rest.indexOf("|");
  const name = (sep === -1 ? rest : rest.slice(0, sep)).trim();
  if (!name || name === "null") return null;
  return { name };
}

/** Find the prototype's @main App source file. */
function findAppEntryFile(prototypePath) {
  const files = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests/**", "**/*UITests/**", "**/build/**", "**/.build/**"],
  });
  for (const f of files) {
    const content = fs.readFileSync(f, "utf-8");
    if (/@main/.test(content) && /struct\s+[A-Za-z_]\w*\s*:\s*App\s*\{/.test(content)) {
      return f;
    }
  }
  throw new Error(
    `Could not find a @main App struct under ${prototypePath}. The recorder needs it to install its appearance hook.`,
  );
}

/**
 * Resolve which Xcode project to drive. With a moduleHint, prefer a project
 * whose path matches it (case-insensitive); otherwise reuse the shared helper.
 */
function resolveXcodeProject(prototypePath, moduleHint) {
  if (moduleHint) {
    const all = [
      ...globSync("*.xcworkspace", { cwd: prototypePath, absolute: true }).filter(
        (w) => !w.includes(".xcodeproj/"),
      ),
      ...globSync("*.xcodeproj", { cwd: prototypePath, absolute: true }),
    ];
    const hit = all.find((p) =>
      path.basename(p).toLowerCase().includes(moduleHint.toLowerCase()),
    );
    if (hit) return hit;
    console.warn(
      `   ⚠️  No Xcode project matched --module "${moduleHint}"; using the default.`,
    );
  }
  return findXcodeProject(prototypePath);
}

function pngDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function addEdge(edges, edgeKeys, source, target) {
  if (source === target) return;
  const key = `${source}|${target}|link`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ source, target, type: "link", label: "" });
}

/** "MessageDetailView" → "Message Detail"; trims a trailing "View"/"Screen". */
function nameToLabel(nameRaw) {
  let n = nameRaw.replace(/(View|Screen|ViewController)$/i, "") || nameRaw;
  return (
    n
      .replace(/[_-]/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || nameRaw
  );
}

function writeFlowFile(prototypePath, name, firstRoute, mapSteps) {
  const scenariosDir = path.join(prototypePath, "scenarios");
  fs.mkdirSync(scenariosDir, { recursive: true });

  const base = name || "recorded";
  let outputFilename = `${base}.flow`;
  let flowFilePath = path.join(scenariosDir, outputFilename);
  if (fs.existsSync(flowFilePath)) {
    let suffix = 2;
    while (fs.existsSync(path.join(scenariosDir, `${base}-${suffix}.flow`))) {
      suffix++;
    }
    outputFilename = `${base}-${suffix}.flow`;
    flowFilePath = path.join(scenariosDir, outputFilename);
  }

  // Drop consecutive duplicate Snapshots (same noise the web recorder strips).
  const deduped = mapSteps.filter(
    (step, i) =>
      !(
        step.type === "snapshot" &&
        i > 0 &&
        mapSteps[i - 1].type === "snapshot"
      ),
  );

  const content = serializeFlow({
    startUrl: firstRoute || "/",
    setupSteps: [],
    mapSteps: deduped,
  });
  fs.writeFileSync(flowFilePath, content, "utf-8");
  return flowFilePath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve when the user presses Enter (or Ctrl-C). While waiting, Space invokes
 * onSpace() for an on-demand capture. Falls back to line-based Enter when stdin
 * isn't a TTY.
 */
function awaitFinish(onSpace) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin });
      rl.question("", () => {
        rl.close();
        resolve();
      });
    });
  }
  return new Promise((resolve) => {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    function onKey(str, key) {
      if (!key) return;
      if (key.name === "return" || (key.ctrl && key.name === "c")) {
        stdin.removeListener("keypress", onKey);
        stdin.setRawMode(false);
        stdin.pause();
        resolve();
      } else if (key.name === "space") {
        onSpace();
      }
    }
    stdin.on("keypress", onKey);
  });
}

module.exports = {
  startIosRecording,
  injectAppearanceHook,
  parseNavLine,
  nameToLabel,
};

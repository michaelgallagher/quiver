const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const {
  findAppModule,
  extractProjectMetadata,
  findDevice,
  getGradlewName,
  findApk,
  adb,
  envWithJavaHome,
  findNavHostFile,
  detectIndent,
  disableAnimations,
  restoreAnimations,
} = require("./kotlin-crawler");
const { canonicalizeRoute } = require("./kotlin-parser");
const { sanitizeFilename } = require("./android-test-generator");
const { assignSubgraphLayout } = require("./layout-ranks");
const { serializeFlow } = require("./flow-serializer");
const { buildViewer } = require("./build-viewer");
const { buildMermaid } = require("./build-mermaid");
const { buildIndex } = require("./build-index");

// The logcat tag the injected hook emits under. Filtering on it keeps the
// host-side stream clean (`adb logcat -s QUIVER:I`).
const LOG_TAG = "QUIVER";
// Marker prefix on each emitted line: "QUIVER_NAV|<route>|<args>".
const NAV_MARKER = "QUIVER_NAV";
// How long to let a screen settle (transition + first frame) before grabbing
// the screencap. Tunable; kept conservative for animated transitions.
const SETTLE_MS = 700;

/**
 * Start an interactive Android recording session.
 *
 * Mirrors the web recorder (src/recorder.js) for the native pipeline: builds
 * and installs the prototype with a navigation-event hook injected, launches
 * it on a connected device/emulator, then watches `adb logcat` and captures a
 * screenshot via `adb exec-out screencap` on each observed navigation. When
 * the user presses Enter, it assembles the same graph + viewer the static
 * Android path produces and saves a replayable `.flow` script.
 *
 * Single-phase: every navigation from launch is captured (no Setup/Map split).
 */
async function startAndroidRecording({
  prototypePath,
  outputDir,
  name,
  title,
  module: moduleHint,
  open, // eslint-disable-line no-unused-vars -- opening is handled by the CLI
}) {
  const appModule = findAppModule(prototypePath, moduleHint);
  console.log(`   App module: ${path.relative(prototypePath, appModule.dir)}`);

  const metadata = extractProjectMetadata(appModule);
  console.log(`   Package: ${metadata.packageName}`);
  console.log(`   MainActivity: ${metadata.mainActivityClass}`);

  const device = findDevice();
  console.log(`   Device: ${device}`);

  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;
  const screenshotsDir = path.join(mapOutputDir, "screenshots");

  // ─── Recording state (declared here so it survives the try/finally) ──
  const nodes = new Map(); // canonical route → graph node
  const edges = [];
  const edgeKeys = new Set();
  const visitOrder = []; // canonical routes in capture order
  const mapSteps = []; // .flow steps
  let firstRoute = null;
  let lastRoute = null;
  let stepNumber = 0;

  // Serialises async captures so two fast navigations don't race on screencap.
  let captureChain = Promise.resolve();

  // Inject the nav-event hook + disable animations; both restored in finally.
  const injections = injectRecorderHook(appModule, metadata);
  const animOriginals = disableAnimations(device);

  let logcat = null;

  try {
    // 1. Build only the debug APK (no androidTest target — we run the app for
    //    real, not under instrumentation).
    console.log("   Building debug APK (this may take a few minutes)...");
    const gradlew = path.join(appModule.projectRoot, getGradlewName());
    const buildResult = spawnSync(gradlew, [":app:assembleDebug"], {
      cwd: appModule.projectRoot,
      timeout: 600_000,
      encoding: "utf-8",
      env: envWithJavaHome(),
    });
    if (buildResult.status !== 0) {
      const out = [buildResult.stdout, buildResult.stderr]
        .filter(Boolean)
        .join("\n");
      throw new Error(
        `Gradle build failed (status ${buildResult.status}):\n${out.slice(-3000)}`,
      );
    }

    // 2. Install + launch.
    const appApk = findApk(appModule, "debug", { test: false });
    console.log(`   App APK: ${path.relative(prototypePath, appApk)}`);
    adb(device, "install", "-r", "-t", appApk);

    adb(device, "logcat", "-c"); // clear backlog so we only see this session
    adb(
      device,
      "shell",
      "am",
      "start",
      "-n",
      `${metadata.applicationId}/${metadata.mainActivityClass}`,
    );

    // ─── Capture handler ────────────────────────────────────────────
    async function onNav(rawRoute) {
      const canon = canonicalizeRoute(rawRoute) || rawRoute;
      if (firstRoute === null) firstRoute = canon;

      // Edge from the previously-observed screen (real navigation order).
      if (lastRoute && lastRoute !== canon) {
        addEdge(edges, edgeKeys, lastRoute, canon);
      }
      lastRoute = canon;

      // Capture each unique screen once (matches the web recorder's rule).
      if (nodes.has(canon)) return;

      // Record the .flow step. Dynamic routes (params stripped by
      // canonicalisation) become Snapshot for robust replay; static routes
      // keep a concrete Visit.
      const isDynamic = canon !== rawRoute;
      mapSteps.push(
        isDynamic
          ? { type: "snapshot" }
          : { type: "visit", url: rawRoute },
      );

      // Settle, then grab the device screen.
      await sleep(SETTLE_MS);
      let png;
      try {
        png = captureScreen(device);
      } catch (err) {
        console.warn(`   ⚠️  screencap failed for ${canon}: ${err.message}`);
        return;
      }

      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `${sanitizeFilename(canon)}.png`;
      fs.writeFileSync(path.join(screenshotsDir, filename), png);

      const dims = pngDimensions(png);
      nodes.set(canon, {
        id: canon,
        label: routeToLabel(canon),
        urlPath: canon,
        rawRoute,
        hub: null,
        filePath: null,
        screenshot: `screenshots/${filename}`,
        type: "screen",
        navArgs: [],
        ...(dims ? { screenshotAspectRatio: dims.height / dims.width } : {}),
      });
      visitOrder.push(canon);

      stepNumber++;
      console.log(`   📸 ${String(stepNumber).padStart(2)}. ${canon}`);
    }

    function queueNav(rawRoute) {
      captureChain = captureChain.then(() => onNav(rawRoute)).catch(() => {});
    }

    // 3. Stream logcat, parse nav markers.
    logcat = spawn("adb", ["-s", device, "logcat", "-s", `${LOG_TAG}:I`]);
    let buf = "";
    logcat.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const parsed = parseNavLine(line);
        if (parsed) queueNav(parsed.route);
      }
    });

    // 4. Record until the user presses Enter.
    console.log(`\n   Recording. Press Enter to finish.\n`);
    await waitForEnter();

    // 5. Flush any in-flight captures before tearing down the device side.
    console.log(`\n   Finishing captures...`);
    await captureChain;
  } finally {
    if (logcat) logcat.kill();
    restoreAnimations(device, animOriginals);
    try {
      adb(device, "uninstall", metadata.applicationId);
    } catch {
      // best-effort — leaving the app installed is harmless
    }
    restoreInjections(injections);
  }

  // ─── Build the graph (off-device) ──────────────────────────────────
  const graph = { nodes: Array.from(nodes.values()), edges };

  if (graph.nodes.length === 0) {
    console.log(
      `\n   No screens were captured. Did the app navigate, and does its NavHost use rememberNavController()?`,
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
        platform: "android",
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
// Injection: NavController.OnDestinationChangedListener that emits to logcat
// ---------------------------------------------------------------------------

/**
 * Inject a DisposableEffect into the prototype's NavHost file that registers
 * an OnDestinationChangedListener emitting `QUIVER_NAV|<route>|<args>` to
 * logcat on each navigation. Returns an injections list for restoreInjections.
 *
 * Unlike the static path this needs no TestHooks singleton or instrumented
 * test — the app runs normally and the host listens to logcat.
 */
function injectRecorderHook(appModule, metadata) {
  const injections = [];
  const pkgPath = metadata.packageName.replace(/\./g, "/");
  const mainJavaRoot = path.join(appModule.dir, "src/main/java", pkgPath);

  const navHostFile = findNavHostFile(mainJavaRoot);
  if (!navHostFile) {
    throw new Error(
      `Could not find a file containing 'rememberNavController()' in ${mainJavaRoot}. ` +
        "The recorder needs this to inject its navigation hook.",
    );
  }

  const original = fs.readFileSync(navHostFile, "utf-8");
  // Idempotent — leave a prior injection (e.g. interrupted run) in place.
  if (original.includes(`"${NAV_MARKER}|"`)) {
    return injections;
  }

  const modified = injectNavRecorderHook(original);
  fs.writeFileSync(navHostFile, modified, "utf-8");
  injections.push({ type: "modify", path: navHostFile, original });
  console.log(
    `   Injected recorder hook into ${path.relative(appModule.dir, navHostFile)}`,
  );

  return injections;
}

/**
 * Insert `import androidx.compose.runtime.DisposableEffect` (if missing) and a
 * DisposableEffect block right after `val navController = rememberNavController()`.
 * Other symbols are fully qualified to avoid further import bookkeeping.
 */
function injectNavRecorderHook(source) {
  let out = source;

  const importNeeded = "import androidx.compose.runtime.DisposableEffect";
  if (!out.includes(importNeeded)) {
    const importLineRe = /^import\s.+$/gm;
    let lastImportEnd = -1;
    let m;
    while ((m = importLineRe.exec(out)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }
    if (lastImportEnd === -1) {
      throw new Error("Could not find an 'import' line to anchor inserts on");
    }
    out = out.slice(0, lastImportEnd) + "\n" + importNeeded + out.slice(lastImportEnd);
  }

  const anchorRe = /(val\s+navController\s*=\s*rememberNavController\([^)]*\)\s*)/;
  const match = out.match(anchorRe);
  if (!match) {
    throw new Error(
      "Could not find `val navController = rememberNavController()` anchor.",
    );
  }
  const insertPoint = match.index + match[0].length;
  const ws = detectIndent(out, match.index);
  const hook =
    `\n${ws}DisposableEffect(navController) {\n` +
    `${ws}    val quiverListener = androidx.navigation.NavController.OnDestinationChangedListener { _, destination, arguments ->\n` +
    `${ws}        val quiverArgs = destination.arguments.keys.mapNotNull { key -> arguments?.get(key)?.let { "$key=$it" } }.joinToString("&")\n` +
    `${ws}        android.util.Log.i("${LOG_TAG}", "${NAV_MARKER}|" + destination.route + "|" + quiverArgs)\n` +
    `${ws}    }\n` +
    `${ws}    navController.addOnDestinationChangedListener(quiverListener)\n` +
    `${ws}    onDispose { navController.removeOnDestinationChangedListener(quiverListener) }\n` +
    `${ws}}\n`;
  out = out.slice(0, insertPoint) + hook + out.slice(insertPoint);

  return out;
}

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

/** Parse a logcat line into { route, args } if it carries a nav marker. */
function parseNavLine(line) {
  const idx = line.indexOf(`${NAV_MARKER}|`);
  if (idx === -1) return null;
  const rest = line.slice(idx + NAV_MARKER.length + 1);
  const sep = rest.indexOf("|");
  const route = (sep === -1 ? rest : rest.slice(0, sep)).trim();
  const args = sep === -1 ? "" : rest.slice(sep + 1).trim();
  if (!route || route === "null") return null;
  return { route, args };
}

/** Grab the full device screen as a PNG buffer via exec-out (no CRLF mangling). */
function captureScreen(device) {
  const res = spawnSync("adb", ["-s", device, "exec-out", "screencap", "-p"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
    const err = res.stderr ? res.stderr.toString() : `status ${res.status}`;
    throw new Error(err);
  }
  return res.stdout;
}

/** Read width/height from a PNG's IHDR chunk. Returns null if not a PNG. */
function pngDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG signature + IHDR: width at byte 16, height at byte 20 (big-endian).
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

/** "message_detail" → "Message Detail"; "familyCarer/trusted" → "Family Carer › Trusted". */
function routeToLabel(route) {
  return route
    .split("/")
    .map((seg) =>
      seg
        .replace(/[_-]/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim(),
    )
    .join(" › ");
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

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

module.exports = { startAndroidRecording, injectNavRecorderHook, parseNavLine };

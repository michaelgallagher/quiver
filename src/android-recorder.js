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
  adbShell,
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
// Marker prefix on each emitted nav line: "QUIVER_NAV|<route>|<args>".
const NAV_MARKER = "QUIVER_NAV";
// Marker prefix emitted by the injected WebView page-load hook:
// "QUIVER_WEB|<url>|". A web page is its own node (real URL = identity) and
// chains off the previously-observed screen, so a linear web-view journey maps
// as launch → page1 → page2 → … instead of fanning out (the old Space bug).
const WEB_MARKER = "QUIVER_WEB";
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
  let lastRoute = null; // last captured node (native or web) — chains the graph
  let lastNativeRoute = null; // last NavController screen — the anchor a web view opens from
  let currentWebSession = null; // identity of the active WebView instance (null = none)
  let stepNumber = 0;

  // Serialises async captures so two fast navigations don't race on screencap.
  let captureChain = Promise.resolve();

  // Inject the nav-event hook + disable animations; both restored in finally.
  const injections = injectRecorderHook(appModule, metadata);
  const animOriginals = disableAnimations(device);
  // Suppress Play Protect's "send this app for a security check" prompt that
  // fires on adb installs of unrecognised apps; restored in finally.
  const verifierOriginal = disableInstallVerification(device);

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
    // -g grants all runtime permissions at install time, so the OS permission
    // dialog (e.g. POST_NOTIFICATIONS on Android 13+) never pops over the first
    // captured screen.
    adb(device, "install", "-r", "-t", "-g", appApk);

    adb(device, "logcat", "-c"); // clear backlog so we only see this session
    adb(
      device,
      "shell",
      "am",
      "start",
      "-n",
      `${metadata.applicationId}/${metadata.mainActivityClass}`,
    );

    // ─── Capture helpers ────────────────────────────────────────────

    // Screencap the device and write it under <id>.png. Returns the node's
    // screenshot fields, or null on failure.
    function grabScreen(id) {
      let png;
      try {
        png = captureScreen(device);
      } catch (err) {
        console.warn(`   ⚠️  screencap failed for ${id}: ${err.message}`);
        return null;
      }
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `${sanitizeFilename(id)}.png`;
      fs.writeFileSync(path.join(screenshotsDir, filename), png);
      const dims = pngDimensions(png);
      return {
        screenshot: `screenshots/${filename}`,
        ...(dims ? { screenshotAspectRatio: dims.height / dims.width } : {}),
      };
    }

    function recordNode(node, note = "") {
      nodes.set(node.id, node);
      visitOrder.push(node.id);
      stepNumber++;
      console.log(`   📸 ${String(stepNumber).padStart(2)}. ${node.id}${note}`);
    }

    // Automatic capture, triggered by a NavController destination change.
    async function onNav(rawRoute) {
      const canon = canonicalizeRoute(rawRoute) || rawRoute;
      if (firstRoute === null) firstRoute = canon;

      // A navigation ends any web-view session and re-anchors to the native
      // layer. Edge from the previous *native* screen — not a web page left
      // over from a web view that was dismissed (closing one fires no
      // navigation, so lastRoute can still point at its last page).
      if (lastNativeRoute && lastNativeRoute !== canon) {
        addEdge(edges, edgeKeys, lastNativeRoute, canon);
      }
      lastRoute = canon;
      lastNativeRoute = canon;
      currentWebSession = null;

      // Capture each unique screen once (matches the web recorder's rule).
      if (nodes.has(canon)) return;

      // Record the .flow step. Dynamic routes (params stripped by
      // canonicalisation) become Snapshot for robust replay; static routes
      // keep a concrete Visit.
      const isDynamic = canon !== rawRoute;
      mapSteps.push(
        isDynamic ? { type: "snapshot" } : { type: "visit", url: rawRoute },
      );

      // Settle, then grab the device screen.
      await sleep(SETTLE_MS);
      const shot = grabScreen(canon);
      if (!shot) return;
      recordNode({
        id: canon,
        label: routeToLabel(canon),
        urlPath: canon,
        rawRoute,
        hub: null,
        filePath: null,
        type: "screen",
        navArgs: [],
        ...shot,
      });
    }

    // Automatic capture of an in-app web-view page, triggered by the injected
    // WebView page-load hook (QUIVER_WEB). Identity is the real URL, and each
    // page chains off the previously-observed screen (native or web) in real
    // visit order, so an N-screen web journey maps as a vertical chain rather
    // than fanning out from the screen the web view opened from.
    async function onWeb(rawUrl, webViewId) {
      const id = normalizeWebUrl(rawUrl);

      // A new WebView instance = a new web-view session. Its first page attaches
      // to the native screen it opened from, not the last page of a previous web
      // view opened from that same screen (dismissing a web view fires no
      // navigation, so lastRoute can still point at the earlier session's page).
      if (webViewId !== currentWebSession) {
        currentWebSession = webViewId;
        if (lastNativeRoute) lastRoute = lastNativeRoute;
      }

      // Edge from the previously-observed screen, then become the current one
      // so the next page chains onto this one (launch → page1 → page2 → …).
      if (lastRoute && lastRoute !== id) {
        addEdge(edges, edgeKeys, lastRoute, id);
      }
      lastRoute = id;

      // Capture each unique page once (matches the web recorder's rule).
      if (nodes.has(id)) return;

      // Web pages aren't native routes — replay them as Snapshot steps.
      mapSteps.push({ type: "snapshot" });

      await sleep(SETTLE_MS);
      const shot = grabScreen(id);
      if (!shot) return;
      recordNode(
        {
          id,
          label: webUrlToLabel(rawUrl),
          urlPath: id,
          rawRoute: rawUrl,
          hub: null,
          filePath: null,
          type: "screen",
          navArgs: [],
          ...shot,
        },
        " (web)",
      );
    }

    // Manual capture (Space): grabs whatever is on screen right now — a
    // fallback for screens neither hook sees (Chrome Custom Tabs, dialogs, or
    // a web view the page-load hook couldn't be injected into). Mirrors the web
    // recorder's "Capture page".
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
      // Chain off the previously-observed screen, then become the current one
      // so consecutive Space snapshots form a chain (snapshot-1 → snapshot-2 →
      // …) instead of all hanging off the screen the journey started from.
      if (lastRoute && lastRoute !== id) {
        addEdge(edges, edgeKeys, lastRoute, id);
      }
      lastRoute = id;
      mapSteps.push({ type: "snapshot" });
    }

    function queueNav(rawRoute) {
      captureChain = captureChain.then(() => onNav(rawRoute)).catch(() => {});
    }
    function queueWeb(rawUrl, webViewId) {
      captureChain = captureChain
        .then(() => onWeb(rawUrl, webViewId))
        .catch(() => {});
    }
    function queueManualCapture() {
      captureChain = captureChain.then(() => manualCapture()).catch(() => {});
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
        const nav = parseNavLine(line);
        if (nav) {
          queueNav(nav.route);
          continue;
        }
        const web = parseWebLine(line);
        if (web) queueWeb(web.url, web.webViewId);
      }
    });

    // 4. Record until the user presses Enter. Space captures the current
    //    screen on demand (web views / overlays the NavController can't see).
    console.log(
      `\n   Recording.\n` +
        `     • navigate the app — each new screen (and in-app web page) is captured automatically\n` +
        `     • press SPACE to capture the current screen (fallback: Custom Tabs, dialogs)\n` +
        `     • press ENTER to finish\n`,
    );
    await awaitFinish(queueManualCapture);

    // 5. Flush any in-flight captures before tearing down the device side.
    console.log(`\n   Finishing captures...`);
    await captureChain;
  } finally {
    if (logcat) logcat.kill();
    restoreAnimations(device, animOriginals);
    restoreInstallVerification(device, verifierOriginal);
    // NB: we deliberately do NOT uninstall — this is the user's own prototype
    // on their own device, and they expect it to stay installed after
    // recording. (The installed build still carries the benign logcat hook;
    // the source file is restored below so the next normal build is clean.)
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

  // Also instrument any WebView so in-app web pages are auto-captured (optional
  // — apps without a WebView simply get nothing here).
  injectWebViewHooks(appModule, injections);

  return injections;
}

/**
 * Inject a logcat emit into every `WebViewClient.onPageFinished` override in the
 * app's main source tree, so each in-app web page load fires a QUIVER_WEB event
 * the host captures. Mutations are recorded in `injections` for restore and are
 * idempotent (a prior injection is left in place).
 */
function injectWebViewHooks(appModule, injections) {
  const mainSrc = path.join(appModule.dir, "src/main");
  if (!fs.existsSync(mainSrc)) return;

  for (const file of walkKtFiles(mainSrc)) {
    const original = fs.readFileSync(file, "utf-8");
    if (!original.includes("override fun onPageFinished")) continue;
    if (original.includes(`"${WEB_MARKER}|"`)) continue; // already injected

    const modified = injectWebViewLog(original);
    if (!modified || modified === original) continue;

    fs.writeFileSync(file, modified, "utf-8");
    injections.push({ type: "modify", path: file, original });
    console.log(
      `   Injected WebView page-load hook into ${path.relative(appModule.dir, file)}`,
    );
  }
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

/**
 * Insert `android.util.Log.i("QUIVER", "QUIVER_WEB|" + <url> + "|" +
 * System.identityHashCode(<webView>))` at the top of every
 * `override fun onPageFinished(...)` body. Returns the modified source, or null
 * if no override was found / no usable URL param.
 *
 * The URL parameter name varies (`loadedUrl`, `url`, …) — we pick the
 * String-typed param; the WebView-typed param supplies the instance id (which
 * lets the host distinguish one web-view session from the next). Symbols are
 * fully qualified so no import bookkeeping is needed.
 */
function injectWebViewLog(source) {
  const re =
    /(^[ \t]*)(override\s+fun\s+onPageFinished\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{)/gm;
  let injected = false;
  const out = source.replace(re, (full, indent, _sig, params) => {
    const urlParam = pickUrlParam(params);
    if (!urlParam) return full;
    const viewParam = pickWebViewParam(params);
    const session = viewParam ? `System.identityHashCode(${viewParam})` : "0";
    injected = true;
    return (
      `${full}\n${indent}    android.util.Log.i(` +
      `"${LOG_TAG}", "${WEB_MARKER}|" + ${urlParam} + "|" + ${session})`
    );
  });
  return injected ? out : null;
}

/** Pick the URL argument name from an onPageFinished param list (the String one). */
function pickUrlParam(params) {
  const parts = splitParams(params);
  if (parts.length === 0) return null;
  const chosen = parts.find((p) => /:\s*String\??/.test(p)) || parts[1] || parts[0];
  const name = chosen.split(":")[0].trim();
  return name || null;
}

/** Pick the WebView argument name from an onPageFinished param list. */
function pickWebViewParam(params) {
  const parts = splitParams(params);
  if (parts.length === 0) return null;
  const chosen = parts.find((p) => /:\s*[\w.]*WebView\??/.test(p)) || parts[0];
  const name = chosen.split(":")[0].trim();
  return name || null;
}

function splitParams(params) {
  return params
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Recursively collect every `.kt` file under `dir`. */
function walkKtFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkKtFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".kt")) {
      out.push(full);
    }
  }
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

/**
 * Parse a web page-load marker line into { url, webViewId }. The id is the
 * emitting WebView's identity hash, used to tell a new web-view session from the
 * next page of the same one. Returns null if the line carries no usable URL.
 */
function parseWebLine(line) {
  const idx = line.indexOf(`${WEB_MARKER}|`);
  if (idx === -1) return null;
  const rest = line.slice(idx + WEB_MARKER.length + 1);
  const parts = rest.split("|");
  const url = (parts[0] || "").trim();
  const webViewId = (parts[1] || "").trim();
  if (!url || url === "null") return null;
  return { url, webViewId };
}

/**
 * Node identity for a web page: the URL minus fragment and trailing slash. The
 * query string is kept (it can distinguish steps in a web flow). Dedups revisits
 * to the same page, mirroring the web recorder.
 */
function normalizeWebUrl(url) {
  const noFragment = url.split("#")[0].replace(/\/+$/, "");
  return noFragment || url;
}

/** "https://111.nhs.uk/triage/start" → "111.nhs.uk › Start"; falls back to the URL. */
function webUrlToLabel(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last) return u.host;
    const pretty = last
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[_-]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    return pretty ? `${u.host} › ${pretty}` : u.host;
  } catch {
    return url;
  }
}

const VERIFIER_KEY = "verifier_verify_adb_installs";

/**
 * Turn off verification of adb installs so Play Protect doesn't prompt
 * "send this app for a security check" on each install. Returns the prior
 * value (or null if unreadable) for restoreInstallVerification.
 */
function disableInstallVerification(device) {
  let original = null;
  try {
    original = adbShell(device, `settings get global ${VERIFIER_KEY}`).trim();
    adbShell(device, `settings put global ${VERIFIER_KEY} 0`);
    console.log(
      `   Disabled adb-install verification for this session (restored on exit)`,
    );
  } catch {
    // Not all devices expose this setting — best effort.
  }
  return original;
}

function restoreInstallVerification(device, original) {
  if (original === null) return;
  try {
    // An unset/"null" prior value means the secure default (on) — restore to 1.
    const value = original === "null" || original === "" ? "1" : original;
    adbShell(device, `settings put global ${VERIFIER_KEY} ${value}`);
  } catch {
    // best-effort
  }
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

/**
 * Resolve when the user presses Enter (or Ctrl-C). While waiting, Space invokes
 * onSpace() for an on-demand capture. Uses raw keypress mode in a TTY; falls
 * back to line-based Enter-to-finish when stdin isn't a TTY (no manual capture).
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
  startAndroidRecording,
  injectNavRecorderHook,
  injectWebViewLog,
  parseNavLine,
  parseWebLine,
  normalizeWebUrl,
  webUrlToLabel,
};

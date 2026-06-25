/**
 * iOS screenshot pipeline using simctl launch-args navigation.
 *
 * Replaces the XCUITest-based crawlAndScreenshotIos() for prototypes that use
 * iOS 16+ NavigationStack(path:). ~18× faster: ~2s per route vs ~36s with XCUITest.
 *
 * Flow:
 *  1. Inject route-handler code into the prototype (idempotent, restored in finally)
 *  2. Build the app (app target only — no test target)
 *  3. Boot or verify a simulator
 *  4. Install the built app
 *  5. For each route: terminate → launch with -quiverRoute <route> → settle → screenshot
 *  6. Attach captured PNGs to graph nodes
 *  7. Cleanup (restore prototype files, uninstall app)
 */

const { execSync, spawnSync } = require("child_process");
const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");
const {
  detectNavigationStackPattern,
  injectQuiverRouteHandler,
} = require("./swift-injector");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} graph - { nodes, edges }
 * @param {object[]} parsedViews - from parseSwiftProject
 * @param {object} options
 * @param {string} options.prototypePath
 * @param {string} options.outputDir
 * @param {number} [options.settleMs=1500] - ms to wait after launch before screenshot
 * @param {object} [options.overrides={}]  - per-node route overrides (currently unused)
 * @returns {object} graph with node.screenshot paths populated
 */
async function crawlAndScreenshotIosFast(graph, parsedViews, options) {
  const {
    prototypePath,
    outputDir,
    settleMs = 1500,
    overrides = {},
  } = options;

  const screenshotsDir = path.join(outputDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Stable DerivedData path per project — enables incremental builds across runs
  const projectSlug = path.basename(prototypePath).replace(/[^a-zA-Z0-9_-]/g, "-");
  const derivedDataPath = `/tmp/flow-map-derived-data-${projectSlug}`;

  // 1. Inject route-handler code
  console.log("   Injecting route-handler code...");
  const { cleanup, routePlan } = injectQuiverRouteHandler(graph, prototypePath, parsedViews);

  let captured = 0;

  try {
    // 2. Find the Xcode project and build
    const xcodeProject = findXcodeProject(prototypePath);
    const isWorkspace = xcodeProject.endsWith(".xcworkspace");
    const projectFlag = isWorkspace ? "-workspace" : "-project";
    console.log(`   Xcode project: ${path.relative(prototypePath, xcodeProject)}`);

    const scheme = getScheme(xcodeProject, projectFlag);
    console.log(`   Scheme: ${scheme}`);

    // 3. Find/boot a simulator
    const simulator = findOrBootSimulator();
    console.log(`   Simulator: ${simulator.name} (${simulator.udid})`);

    console.log("   Building app (no test target)...");
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
        timeout: 300_000,
        encoding: "utf-8",
        env: { ...process.env, DEVELOPER_DIR: findDeveloperDir() },
      },
    );

    if (buildResult.status !== 0) {
      const out = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n");
      throw new Error(`xcodebuild build failed:\n${formatBuildError(out)}`);
    }

    // 4. Find the built .app and extract bundle ID
    const appPath = findBuiltApp(derivedDataPath);
    const bundleId = extractBundleId(appPath);
    console.log(`   Bundle ID: ${bundleId}`);

    // 5. Install
    run("xcrun", ["simctl", "install", simulator.udid, appPath]);
    console.log("   App installed");

    // 6. Screenshot loop
    const totalRoutes = routePlan.allRoutes.length;
    console.log(`   Capturing ${totalRoutes} routes (${settleMs}ms settle)...`);

    for (const { route, nodeId } of routePlan.allRoutes) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      // Apply override if present
      const effectiveRoute = (overrides[nodeId] && overrides[nodeId].route) || route;

      // Terminate any running instance
      spawnSync("xcrun", ["simctl", "terminate", simulator.udid, bundleId], {
        encoding: "utf-8",
      });

      // Launch with route arg
      const launchResult = spawnSync(
        "xcrun",
        [
          "simctl",
          "launch",
          simulator.udid,
          bundleId,
          "-quiverRoute",
          effectiveRoute,
        ],
        { encoding: "utf-8", timeout: 15_000 },
      );

      if (launchResult.status !== 0) {
        console.warn(`   ⚠️  Launch failed for route "${effectiveRoute}": ${launchResult.stderr}`);
        continue;
      }

      // Settle
      await sleep(settleMs);

      // Capture
      const destFile = path.join(screenshotsDir, `${sanitize(nodeId)}.png`);
      const shotResult = spawnSync(
        "xcrun",
        ["simctl", "io", simulator.udid, "screenshot", destFile],
        { encoding: "utf-8", timeout: 10_000 },
      );

      if (shotResult.status === 0 && fs.existsSync(destFile) && fs.statSync(destFile).size > 0) {
        node.screenshot = `screenshots/${sanitize(nodeId)}.png`;
        captured++;
      } else {
        console.warn(`   ⚠️  Screenshot failed for route "${effectiveRoute}"`);
      }
    }

    console.log(`   Captured ${captured} of ${totalRoutes} routes`);

    // Mark native screens that ended up without a screenshot so the map can show
    // them as deliberately "not captured" rather than mysteriously blank. We
    // distinguish screens the route plan never reached (e.g. steps deep inside a
    // NavigationLink chain the launch-args path can't drive) from ones it tried
    // but failed to capture at runtime.
    const plannedNodeIds = new Set();
    for (const r of routePlan.allRoutes) plannedNodeIds.add(r.nodeId);
    for (const r of routePlan.sheetRoutes) plannedNodeIds.add(r.nodeId);
    let unreached = 0;
    for (const node of graph.nodes) {
      if (node.screenshot || node.type !== "screen") continue;
      node.captureStatus = plannedNodeIds.has(node.id) ? "failed" : "unreachable";
      unreached++;
    }
    if (unreached > 0) {
      console.log(`   ${unreached} native screen(s) not captured (marked on the map)`);
    }

    // 7. Uninstall
    try {
      run("xcrun", ["simctl", "uninstall", simulator.udid, bundleId]);
    } catch {
      // non-fatal
    }
  } finally {
    cleanup();
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull the meaningful diagnostics out of xcodebuild output. A failing build's
 * last lines are usually a wall of linker `-o`/`-index-unit-output-path` args,
 * so a plain tail-slice hides the actual `error:`. Collect every `error:` line
 * (Swift/clang/linker) plus its trailing context (the source line + caret, or
 * `note:` lines), and fall back to a tail-slice only if none are found.
 */
function formatBuildError(out) {
  const lines = out.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/(^|:\s|\s)error:/.test(line) || /^(ld|clang|Undefined symbols|duplicate symbol)\b/.test(line)) {
      kept.push(line);
      // Include up to 3 following context lines (source snippet, caret, notes)
      // until the next blank line or the next diagnostic.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].trim() === "" || /(^|:\s|\s)(error|warning):/.test(lines[j])) break;
        kept.push(lines[j]);
      }
    }
  }
  if (kept.length === 0) return out.slice(-3000);
  // De-dupe consecutive repeats (xcodebuild prints some diagnostics twice) and cap length.
  const deduped = kept.filter((l, idx) => l !== kept[idx - 1]);
  return deduped.join("\n").slice(-4000);
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 200);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function findDeveloperDir() {
  const xcodePath = "/Applications/Xcode.app/Contents/Developer";
  if (fs.existsSync(xcodePath)) return xcodePath;
  try {
    const sel = execSync("xcode-select -p", { encoding: "utf-8" }).trim();
    if (sel && fs.existsSync(sel)) return sel;
  } catch {}
  throw new Error("Xcode not found. Install Xcode from the Mac App Store.");
}

function findXcodeProject(prototypePath) {
  const workspaces = globSync("*.xcworkspace", { cwd: prototypePath, absolute: true })
    .filter((w) => !w.includes(".xcodeproj/"));
  if (workspaces.length > 0) return workspaces[0];

  const projects = globSync("*.xcodeproj", { cwd: prototypePath, absolute: true });
  if (projects.length > 0) return projects[0];

  throw new Error(`No Xcode project found in ${prototypePath}`);
}

function getScheme(xcodeProject, projectFlag) {
  const developerDir = findDeveloperDir();
  let out;
  try {
    out = execSync(`xcodebuild -list ${projectFlag} "${xcodeProject}" 2>&1`, {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(`xcodebuild -list failed: ${err.message}`);
  }
  const match = out.match(/Schemes:\n([\s\S]*?)(\n\s*\n|$)/);
  const schemes = match
    ? match[1].split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  if (schemes.length === 0) throw new Error("No schemes found in Xcode project");
  // Prefer a scheme that matches the project name (not UITest or other variants)
  const nonTest = schemes.find((s) => !s.toLowerCase().includes("uitest")) || schemes[0];
  return nonTest;
}

function findOrBootSimulator() {
  const developerDir = findDeveloperDir();
  let devicesJson;
  try {
    devicesJson = execSync("xcrun simctl list devices available --json 2>/dev/null", {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch {
    throw new Error("xcrun simctl failed. Ensure Xcode and iOS Simulator are installed.");
  }

  const { devices } = JSON.parse(devicesJson);
  const iosRuntimes = Object.entries(devices)
    .filter(([k]) => k.toLowerCase().includes("ios"))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));

  // Prefer already-booted iPhone
  for (const [, list] of iosRuntimes) {
    const booted = list.find((d) => d.state === "Booted" && d.name.includes("iPhone") && d.isAvailable);
    if (booted) return booted;
  }

  // Boot the newest available iPhone
  for (const [, list] of iosRuntimes) {
    const available = list.find((d) => d.name.includes("iPhone") && d.isAvailable);
    if (available) {
      console.log(`   Booting simulator ${available.name}...`);
      spawnSync("xcrun", ["simctl", "boot", available.udid], { encoding: "utf-8", timeout: 60_000 });
      spawnSync("xcrun", ["simctl", "bootstatus", available.udid, "-b"], { encoding: "utf-8", timeout: 120_000 });
      return { ...available, state: "Booted" };
    }
  }

  throw new Error("No available iPhone simulator found. Open Xcode → Platforms and install an iOS Simulator.");
}

function findBuiltApp(derivedDataPath) {
  const apps = globSync("Build/Products/Debug-iphonesimulator/*.app", {
    cwd: derivedDataPath,
    absolute: true,
  }).filter((p) => {
    const name = path.basename(p);
    return !name.endsWith(".appex") && !name.includes("UITests") && !name.includes("Tests-Runner");
  });

  if (apps.length > 0) return apps[0];
  throw new Error(`No built .app found in ${derivedDataPath}/Build/Products/Debug-iphonesimulator/`);
}

function extractBundleId(appPath) {
  try {
    return execSync(`plutil -extract CFBundleIdentifier raw "${appPath}/Info.plist"`, {
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    throw new Error(`Could not extract bundle ID from ${appPath}: ${err.message}`);
  }
}

module.exports = {
  crawlAndScreenshotIosFast,
  detectNavigationStackPattern,
  // Shared host-side helpers reused by the iOS recorder (src/ios-recorder.js).
  findXcodeProject,
  getScheme,
  findOrBootSimulator,
  findBuiltApp,
  extractBundleId,
  findDeveloperDir,
  formatBuildError,
  sanitize,
  run,
};

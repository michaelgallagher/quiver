const { execSync, spawnSync } = require("child_process");
const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");
const { generateAndroidTest, sanitizeFilename } = require("./android-test-generator");

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Capture screenshots of every reachable Compose screen by:
 *  1. Finding the Gradle app module, MainActivity, and a running device.
 *  2. Generating a temporary QuiverCapture.kt that navigates each screen
 *     programmatically via TestHooks.navController and captures via Compose.
 *  3. Auto-injecting TestHooks.kt + a LaunchedEffect hook into AppNavigation.kt
 *     if the prototype doesn't already have them.
 *  4. Building, installing, instrumenting, pulling PNGs off the device,
 *     uninstalling. This sequence is used instead of connectedDebugAndroidTest
 *     because that gradle task uninstalls before we can pull screenshots.
 *  5. Restoring all injected files and animation settings in a finally block.
 *
 * @returns The graph with node.screenshot paths set where captures succeeded.
 */
async function crawlAndScreenshotAndroid(graph, options) {
  const { prototypePath, outputDir, overrides } = options;

  // 1. Locate app module + gradle project root
  const appModule = findAppModule(prototypePath);
  console.log(`   App module: ${path.relative(prototypePath, appModule.dir)}`);

  // 2. Extract metadata (package + main activity)
  const metadata = extractProjectMetadata(appModule);
  console.log(`   Package: ${metadata.packageName}`);
  if (metadata.applicationId !== metadata.packageName) {
    console.log(`   Application ID: ${metadata.applicationId}`);
  }
  console.log(`   MainActivity: ${metadata.mainActivityClass}`);

  // 3. Find a running adb device
  const device = findDevice();
  console.log(`   Device: ${device}`);

  // 4. Generate test source
  const testContent = generateAndroidTest(
    graph,
    metadata.packageName,
    metadata.mainActivityClass,
    overrides || {},
  );
  if (!testContent) {
    console.log("   No navigable screens found — skipping screenshots");
    return graph;
  }

  const methodCount = (testContent.match(/@Test/g) || []).length;
  console.log(`   Generated ${methodCount} screenshot tests`);

  fs.mkdirSync(outputDir, { recursive: true });
  const debugLogPath = path.join(outputDir, "generated-android-test.kt");
  fs.writeFileSync(debugLogPath, testContent, "utf-8");
  console.log(`   Generated test written to: ${path.relative(process.cwd(), debugLogPath)}`);

  // 5. Inject files (track so we can restore)
  const injections = injectFiles(appModule, metadata, testContent);

  // 6. Disable animations (track for restore)
  const animOriginals = disableAnimations(device);

  let captured = 0;
  try {
    // 7. Build APKs
    console.log("   Building APKs (this may take a few minutes)...");
    const gradlew = path.join(appModule.projectRoot, getGradlewName());
    const buildResult = spawnSync(
      gradlew,
      [":app:assembleDebug", ":app:assembleDebugAndroidTest"],
      {
        cwd: appModule.projectRoot,
        timeout: 600_000,
        encoding: "utf-8",
        env: envWithJavaHome(),
      },
    );
    if (buildResult.status !== 0) {
      const out = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n");
      throw new Error(`Gradle build failed (status ${buildResult.status}):\n${out.slice(-3000)}`);
    }

    // 8. Locate APKs
    const appApk = findApk(appModule, "debug", { test: false });
    const testApk = findApk(appModule, "debug", { test: true });
    console.log(`   App APK:  ${path.relative(prototypePath, appApk)}`);
    console.log(`   Test APK: ${path.relative(prototypePath, testApk)}`);

    // 9. Install
    adb(device, "install", "-r", "-t", appApk);
    adb(device, "install", "-r", "-t", testApk);

    // 10. Run instrumentation (uses applicationId — that's what the test APK targets)
    console.log("   Running instrumented tests...");
    const instrumentResult = runInstrumentation(device, metadata.applicationId, metadata.packageName);

    // Surface flow-map log lines
    const diagLines = (instrumentResult.stdout || "")
      .split("\n")
      .filter((l) => l.includes("QuiverCapture"));
    if (diagLines.length > 0) {
      console.log("   Test output highlights:");
      diagLines.slice(0, 10).forEach((l) => console.log(`     ${l.trim()}`));
    }

    // 11. Pull screenshots off the device before uninstall wipes them
    const screenshotsDir = path.join(outputDir, "screenshots");
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const deviceDir = `/sdcard/Android/data/${metadata.applicationId}/cache/flow-map/`;
    spawnSync("adb", ["-s", device, "pull", deviceDir, screenshotsDir], {
      encoding: "utf-8",
    });

    // Pull puts files in screenshots/flow-map/ — flatten
    const pulledDir = path.join(screenshotsDir, "flow-map");
    if (fs.existsSync(pulledDir)) {
      for (const f of fs.readdirSync(pulledDir)) {
        fs.renameSync(path.join(pulledDir, f), path.join(screenshotsDir, f));
      }
      fs.rmdirSync(pulledDir);
    }

    // 12. Attach to graph nodes
    for (const node of graph.nodes) {
      if (node.type !== "screen") continue;
      const filename = `${sanitizeFilename(node.id)}.png`;
      const filePath = path.join(screenshotsDir, filename);
      if (fs.existsSync(filePath)) {
        node.screenshot = `screenshots/${filename}`;
        captured++;
      }
    }
    console.log(`   Captured ${captured} of ${methodCount} screens`);
  } finally {
    // 13. Uninstall (best-effort) — by applicationId, which is what's installed
    try { adb(device, "uninstall", `${metadata.applicationId}.test`); } catch {}
    try { adb(device, "uninstall", metadata.applicationId); } catch {}

    // 14. Restore animations
    restoreAnimations(device, animOriginals);

    // 15. Restore injected files (reverse order)
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

  return graph;
}

// ---------------------------------------------------------------------------
// Module / gradle discovery
// ---------------------------------------------------------------------------

/**
 * Find the Android application module (contains the android.application plugin).
 * Returns { dir, projectRoot }.
 */
function findAppModule(prototypePath) {
  // Find all build.gradle / build.gradle.kts files
  const gradleFiles = globSync("**/build.gradle*", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/node_modules/**", "**/build/**"],
  });

  // Match the android.application plugin being APPLIED (not declared with `apply false`).
  // Root project gradle files typically use `alias(...) apply false`, which should be skipped.
  const candidates = gradleFiles.filter((f) => {
    try {
      const content = fs.readFileSync(f, "utf-8");
      const lines = content.split("\n");
      return lines.some((line) => {
        const matches = /(?:id\s*\(\s*["']com\.android\.application["']|alias\s*\(\s*libs\.plugins\.android\.application)/.test(line);
        return matches && !/\bapply\s+false\b/.test(line);
      });
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) {
    throw new Error(
      `No Android application module found in ${prototypePath}. ` +
        "Looked for build.gradle[.kts] with the com.android.application plugin.",
    );
  }

  if (candidates.length > 1) {
    console.warn(
      `   ⚠️  Multiple Android application modules found; using the first: ${candidates[0]}`,
    );
  }

  const dir = path.dirname(candidates[0]);

  // Walk up looking for gradlew (the project root)
  let projectRoot = dir;
  while (projectRoot !== path.dirname(projectRoot)) {
    if (fs.existsSync(path.join(projectRoot, "gradlew"))) break;
    projectRoot = path.dirname(projectRoot);
  }

  if (!fs.existsSync(path.join(projectRoot, "gradlew"))) {
    throw new Error(
      `Could not locate gradlew walking up from ${dir}. Is this a Gradle project?`,
    );
  }

  return { dir, projectRoot };
}

/**
 * Parse metadata from the module. Returns:
 *   - packageName: namespace (Kotlin package for source files)
 *   - applicationId: runtime install identity (defaults to namespace if absent)
 *   - mainActivityClass / mainActivitySimpleName: launcher activity
 *
 * Note: `namespace` and `applicationId` are often the same but can diverge.
 * `namespace` is for code paths (imports, src dirs, generated test source).
 * `applicationId` is what the OS sees: `pm install`, `/sdcard/Android/data/<appId>/`,
 * and the instrumentation target `<appId>.test/<runner>`.
 */
function extractProjectMetadata(appModule) {
  // 1. Parse namespace + applicationId from build.gradle(.kts)
  const gradleKts = path.join(appModule.dir, "build.gradle.kts");
  const gradleGroovy = path.join(appModule.dir, "build.gradle");
  const gradlePath = fs.existsSync(gradleKts) ? gradleKts : gradleGroovy;
  const gradleSrc = fs.readFileSync(gradlePath, "utf-8");
  const nsMatch = gradleSrc.match(/namespace\s*=\s*["']([^"']+)["']/);
  if (!nsMatch) {
    throw new Error(`Could not find 'namespace' in ${gradlePath}`);
  }
  const packageName = nsMatch[1];
  const appIdMatch = gradleSrc.match(/applicationId\s*=\s*["']([^"']+)["']/);
  const applicationId = appIdMatch ? appIdMatch[1] : packageName;

  // 2. Find MAIN activity in AndroidManifest.xml
  const manifestPath = path.join(appModule.dir, "src/main/AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`AndroidManifest.xml not found at ${manifestPath}`);
  }
  const manifestSrc = fs.readFileSync(manifestPath, "utf-8");

  // Find the <activity> element containing an intent-filter with action.MAIN
  const activityRe = /<activity\b([^>]*)>([\s\S]*?)<\/activity>/g;
  let m, mainActivityRaw = null;
  while ((m = activityRe.exec(manifestSrc)) !== null) {
    if (m[2].includes("android.intent.action.MAIN")) {
      const nameMatch = m[1].match(/android:name\s*=\s*"([^"]+)"/);
      if (nameMatch) { mainActivityRaw = nameMatch[1]; break; }
    }
  }
  if (!mainActivityRaw) {
    throw new Error("Could not find MAIN activity in AndroidManifest.xml");
  }

  // Resolve relative class name: ".MainActivity" → "<pkg>.MainActivity"
  // Activity classes live under the namespace (not applicationId).
  const mainActivityClass = mainActivityRaw.startsWith(".")
    ? packageName + mainActivityRaw
    : mainActivityRaw.includes(".")
      ? mainActivityRaw
      : `${packageName}.${mainActivityRaw}`;

  const mainActivitySimpleName = mainActivityClass.split(".").pop();

  return { packageName, applicationId, mainActivityClass, mainActivitySimpleName };
}

function getGradlewName() {
  return process.platform === "win32" ? "gradlew.bat" : "gradlew";
}

function findApk(appModule, buildType, { test }) {
  const subpath = test
    ? `build/outputs/apk/androidTest/${buildType}`
    : `build/outputs/apk/${buildType}`;
  const dir = path.join(appModule.dir, subpath);
  const apks = globSync("*.apk", { cwd: dir, absolute: true });
  if (apks.length === 0) {
    throw new Error(`No APK found in ${dir}`);
  }
  return apks[0];
}

// ---------------------------------------------------------------------------
// Device / adb
// ---------------------------------------------------------------------------

function findDevice() {
  const requested = process.env.ANDROID_SERIAL;
  let devices = listAttachedDevices();

  if (devices.length === 0) {
    if (requested) {
      throw new Error(
        `ANDROID_SERIAL=${requested} requested but no devices are attached.`,
      );
    }
    const booted = bootEmulator();
    if (!booted) {
      throw new Error(
        "No Android device attached and no AVDs available. Boot an emulator or plug in a device and try again.",
      );
    }
    devices = listAttachedDevices();
    if (devices.length === 0) {
      throw new Error(
        "Started an emulator but it never appeared in `adb devices`. Boot one manually and retry.",
      );
    }
  }

  if (requested) {
    const match = devices.find((d) => d.serial === requested);
    if (!match) {
      throw new Error(
        `ANDROID_SERIAL=${requested} not found among attached devices: ${devices.map((d) => d.serial).join(", ")}`,
      );
    }
    return match.serial;
  }

  return devices[0].serial;
}

function listAttachedDevices() {
  let listing;
  try {
    listing = execSync("adb devices", { encoding: "utf-8", timeout: 10_000 });
  } catch (err) {
    throw new Error(`adb devices failed: ${err.message}`);
  }
  return listing
    .split("\n")
    .slice(1) // skip header line
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    })
    .filter((d) => d.state === "device");
}

function findEmulatorBinary() {
  const sdk = resolveAndroidSdk();
  if (!sdk) return null;
  const bin = path.join(sdk, "emulator", "emulator");
  return fs.existsSync(bin) ? bin : null;
}

function pickAvd(emulatorBin) {
  const out = execSync(`"${emulatorBin}" -list-avds`, { encoding: "utf-8", timeout: 10_000 });
  const avds = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (avds.length === 0) return null;
  const preferred = process.env.ANDROID_AVD;
  if (preferred && avds.includes(preferred)) return preferred;
  if (avds.includes("Pixel_9")) return "Pixel_9";
  return avds[0];
}

function bootEmulator() {
  const emulatorBin = findEmulatorBinary();
  if (!emulatorBin) {
    console.log("   ⚠️  Android SDK emulator binary not found (checked ANDROID_HOME, ANDROID_SDK_ROOT, ~/Library/Android/sdk).");
    return false;
  }
  const avd = pickAvd(emulatorBin);
  if (!avd) {
    console.log("   ⚠️  No AVDs configured. Create one in Android Studio first.");
    return false;
  }
  console.log(`   No device attached — booting AVD: ${avd}`);
  const { spawn } = require("child_process");
  const proc = spawn(emulatorBin, ["-avd", avd, "-no-snapshot-save"], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  // Wait for the device to register with adb.
  try {
    execSync("adb wait-for-device", { timeout: 180_000, stdio: "ignore" });
  } catch (err) {
    console.log(`   ⚠️  adb wait-for-device timed out: ${err.message}`);
    return false;
  }

  // Wait for boot completion (sys.boot_completed=1). Polls up to ~3 minutes.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const res = execSync("adb shell getprop sys.boot_completed", {
        encoding: "utf-8", timeout: 5_000,
      }).trim();
      if (res === "1") {
        console.log(`   Emulator ${avd} ready.`);
        return true;
      }
    } catch {
      // device not ready yet
    }
    execSync("sleep 2");
  }
  console.log("   ⚠️  Emulator booted but sys.boot_completed never became 1.");
  return false;
}

function adb(device, ...args) {
  const result = spawnSync("adb", ["-s", device, ...args], { encoding: "utf-8", timeout: 120_000 });
  if (result.status !== 0) {
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`adb ${args.join(" ")} failed:\n${out}`);
  }
  return result.stdout || "";
}

function adbShell(device, shellCmd) {
  return adb(device, "shell", shellCmd);
}

function runInstrumentation(device, applicationId, namespace) {
  // The test class FQN uses the namespace (that's the package declaration in the
  // generated Kotlin source). The instrumentation target uses the applicationId
  // (that's the installed test APK's package, which is `<applicationId>.test`).
  const testClass = namespace || applicationId;
  const result = spawnSync(
    "adb",
    [
      "-s", device,
      "shell", "am", "instrument", "-w",
      "-e", "class", `${testClass}.QuiverCapture`,
      `${applicationId}.test/androidx.test.runner.AndroidJUnitRunner`,
    ],
    { encoding: "utf-8", timeout: 1_200_000 },
  );
  if (result.status !== 0) {
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`am instrument failed:\n${out.slice(-3000)}`);
  }
  // `am instrument` returns 0 even on test failure; scan output for FAILURES!!!
  const stdout = result.stdout || "";
  if (/FAILURES!!!|Process crashed/.test(stdout)) {
    console.warn("   ⚠️  Some tests failed — partial captures expected");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

const ANIM_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

function disableAnimations(device) {
  const originals = {};
  for (const key of ANIM_KEYS) {
    try {
      originals[key] = adbShell(device, `settings get global ${key}`).trim() || "1";
      adbShell(device, `settings put global ${key} 0`);
    } catch {
      // Not all devices support settings put — ignore.
    }
  }
  return originals;
}

function restoreAnimations(device, originals) {
  for (const [key, val] of Object.entries(originals)) {
    try { adbShell(device, `settings put global ${key} ${val}`); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Java / gradle env
// ---------------------------------------------------------------------------

function envWithJavaHome() {
  const env = { ...process.env };
  const javaHome = resolveJavaHome();
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${javaHome}/bin:${process.env.PATH || ""}`;
  }
  const sdk = resolveAndroidSdk();
  if (sdk) {
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
  }
  return env;
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  // Try Android Studio's bundled JDK on macOS
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/Applications/Android Studio.app/Contents/jre/Contents/Home",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(require("os").homedir(), "Library/Android/sdk"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "platform-tools"))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File injection: TestHooks.kt + AppNavigation.kt hook line
// ---------------------------------------------------------------------------

function injectFiles(appModule, metadata, testContent) {
  const injections = [];
  const pkgPath = metadata.packageName.replace(/\./g, "/");
  const mainJavaRoot = path.join(appModule.dir, "src/main/java", pkgPath);
  const testJavaRoot = path.join(appModule.dir, "src/androidTest/java", pkgPath);

  // 1. TestHooks.kt
  const testHooksPath = path.join(mainJavaRoot, "navigation/TestHooks.kt");
  if (!fs.existsSync(testHooksPath)) {
    fs.mkdirSync(path.dirname(testHooksPath), { recursive: true });
    fs.writeFileSync(testHooksPath, testHooksSource(metadata.packageName), "utf-8");
    injections.push({ type: "create", path: testHooksPath });
    console.log(`   Injected TestHooks.kt`);
  }

  // 2. AppNavigation.kt hook line (find any .kt file declaring `val navController = rememberNavController()`)
  const navHostFile = findNavHostFile(mainJavaRoot);
  if (!navHostFile) {
    throw new Error(
      `Could not find a file containing 'rememberNavController()' in ${mainJavaRoot}. ` +
        "The tool needs this to inject the TestHooks hook line.",
    );
  }
  const navHostOriginal = fs.readFileSync(navHostFile, "utf-8");
  if (!navHostOriginal.includes("TestHooks.navController = navController")) {
    const modified = injectNavHook(navHostOriginal, metadata.packageName);
    fs.writeFileSync(navHostFile, modified, "utf-8");
    injections.push({ type: "modify", path: navHostFile, original: navHostOriginal });
    console.log(`   Injected TestHooks hook into ${path.relative(appModule.dir, navHostFile)}`);
  }

  // 3. QuiverCapture.kt (always overwrite, always delete afterwards)
  const flowMapCapturePath = path.join(testJavaRoot, "QuiverCapture.kt");
  if (fs.existsSync(flowMapCapturePath)) {
    const backup = fs.readFileSync(flowMapCapturePath, "utf-8");
    injections.push({ type: "modify", path: flowMapCapturePath, original: backup });
  } else {
    fs.mkdirSync(path.dirname(flowMapCapturePath), { recursive: true });
    injections.push({ type: "create", path: flowMapCapturePath });
  }
  fs.writeFileSync(flowMapCapturePath, testContent, "utf-8");

  return injections;
}

function testHooksSource(packageName) {
  return `package ${packageName}.navigation

// Auto-generated by quiver. Removed automatically after the run.

import androidx.annotation.VisibleForTesting
import androidx.navigation.NavHostController

@VisibleForTesting
object TestHooks {
    var navController: NavHostController? = null
}
`;
}

function findNavHostFile(mainJavaRoot) {
  const ktFiles = globSync("**/*.kt", { cwd: mainJavaRoot, absolute: true });
  for (const f of ktFiles) {
    const content = fs.readFileSync(f, "utf-8");
    if (content.includes("rememberNavController()") && content.includes("NavHost")) {
      return f;
    }
  }
  return null;
}

/**
 * Insert:
 *   import <pkg>.navigation.TestHooks
 *   import androidx.compose.runtime.LaunchedEffect (if not present)
 *   LaunchedEffect(navController) { TestHooks.navController = navController }
 *
 * Anchor for the hook line: the line containing `rememberNavController()`.
 * Import anchor: after the last existing `import` line.
 */
function injectNavHook(source, packageName) {
  let out = source;

  // Ensure imports are present
  const importsNeeded = [
    `import ${packageName}.navigation.TestHooks`,
    `import androidx.compose.runtime.LaunchedEffect`,
  ];
  const missingImports = importsNeeded.filter((imp) => !out.includes(imp));
  if (missingImports.length > 0) {
    // Insert after the last import line
    const importLineRe = /^import\s.+$/gm;
    let lastImportEnd = -1;
    let m;
    while ((m = importLineRe.exec(out)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }
    if (lastImportEnd === -1) {
      throw new Error("Could not find any existing 'import' line to anchor inserts on");
    }
    const insertion = "\n" + missingImports.join("\n");
    out = out.slice(0, lastImportEnd) + insertion + out.slice(lastImportEnd);
  }

  // Insert the LaunchedEffect immediately after `val navController = rememberNavController()`
  const anchorRe = /(val\s+navController\s*=\s*rememberNavController\([^)]*\)\s*)/;
  const match = out.match(anchorRe);
  if (!match) {
    throw new Error(
      "Could not find `val navController = rememberNavController()` anchor. " +
        "Update injectNavHook to handle this file's naming.",
    );
  }
  const insertPoint = match.index + match[0].length;
  const leadingWs = detectIndent(out, match.index);
  const hookLine = `\n${leadingWs}LaunchedEffect(navController) { TestHooks.navController = navController }\n`;
  out = out.slice(0, insertPoint) + hookLine + out.slice(insertPoint);

  return out;
}

function detectIndent(source, anchorIdx) {
  // Walk back to start of line
  let i = anchorIdx;
  while (i > 0 && source[i - 1] !== "\n") i--;
  let j = i;
  while (j < source.length && (source[j] === " " || source[j] === "\t")) j++;
  return source.slice(i, j);
}

module.exports = { crawlAndScreenshotAndroid };

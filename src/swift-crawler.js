const { execSync, spawnSync } = require("child_process");
const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");
const { generateXCUITest, sanitizeFilename } = require("./xctest-generator");

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Capture screenshots of every reachable SwiftUI screen by:
 *  1. Finding the Xcode project, UITest target, and a simulator.
 *  2. Generating a temporary XCUITest file that navigates and screenshots each view.
 *  3. Overwriting the project's existing UITest file with the generated one,
 *     running xcodebuild test, then restoring the original.
 *  4. Collecting the written PNGs and attaching them to graph nodes.
 *
 * @returns The graph with node.screenshot paths set where captures succeeded.
 */
async function crawlAndScreenshotIos(graph, options) {
  const { prototypePath, outputDir, overrides } = options;

  const developerDir = findDeveloperDir();
  const screenshotsOutputDir = path.join(outputDir, "screenshots");
  const tempDir = `/tmp/flow-map-ios-${Date.now()}`;
  // Stable DerivedData path per project — enables incremental builds across runs
  const projectSlug = path.basename(prototypePath).replace(/[^a-zA-Z0-9_-]/g, "-");
  const derivedDataPath = `/tmp/flow-map-derived-data-${projectSlug}`;

  // 1. Locate the Xcode project
  const xcodeProject = findXcodeProject(prototypePath);
  const isWorkspace = xcodeProject.endsWith(".xcworkspace");
  const projectFlag = isWorkspace ? "-workspace" : "-project";
  console.log(`   Xcode project: ${path.relative(prototypePath, xcodeProject)}`);

  // 2. Get scheme and UITest target name from xcodebuild -list
  const { scheme, uitestTarget } = getProjectInfo(
    xcodeProject,
    projectFlag,
    developerDir,
  );
  console.log(`   Scheme: ${scheme}  UITest target: ${uitestTarget}`);

  // 3. Find the UITest Swift file to temporarily replace
  const uitestFile = findUITestFile(prototypePath, uitestTarget);
  console.log(`   UITest file: ${path.relative(prototypePath, uitestFile)}`);

  // 4. Find an available simulator
  const simulator = findSimulator(developerDir);
  console.log(`   Simulator: ${simulator.name} (${simulator.udid})`);

  // 5. Generate the XCUITest content
  const testContent = generateXCUITest(graph, tempDir, overrides || {});
  if (!testContent) {
    console.log("   No navigable screens found — skipping screenshots");
    return graph;
  }

  // Count generated test methods as a progress indicator
  const methodCount = (testContent.match(/func testCapture_/g) || []).length;
  console.log(`   Generated ${methodCount} screenshot tests`);

  // Write generated test content to a log file for debugging
  const debugLogPath = path.join(outputDir, "generated-xcuitest.swift");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(debugLogPath, testContent, "utf-8");
  console.log(`   Generated test written to: ${path.relative(process.cwd(), debugLogPath)}`);

  // 6. Back up the existing UITest file, write the generated one
  const originalContent = fs.readFileSync(uitestFile, "utf-8");
  const xcodebuildEnv = { ...process.env, DEVELOPER_DIR: developerDir };

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    fs.writeFileSync(uitestFile, testContent, "utf-8");

    // 7. Run xcodebuild test
    console.log("   Building and running tests (this may take a few minutes)...");
    const result = spawnSync(
      "xcodebuild",
      [
        "test",
        projectFlag,
        xcodeProject,
        "-scheme",
        scheme,
        "-destination",
        `platform=iOS Simulator,id=${simulator.udid}`,
        `-only-testing:${uitestTarget}/QuiverCapture`,
        "-derivedDataPath",
        derivedDataPath,
        "-quiet",
      ],
      {
        env: xcodebuildEnv,
        timeout: 1_200_000, // 20 minutes
        encoding: "utf-8",
      },
    );

    const xcodebuildOutput = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    // Always surface flow-map diagnostic lines (tap failures, captures)
    const diagLines = xcodebuildOutput
      .split("\n")
      .filter((l) => l.includes("[flow-map]"));
    if (diagLines.length > 0) {
      console.log("   Tap diagnostics:");
      diagLines.forEach((l) => console.log(`     ${l.trim()}`));
    }

    if (result.error) {
      // Process-level error (e.g. timeout, ENOENT)
      console.warn(`   ⚠️  xcodebuild process error: ${result.error.message}`);
      console.error(xcodebuildOutput.slice(-3000));
    } else if (result.status !== 0 && result.status !== null) {
      console.warn(`   ⚠️  xcodebuild exited with status ${result.status}`);
      console.error(xcodebuildOutput.slice(-3000));
    }
  } finally {
    // Always restore the original UITest file
    fs.writeFileSync(uitestFile, originalContent, "utf-8");
  }

  // 8. Collect screenshots and attach to graph nodes
  fs.mkdirSync(screenshotsOutputDir, { recursive: true });
  let captured = 0;

  for (const node of graph.nodes) {
    const fileId = sanitizeFilename(node.id);
    const srcPath = path.join(tempDir, `${fileId}.png`);
    if (fs.existsSync(srcPath)) {
      const destFilename = `${fileId}.png`;
      fs.copyFileSync(srcPath, path.join(screenshotsOutputDir, destFilename));
      node.screenshot = `screenshots/${destFilename}`;
      captured++;
    }
  }

  // Log temp dir contents when nothing was captured (diagnosis)
  if (captured === 0 && fs.existsSync(tempDir)) {
    const tmpFiles = fs.readdirSync(tempDir);
    if (tmpFiles.length > 0) {
      console.log(`   Temp dir has ${tmpFiles.length} file(s): ${tmpFiles.slice(0, 5).join(", ")}`);
    } else {
      console.log(`   Temp dir exists but is empty — tests ran but wrote no files`);
    }
  } else if (captured === 0) {
    console.log(`   Temp dir was never created — tests may not have run`);
  }

  // Clean up temp dir
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(
    `   Captured ${captured} of ${graph.nodes.filter((n) => n.type === "screen").length} screens`,
  );
  return graph;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the Xcode developer directory.
 * Prefers a full Xcode.app install over Command Line Tools.
 */
function findDeveloperDir() {
  const xcodePath = "/Applications/Xcode.app/Contents/Developer";
  if (fs.existsSync(xcodePath)) return xcodePath;

  try {
    const selected = execSync("xcode-select -p", {
      encoding: "utf-8",
    }).trim();
    if (selected && fs.existsSync(selected)) return selected;
  } catch {
    // ignore
  }

  throw new Error(
    "Xcode not found. Install Xcode from the Mac App Store and try again.",
  );
}

/**
 * Locate the .xcworkspace or .xcodeproj in the project root.
 * Prefers .xcworkspace (used by CocoaPods / Swift Package Manager).
 */
function findXcodeProject(prototypePath) {
  const workspaces = globSync("*.xcworkspace", {
    cwd: prototypePath,
    absolute: true,
  }).filter((w) => !w.includes(".xcodeproj/"));

  if (workspaces.length > 0) return workspaces[0];

  const projects = globSync("*.xcodeproj", {
    cwd: prototypePath,
    absolute: true,
  });

  if (projects.length > 0) return projects[0];

  throw new Error(
    `No Xcode project found in ${prototypePath}. Make sure you're pointing at the project root.`,
  );
}

/**
 * Run xcodebuild -list to extract the default scheme and UITest target name.
 */
function getProjectInfo(xcodeProject, projectFlag, developerDir) {
  let listOutput;
  try {
    listOutput = execSync(
      `xcodebuild -list ${projectFlag} "${xcodeProject}" 2>&1`,
      {
        env: { ...process.env, DEVELOPER_DIR: developerDir },
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
  } catch (err) {
    throw new Error(`xcodebuild -list failed: ${err.message}`);
  }

  // Parse targets
  const targetsMatch = listOutput.match(/Targets:\n([\s\S]*?)\n\s*\n/);
  const targets = targetsMatch
    ? targetsMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  // Parse schemes
  const schemesMatch = listOutput.match(/Schemes:\n([\s\S]*?)(\n\s*\n|$)/);
  const schemes = schemesMatch
    ? schemesMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  if (schemes.length === 0) {
    throw new Error("No schemes found in Xcode project");
  }

  // Find the UITest target (ends with UITests but not Tests only)
  const uitestTarget =
    targets.find((t) => t.endsWith("UITests")) ||
    targets.find((t) => t.toLowerCase().includes("uitest"));

  if (!uitestTarget) {
    throw new Error(
      "No UITest target found. Add a UI Testing Bundle target to the Xcode project.",
    );
  }

  return { scheme: schemes[0], uitestTarget };
}

/**
 * Find a UITest Swift file that can be temporarily replaced.
 * Avoids LaunchTests files (they test app launch performance).
 */
function findUITestFile(prototypePath, uitestTarget) {
  // First: look in the UITest target directory for files not ending in LaunchTests
  const uitestDir = path.join(
    prototypePath,
    `${uitestTarget.replace(/UITests$/, "")}UITests`,
  );

  if (fs.existsSync(uitestDir)) {
    const files = globSync("*.swift", {
      cwd: uitestDir,
      absolute: true,
    }).filter((f) => !f.includes("LaunchTest"));

    if (files.length > 0) return files[0];
  }

  // Fallback: search the whole project
  const allUITestFiles = globSync(`**/${uitestTarget}/*.swift`, {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*LaunchTests*"],
  });

  if (allUITestFiles.length > 0) return allUITestFiles[0];

  throw new Error(
    `No UITest Swift file found for target "${uitestTarget}". ` +
      "Ensure the UI test target has at least one .swift file.",
  );
}

/**
 * Find an available iPhone simulator, preferring ones already booted.
 */
function findSimulator(developerDir) {
  let devicesJson;
  try {
    devicesJson = execSync("xcrun simctl list devices available --json 2>/dev/null", {
      env: { ...process.env, DEVELOPER_DIR: developerDir },
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch {
    throw new Error(
      "xcrun simctl failed. Ensure Xcode and the iOS Simulator are installed.",
    );
  }

  const { devices } = JSON.parse(devicesJson);

  // Gather all available iPhones, sorted by iOS version descending (newest first)
  const iosRuntimes = Object.entries(devices)
    .filter(([k]) => k.toLowerCase().includes("ios"))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));

  // Prefer a booted device
  for (const [, deviceList] of iosRuntimes) {
    const booted = deviceList.find(
      (d) => d.state === "Booted" && d.name.includes("iPhone") && d.isAvailable,
    );
    if (booted) return booted;
  }

  // Otherwise take the first available iPhone
  for (const [, deviceList] of iosRuntimes) {
    const available = deviceList.find(
      (d) => d.name.includes("iPhone") && d.isAvailable,
    );
    if (available) return available;
  }

  throw new Error(
    "No available iPhone simulator found. Open Xcode → Platforms and install an iOS Simulator.",
  );
}

module.exports = { crawlAndScreenshotIos };

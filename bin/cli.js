#!/usr/bin/env node

const { Command } = require("commander");
const path = require("path");
const { execSync } = require("child_process");
const { generate, generateNative } = require("../src/index");
const { isIosProject } = require("../src/swift-scanner");
const { isAndroidProject } = require("../src/kotlin-scanner");
const {
  loadConfig,
  listScenarios,
  VALID_MODES,
} = require("../src/quiver-config");

function openInBrowser(filePath) {
  const commands = { darwin: "open", win32: "start", linux: "xdg-open" };
  const cmd = commands[process.platform] || "xdg-open";
  try {
    execSync(`${cmd} "${filePath}"`);
  } catch {
    // Silently ignore — the path is already printed to the console
  }
}

function toSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "prototype-map";
}

const program = new Command();
// Required so the outer command's --port and the serve subcommand's --port
// don't collide (without this, commander treats subcommand options as
// overlapping the parent's, and the parent silently wins).
program.enablePositionalOptions();

program
  .name("quiver")
  .description(
    "Generate an interactive flow map from an Express/Nunjucks prototype",
  );

// ── Serve subcommand ────────────────────────────────────────────

program
  .command("serve")
  .passThroughOptions()
  .description("Start a web server for viewing and collaborating on flow maps")
  .argument("[output-dir]", "Output directory to serve", "./quiver-output")
  .option(
    "--port <number>",
    "Port to serve on",
    String(process.env.PORT || 3000),
  )
  .action(async (outputDir, options) => {
    const { startServer } = require("../src/server");
    try {
      await startServer({
        outputDir: path.resolve(outputDir),
        port: parseInt(options.port, 10),
      });
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      process.exit(1);
    }
  });

// ── Upgrade subcommand ──────────────────────────────────────────

program
  .command("upgrade")
  .description(
    "Re-bake every map under <output-dir> with the current viewer (no parser/crawler re-run)",
  )
  .argument("[output-dir]", "Output directory to upgrade", "./quiver-output")
  .option("--only <name>", "Restrict to one map by name")
  .option("--check", "Print what would change without writing", false)
  .option(
    "--no-include-root",
    "Skip rebuilding the gallery index.html at the output dir root",
  )
  .action(async (outputDir, options) => {
    const { upgrade } = require("../src/upgrade");
    try {
      const result = await upgrade(outputDir, {
        only: options.only,
        check: options.check,
        includeRoot: options.includeRoot,
      });
      const verb = options.check ? "would upgrade" : "upgraded";
      console.log(
        `\n${verb} ${result.upgraded}, skipped ${result.skipped}, failed ${result.failed}.`,
      );
      if (result.failed > 0) process.exit(1);
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      process.exit(1);
    }
  });

// ── Default generate command ────────────────────────────────────

program
  .argument("<prototype-path>", "Path to the prototype project root")
  .option("-o, --output <dir>", "Output directory", "./quiver-output")
  .option(
    "-p, --prototype-port <number>",
    "Port to start the prototype kit server on (web prototypes only)",
    "4321",
  )
  .option("--width <number>", "Screenshot viewport width", "375")
  .option("--height <number>", "Screenshot viewport height", "812")
  .option("--desktop", "Use desktop viewport (1280x800) instead of mobile")
  .option(
    "--no-screenshots",
    "Skip screenshot capture (faster, template analysis only)",
  )
  .option(
    "--runtime-crawl",
    "Supplement static analysis with runtime DOM link extraction during crawl",
    false,
  )
  .option(
    "--base-path <path>",
    "Only map pages under this path (e.g. /pages)",
    "",
  )
  .option(
    "--exclude <paths>",
    "Exclude pages matching these paths (comma-separated, supports globs)",
    "",
  )
  .option(
    "--from <url>",
    "Only show pages reachable from these pages (comma-separated, e.g. /pages/home-p9,/pages/messages-p9)",
    "",
  )
  .option("--start-url <url>", "URL to begin crawling from", "/")
  .option(
    "--name <slug>",
    "Name for this map (enables multi-map collection mode, e.g. nhsapp-nav)",
  )
  .option(
    "--title <title>",
    "Human-readable title for the map (defaults to prototype directory name)",
  )
  .option("--export-pdf", "Generate a PDF export of the flow map (map.pdf)")
  .option(
    "--pdf-mode <mode>",
    'PDF mode: "canvas" (full-canvas, default) or "snapshot" (A3 fit-to-screen)',
    "canvas",
  )
  .option(
    "--platform <platform>",
    'Project platform: "web" (default), "ios", or "android". Auto-detected if omitted.',
    "",
  )
  .option(
    "--module <name>",
    "For multi-app Android repos: substring selecting which application module to use (e.g. demonhsapp2)",
  )
  .option("--no-open", "Do not open the browser after generation")
  .option(
    "--serve",
    "After generation, start the local server (positions + hidden state persistence) and keep it running. Opens the browser at the served URL unless --no-open is set.",
  )
  .option(
    "--port <number>",
    "Port for the local server when --serve is set (no effect otherwise; for the prototype kit's port use -p / --prototype-port)",
    String(process.env.PORT || 3000),
  )
  .option(
    "--mode <mode>",
    'Mapping mode: "static" (default), "scenario", or "audit"',
    "",
  )
  .option(
    "--scenario <name>",
    "Run a single named scenario (implies --mode scenario)",
  )
  .option(
    "--scenario-set <name>",
    "Run a named set of scenarios (implies --mode scenario)",
  )
  .option(
    "--list-scenarios",
    "List available scenarios from the config file and exit",
  )
  .option(
    "--record [filename]",
    "Record a scenario interactively (opens a browser). Optional filename, default: recorded.flow",
  )
  .option(
    "--web-jumpoffs",
    "Crawl web prototypes that native (iOS/Android) flows link out to, and splice them into the map (overrides webJumpoffs.enabled)",
  )
  .option(
    "--no-web-jumpoffs",
    "Skip web jump-off crawling (overrides webJumpoffs.enabled)",
  )
  .option(
    "--no-web-cache",
    "Skip the per-page web-jumpoff cache for this run (forces a fresh crawl)",
  )
  .option(
    "--clear-web-cache",
    "Wipe the web-jumpoff cache directory before crawling, then continue",
  )
  .action(async (prototypePath, options) => {
    const resolvedPath = path.resolve(prototypePath);
    const prototypeDirName = path.basename(resolvedPath);

    // Handle --record mode
    if (options.record !== undefined) {
      // Validate incompatible flags
      if (options.mode || options.scenario || options.scenarioSet) {
        console.error(
          `\n❌ Error: --record cannot be used with --mode, --scenario, or --scenario-set\n`,
        );
        process.exit(1);
      }

      // Determine platform for recording (explicit flag > auto-detect).
      let recordPlatform = (options.platform || "").toLowerCase();
      if (!recordPlatform) {
        if (isIosProject(resolvedPath)) recordPlatform = "ios";
        else if (isAndroidProject(resolvedPath)) recordPlatform = "android";
        else recordPlatform = "web";
      }
      if (!["web", "ios", "android"].includes(recordPlatform)) {
        console.error(
          `\n❌ Error: --platform must be "web", "ios", or "android"\n`,
        );
        process.exit(1);
      }
      // ── iOS recorder ──────────────────────────────────────────────
      if (recordPlatform === "ios") {
        if (options.name && !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
          console.error(
            `\n❌ Error: --name must be lowercase alphanumeric with hyphens (e.g. "nhsapp-nav")\n`,
          );
          process.exit(1);
        }
        const mapName = options.name || toSlug(prototypeDirName);
        const mapTitle = options.title || prototypeDirName;

        console.log(`\n📐 Quiver — Recorder (iOS)\n`);
        console.log(`   Prototype: ${resolvedPath}`);
        console.log(`   Output:    ${path.resolve(options.output)}`);
        console.log(`   Map:       ${mapName}\n`);

        const { startIosRecording } = require("../src/ios-recorder");
        try {
          const result = await startIosRecording({
            prototypePath: resolvedPath,
            outputDir: path.resolve(options.output),
            name: mapName,
            title: mapTitle,
            module: options.module,
            open: options.open,
          });
          if (result.viewerPath && options.open) {
            console.log(`   Opening ${result.viewerPath} in your browser...\n`);
            openInBrowser(result.viewerPath);
          }
        } catch (err) {
          console.error(`\n❌ Error: ${err.message}\n`);
          if (process.env.DEBUG) console.error(err.stack);
          process.exit(1);
        }
        return;
      }

      // ── Android recorder ──────────────────────────────────────────
      if (recordPlatform === "android") {
        if (options.name && !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
          console.error(
            `\n❌ Error: --name must be lowercase alphanumeric with hyphens (e.g. "nhsapp-nav")\n`,
          );
          process.exit(1);
        }
        const mapName = options.name || toSlug(prototypeDirName);
        const mapTitle = options.title || prototypeDirName;

        console.log(`\n📐 Quiver — Recorder (Android)\n`);
        console.log(`   Prototype: ${resolvedPath}`);
        console.log(`   Output:    ${path.resolve(options.output)}`);
        console.log(`   Map:       ${mapName}\n`);

        const { startAndroidRecording } = require("../src/android-recorder");
        try {
          const result = await startAndroidRecording({
            prototypePath: resolvedPath,
            outputDir: path.resolve(options.output),
            name: mapName,
            title: mapTitle,
            module: options.module,
            open: options.open,
          });
          if (result.viewerPath && options.open) {
            console.log(`   Opening ${result.viewerPath} in your browser...\n`);
            openInBrowser(result.viewerPath);
          }
        } catch (err) {
          console.error(`\n❌ Error: ${err.message}\n`);
          if (process.env.DEBUG) console.error(err.stack);
          process.exit(1);
        }
        return;
      }

      // ── Web recorder ──────────────────────────────────────────────
      const { startRecording } = require("../src/recorder");
      const recordFilename =
        typeof options.record === "string" ? options.record : "recorded.flow";
      // Ensure filename ends with .flow
      const outputFilename = recordFilename.endsWith(".flow")
        ? recordFilename
        : `${recordFilename}.flow`;

      const recordViewport = options.desktop
        ? { width: 1280, height: 800 }
        : {
            width: parseInt(options.width, 10),
            height: parseInt(options.height, 10),
          };

      // Validate --name slug if provided (same logic as main path)
      if (options.name && !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
        console.error(
          `\n❌ Error: --name must be lowercase alphanumeric with hyphens (e.g. "nhsapp-nav")\n`,
        );
        process.exit(1);
      }
      const mapName = options.name || toSlug(prototypeDirName);
      const mapTitle = options.title || prototypeDirName;

      console.log(`\n📐 Quiver — Recorder\n`);
      console.log(`   Prototype: ${resolvedPath}`);
      console.log(`   Output:    ${path.resolve(options.output)}`);
      console.log(`   Map:       ${mapName}`);
      console.log(`   Recording scenario... (browser opened)\n`);

      try {
        const result = await startRecording({
          prototypePath: resolvedPath,
          port: parseInt(options.prototypePort, 10),
          viewport: recordViewport,
          outputFilename,
          outputDir: path.resolve(options.output),
          name: mapName,
          title: mapTitle,
          open: options.open,
        });

        if (result.viewerPath && options.open) {
          console.log(`   Opening ${result.viewerPath} in your browser...\n`);
          openInBrowser(result.viewerPath);
        }
      } catch (err) {
        console.error(`\n❌ Error: ${err.message}\n`);
        if (process.env.DEBUG) console.error(err.stack);
        process.exit(1);
      }
      return;
    }

    // Validate --name slug if provided
    if (options.name && !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
      console.error(
        `\n❌ Error: --name must be lowercase alphanumeric with hyphens (e.g. "nhsapp-nav")\n`,
      );
      process.exit(1);
    }

    const mapName = options.name || toSlug(prototypeDirName);
    const mapTitle = options.title || prototypeDirName;

    const pdfMode = String(options.pdfMode || "canvas").toLowerCase();
    if (!new Set(["canvas", "snapshot"]).has(pdfMode)) {
      console.error(`\n❌ Error: --pdf-mode must be "canvas" or "snapshot"\n`);
      process.exit(1);
    }

    // Determine platform (explicit flag > auto-detect)
    let platform = (options.platform || "").toLowerCase();
    if (!platform) {
      if (isIosProject(resolvedPath)) platform = "ios";
      else if (isAndroidProject(resolvedPath)) platform = "android";
      else platform = "web";
    }
    if (!["web", "ios", "android"].includes(platform)) {
      console.error(`\n❌ Error: --platform must be "web", "ios", or "android"\n`);
      process.exit(1);
    }

    // Load config from prototype directory
    const config = loadConfig(resolvedPath);

    // Tri-state override of config.webJumpoffs.enabled. Both --web-jumpoffs
    // and --no-web-jumpoffs are registered with commander (so they show up in
    // --help), but we inspect argv directly to distinguish "flag not passed"
    // from "flag passed with default true", which commander collapses together
    // when both a positive and negating option share the same property.
    if (process.argv.includes("--no-web-jumpoffs")) {
      config.webJumpoffs.enabled = false;
    } else if (process.argv.includes("--web-jumpoffs")) {
      config.webJumpoffs.enabled = true;
    }

    // Web-cache CLI overrides. Both flags are independent toggles —
    // `--clear-web-cache` wipes the cache and continues (useful when a
    // hosted prototype has changed and you want a fresh crawl without
    // editing config); `--no-web-cache` skips lookups for this run only.
    if (process.argv.includes("--clear-web-cache")) {
      try {
        const { clearCache } = require("../src/web-jumpoff-cache");
        const dir = clearCache({ cacheDir: config.webJumpoffs.cache.dir });
        console.log(`   Cleared web-jumpoff cache${dir ? "" : ""}`);
      } catch (err) {
        console.warn(`   Warning: failed to clear web cache: ${err.message}`);
      }
    }
    if (process.argv.includes("--no-web-cache")) {
      config.webJumpoffs.cache.enabled = false;
    }

    // Handle --list-scenarios
    if (options.listScenarios) {
      console.log(`\n📐 Quiver — Scenarios\n`);
      console.log(`   Prototype: ${resolvedPath}\n`);
      console.log(listScenarios(config));
      console.log();
      return;
    }

    // Determine mode: explicit flag > implied by --scenario/--scenario-set > config file > static
    let mode = "";
    if (options.mode) {
      mode = options.mode.toLowerCase();
    } else if (options.scenario || options.scenarioSet) {
      mode = "scenario";
    } else if (config.mode && config.mode !== "static") {
      mode = config.mode;
    } else {
      mode = "static";
    }

    if (!VALID_MODES.includes(mode)) {
      console.error(
        `\n❌ Error: --mode must be one of: ${VALID_MODES.join(", ")}\n`,
      );
      process.exit(1);
    }

    // Validate scenario mode has scenarios defined
    if (mode === "scenario" && config.scenarios.length === 0) {
      console.error(
        `\n❌ Error: scenario mode requires scenarios defined in quiver.config.yml\n`,
      );
      process.exit(1);
    }

    console.log(`\n📐 Quiver\n`);
    console.log(`   Prototype: ${resolvedPath}`);
    console.log(`   Platform:  ${platform}`);
    console.log(`   Mode:      ${mode}`);
    console.log(`   Output:    ${path.resolve(options.output)}`);
    console.log(`   Map:       ${mapName}`);

    // If we've run against this prototype before, surface the previous total
    // so the user can compare. Persisted by src/index.js, see
    // src/last-run-cache.js.
    try {
      const { loadFor: loadLastRun } = require("../src/last-run-cache");
      const { formatMs } = require("../src/phase-timer");
      const last = loadLastRun(resolvedPath);
      if (last && typeof last.totalMs === "number") {
        const when = last.ranAt ? new Date(last.ranAt).toLocaleString() : "";
        console.log(
          `   Last run:  ${formatMs(last.totalMs)}${when ? ` (${when})` : ""}`,
        );
      }
    } catch {
      // best-effort
    }
    console.log();

    try {
      if (platform === "ios" || platform === "android") {
        await generateNative({
          prototypePath: resolvedPath,
          outputDir: path.resolve(options.output),
          name: mapName,
          title: mapTitle,
          screenshots: options.screenshots,
          platform,
          config,
        });
      } else {
        await generate({
          prototypePath: resolvedPath,
          outputDir: path.resolve(options.output),
          port: parseInt(options.prototypePort, 10),
          viewport: options.desktop
            ? { width: 1280, height: 800 }
            : {
                width: parseInt(options.width, 10),
                height: parseInt(options.height, 10),
              },
          screenshots: options.screenshots,
          runtimeCrawl: Boolean(options.runtimeCrawl),
          basePath: options.basePath,
          exclude: options.exclude,
          from: options.from,
          startUrl: options.startUrl,
          name: mapName,
          title: mapTitle,
          exportPdf: Boolean(options.exportPdf),
          pdfMode,
          mode,
          config,
          scenario: options.scenario,
          scenarioSet: options.scenarioSet,
        });
      }

      const viewerPath = path.resolve(
        options.output,
        "maps",
        mapName,
        "index.html",
      );

      console.log(`\n✅ Flow map generated at ${path.resolve(options.output)}`);

      if (options.serve) {
        // Start the server, open the served URL (not the file:// path), and
        // wait for SIGINT. The user lands directly on a viewer that's wired
        // up to the API for hidden + position persistence.
        const { startServer } = require("../src/server");
        const serverPort = parseInt(options.port, 10);
        try {
          await startServer({
            outputDir: path.resolve(options.output),
            port: serverPort,
          });
        } catch (err) {
          console.error(`\n❌ Could not start server: ${err.message}\n`);
          process.exit(1);
        }
        const servedUrl = mapName
          ? `http://localhost:${serverPort}/maps/${encodeURIComponent(mapName)}/`
          : `http://localhost:${serverPort}/`;
        if (options.open) {
          console.log(`   Opening ${servedUrl} in your browser...\n`);
          openInBrowser(servedUrl);
        }
        // Block until Ctrl-C
        process.on("SIGINT", () => {
          console.log("\n   Server stopped.\n");
          process.exit(0);
        });
        // Keep the event loop alive forever (SIGINT handler will exit).
        await new Promise(() => {});
      } else if (options.open) {
        console.log(`   Opening ${viewerPath} in your browser...\n`);
        openInBrowser(viewerPath);
      } else {
        console.log(`   Open ${viewerPath} in a browser\n`);
      }
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse();

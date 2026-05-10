const fs = require("fs");
const path = require("path");
const { buildViewer, VIEWER_SCHEMA_VERSION } = require("./build-viewer");
const { buildIndex } = require("./build-index");
const { migrate } = require("./upgrade-migrations");

/**
 * Re-bake every map under outputDir against the current viewer code, without
 * re-running the parser/crawler. Reads each map's existing graph-data.json,
 * meta.json, runtime.json, positions.json, hidden.json, applies any schema
 * migrations, and calls buildViewer() to refresh the HTML shell + shared
 * assets. Optionally dry-runs (--check) and rebuilds the gallery index.
 *
 * Layouts (positions.json) and curated state (hidden.json) are preserved
 * untouched — buildViewer reads them from disk when present.
 */
async function upgrade(outputDir, options = {}) {
  const { only, check = false, includeRoot = true } = options;
  const absOutputDir = path.resolve(outputDir);

  if (!fs.existsSync(absOutputDir)) {
    throw new Error(`Output directory does not exist: ${absOutputDir}`);
  }

  const candidates = discoverMaps(absOutputDir);
  if (candidates.length === 0) {
    console.log(
      `No maps found at ${absOutputDir}. ` +
        `Expected either ${absOutputDir}/maps/<name>/graph-data.json ` +
        `or ${absOutputDir}/graph-data.json.`,
    );
    return { upgraded: 0, skipped: 0, failed: 0 };
  }

  const filtered = only
    ? candidates.filter((c) => c.name === only)
    : candidates;

  if (only && filtered.length === 0) {
    throw new Error(
      `No map named "${only}" found in ${absOutputDir}. ` +
        `Available: ${candidates.map((c) => c.name).join(", ") || "(none)"}.`,
    );
  }

  const plans = filtered.map((c) => planUpgrade(c));
  printPlanTable(plans);

  if (check) {
    return summarise(plans);
  }

  for (const plan of plans) {
    if (plan.action === "skip") continue;
    try {
      await applyUpgrade(plan, absOutputDir);
    } catch (e) {
      plan.action = "failed";
      plan.error = e.message;
      console.error(`   ✗ ${plan.name}: ${e.message}`);
    }
  }

  if (includeRoot && filtered.some((c) => c.kind === "named")) {
    buildIndex(absOutputDir);
    console.log(`Rebuilt gallery index at ${absOutputDir}/index.html`);
  }

  return summarise(plans);
}

/**
 * Find every map directory under outputDir. Two layouts are supported:
 *   1. Multi-map: outputDir/maps/<name>/{graph-data,meta}.json — what the
 *      generate command produces in named-map mode.
 *   2. Single-map: outputDir/{graph-data,meta}.json — older outputs without
 *      a maps/ wrapper, or single-shot generations.
 */
function discoverMaps(outputDir) {
  const out = [];
  const mapsDir = path.join(outputDir, "maps");
  if (fs.existsSync(mapsDir) && fs.statSync(mapsDir).isDirectory()) {
    for (const entry of fs.readdirSync(mapsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(mapsDir, entry.name);
      out.push({ kind: "named", name: entry.name, dir });
    }
  } else if (fs.existsSync(path.join(outputDir, "graph-data.json"))) {
    out.push({
      kind: "single",
      name: path.basename(outputDir),
      dir: outputDir,
    });
  }
  return out;
}

/**
 * Decide what we'd do for one map, without writing anything. Captures
 * everything applyUpgrade() will need so the dry-run output and the real
 * run agree.
 */
function planUpgrade(candidate) {
  const { name, dir, kind } = candidate;
  const graphPath = path.join(dir, "graph-data.json");
  const metaPath = path.join(dir, "meta.json");

  const plan = { name, dir, kind, action: "rebuild", error: null };

  if (!fs.existsSync(graphPath)) {
    plan.action = "skip";
    plan.error = "graph-data.json missing";
    return plan;
  }

  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  } catch (e) {
    plan.action = "skip";
    plan.error = `graph-data.json malformed: ${e.message}`;
    return plan;
  }

  let meta = {};
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch (e) {
      plan.action = "skip";
      plan.error = `meta.json malformed: ${e.message}`;
      return plan;
    }
  }

  plan.fromSchema = typeof meta.viewerSchemaVersion === "number"
    ? meta.viewerSchemaVersion
    : 0;
  plan.toSchema = VIEWER_SCHEMA_VERSION;
  plan.graph = graph;
  plan.meta = meta;

  // Reconstruct the viewport. Prefer runtime.json (newer maps), fall back
  // to buildViewer's default of 375x812 (mobile) — older maps simply
  // didn't record viewport, and that's the historical default.
  const runtimePath = path.join(dir, "runtime.json");
  if (fs.existsSync(runtimePath)) {
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf-8"));
      if (runtime.viewport) plan.viewport = runtime.viewport;
    } catch {
      // Malformed runtime.json — fall through to default viewport.
    }
  }

  // hasScreenshots: prefer the meta hint, fall back to a filesystem check
  // so old meta files without the field don't lose screenshots on rebake.
  if (typeof meta.hasScreenshots === "boolean") {
    plan.hasScreenshots = meta.hasScreenshots;
  } else {
    const ssDir = path.join(dir, "screenshots");
    plan.hasScreenshots =
      fs.existsSync(ssDir) &&
      fs.readdirSync(ssDir).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
  }

  return plan;
}

async function applyUpgrade(plan, outputDir) {
  const { graph, meta } = migrate(plan.graph, plan.meta, VIEWER_SCHEMA_VERSION);

  const buildOpts =
    plan.kind === "named"
      ? { name: plan.name, title: meta.title, rootOutputDir: outputDir }
      : { title: meta.title };

  await buildViewer(
    graph,
    plan.dir,
    plan.hasScreenshots,
    plan.viewport || null,
    buildOpts,
  );

  // Re-stamp meta.json with the (possibly migrated) version. buildViewer
  // doesn't touch meta.json itself; the upgrade command owns it.
  const updatedMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
    viewerSchemaVersion: VIEWER_SCHEMA_VERSION,
  };
  fs.writeFileSync(
    path.join(plan.dir, "meta.json"),
    JSON.stringify(updatedMeta, null, 2),
  );

  console.log(`   ✓ ${plan.name}`);
}

function printPlanTable(plans) {
  if (plans.length === 0) {
    console.log("(no maps to upgrade)");
    return;
  }
  const nameWidth = Math.max(4, ...plans.map((p) => p.name.length));
  const header = `${"Map".padEnd(nameWidth)}  Schema       Action`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const p of plans) {
    let schema;
    if (p.action === "skip" && p.fromSchema === undefined) {
      schema = "    (none)";
    } else {
      schema = `${String(p.fromSchema).padStart(2)} → ${String(p.toSchema).padStart(2)}   `;
    }
    const action =
      p.action === "skip"
        ? `skip — ${p.error}`
        : p.fromSchema === p.toSchema
          ? "rebuild shell"
          : `migrate ${p.fromSchema} → ${p.toSchema} + rebuild`;
    console.log(`${p.name.padEnd(nameWidth)}  ${schema}  ${action}`);
  }
  console.log("");
}

function summarise(plans) {
  const upgraded = plans.filter(
    (p) => p.action === "rebuild" || p.action === "migrate",
  ).length;
  const skipped = plans.filter((p) => p.action === "skip").length;
  const failed = plans.filter((p) => p.action === "failed").length;
  return { upgraded, skipped, failed };
}

module.exports = { upgrade, discoverMaps, planUpgrade };

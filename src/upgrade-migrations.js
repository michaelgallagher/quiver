/**
 * Schema migrations for the upgrade command.
 *
 * Each entry is { from, to, migrate(graph, meta) -> { graph, meta } } and is
 * applied in order whenever a map's `meta.viewerSchemaVersion` is older than
 * the CLI's current VIEWER_SCHEMA_VERSION. Migrations should be idempotent
 * and only touch fields that genuinely changed shape between versions.
 *
 * Empty for v1 — the first time a breaking change to graph-data.json or
 * runtime.json lands, add the migration here and bump VIEWER_SCHEMA_VERSION
 * in build-viewer.js.
 */
const MIGRATIONS = [];

/**
 * Apply all migrations needed to bring (graph, meta) up to targetVersion.
 * Throws when meta declares a version newer than the CLI knows about — we
 * refuse to silently downgrade rather than risk corrupting the map.
 */
function migrate(graph, meta, targetVersion) {
  const current = typeof meta.viewerSchemaVersion === "number"
    ? meta.viewerSchemaVersion
    : 0;

  if (current > targetVersion) {
    throw new Error(
      `Map "${meta.name || "(unnamed)"}" was generated against viewer schema ` +
        `${current}, which is newer than this CLI's ${targetVersion}. ` +
        `Upgrade prototype-flow-map (npm install -g) and try again.`,
    );
  }

  let g = graph;
  let m = meta;
  for (const step of MIGRATIONS) {
    if (step.from >= current && step.to <= targetVersion) {
      const out = step.migrate(g, m);
      g = out.graph;
      m = out.meta;
    }
  }

  m = { ...m, viewerSchemaVersion: targetVersion };
  return { graph: g, meta: m };
}

module.exports = { migrate, MIGRATIONS };

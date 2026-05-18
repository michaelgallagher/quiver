#!/usr/bin/env node
// Smoke-test helper: rebuild the viewer (HTML/CSS/JS) for an existing
// fixture map directory using its saved graph-data.json. Skips scanning,
// parsing, screenshots — just runs build-viewer over cached graph data.
//
// Usage: node scripts/regen-fixture-viewer.js <map-name>

const fs = require("fs");
const path = require("path");
const { buildViewer } = require("../src/build-viewer");

const mapName = process.argv[2] || "demonhsapp2";
const rootOutputDir = path.join(__dirname, "..", "quiver-output");
const mapDir = path.join(rootOutputDir, "maps", mapName);
const graphPath = path.join(mapDir, "graph-data.json");
const metaPath = path.join(mapDir, "meta.json");

if (!fs.existsSync(graphPath)) {
  console.error("graph-data.json not found at " + graphPath);
  process.exit(1);
}

const graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
const meta = fs.existsSync(metaPath)
  ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
  : {};
const hasScreenshots = !!meta.hasScreenshots;
const viewport = meta.viewport || null;

(async () => {
  await buildViewer(graph, mapDir, hasScreenshots, viewport, {
    name: mapName,
    rootOutputDir,
  });
  console.log(`Rebuilt viewer for ${mapName} → ${path.join(mapDir, "index.html")}`);
})();

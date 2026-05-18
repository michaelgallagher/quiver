const express = require("express");
const fs = require("fs");
const path = require("path");

/**
 * Start a web server that serves the flow map output directory
 * and provides a REST API for collaborative features (positions, etc.).
 */
async function startServer({ outputDir, port = 3000 }) {
  const resolvedDir = path.resolve(outputDir);

  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Output directory not found: ${resolvedDir}`);
  }

  const app = express();

  app.use(express.json({ limit: "1mb" }));

  // ── API routes ────────────────────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // GET /api/maps/:name/positions — read saved positions
  app.get("/api/maps/:name/positions", (req, res) => {
    const mapName = req.params.name;
    if (!isValidMapName(mapName)) {
      return res.status(400).json({ error: "Invalid map name" });
    }

    const posPath = path.join(resolvedDir, "maps", mapName, "positions.json");
    if (!fs.existsSync(posPath)) {
      return res.json({});
    }

    try {
      const data = JSON.parse(fs.readFileSync(posPath, "utf-8"));
      res.json(data);
    } catch {
      res.json({});
    }
  });

  // PUT /api/maps/:name/positions — save positions
  app.put("/api/maps/:name/positions", (req, res) => {
    const mapName = req.params.name;
    if (!isValidMapName(mapName)) {
      return res.status(400).json({ error: "Invalid map name" });
    }

    const mapDir = path.join(resolvedDir, "maps", mapName);
    if (!fs.existsSync(mapDir)) {
      return res.status(404).json({ error: "Map not found" });
    }

    const positions = req.body;
    if (!isValidPositions(positions)) {
      return res.status(400).json({ error: "Invalid positions data" });
    }

    const posPath = path.join(mapDir, "positions.json");
    fs.writeFileSync(posPath, JSON.stringify(positions, null, 2));
    res.json({ saved: true, count: Object.keys(positions).length });
  });

  // GET /api/maps/:name/hidden — read hidden nodes
  app.get("/api/maps/:name/hidden", (req, res) => {
    const mapName = req.params.name;
    if (!isValidMapName(mapName)) {
      return res.status(400).json({ error: "Invalid map name" });
    }

    const hiddenPath = path.join(resolvedDir, "maps", mapName, "hidden.json");
    if (!fs.existsSync(hiddenPath)) {
      return res.json({});
    }

    try {
      const data = JSON.parse(fs.readFileSync(hiddenPath, "utf-8"));
      res.json(data);
    } catch {
      res.json({});
    }
  });

  // PUT /api/maps/:name/hidden — save hidden nodes
  app.put("/api/maps/:name/hidden", (req, res) => {
    const mapName = req.params.name;
    if (!isValidMapName(mapName)) {
      return res.status(400).json({ error: "Invalid map name" });
    }

    const mapDir = path.join(resolvedDir, "maps", mapName);
    if (!fs.existsSync(mapDir)) {
      return res.status(404).json({ error: "Map not found" });
    }

    const hidden = req.body;
    if (!isValidHidden(hidden)) {
      return res.status(400).json({ error: "Invalid hidden data" });
    }

    const hiddenPath = path.join(mapDir, "hidden.json");
    fs.writeFileSync(hiddenPath, JSON.stringify(hidden, null, 2));
    res.json({ saved: true, count: Object.keys(hidden).length });
  });

  // ── Static file serving ───────────────────────────────────────

  // Serve the output directory as static files
  app.use(express.static(resolvedDir));

  // Redirect /maps/:name to /maps/:name/ so relative paths work
  app.get("/maps/:name", (req, res) => {
    res.redirect(301, `/maps/${req.params.name}/`);
  });

  // ── Start server ──────────────────────────────────────────────

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`\n📐 Quiver — Server\n`);
      console.log(`   Serving:  ${resolvedDir}`);
      console.log(`   URL:      http://localhost:${port}`);
      console.log(`   API:      http://localhost:${port}/api/health\n`);
      console.log(`   Press Ctrl+C to stop.\n`);
      resolve(server);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}

// ── Validation helpers ────────────────────────────────────────────

function isValidMapName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function isValidPositions(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string") return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (typeof value.x !== "number" || typeof value.y !== "number") return false;
    if (!isFinite(value.x) || !isFinite(value.y)) return false;
  }
  return true;
}

function isValidHidden(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string") return false;
    if (value !== true) return false;
  }
  return true;
}

module.exports = { startServer };

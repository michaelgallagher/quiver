/**
 * Per-prototype "last run" metadata cache.
 *
 * Stores total run duration (and platform) keyed by absolute prototype path,
 * so the CLI can print "Last run: 4m 23s" at startup before the next run
 * begins. Useful for spotting whether the new run is faster or slower than
 * the previous, and as a baseline for the iOS speed workstream.
 *
 * Lives at $XDG_CACHE_HOME/quiver/last-run.json (defaults to
 * ~/.cache/quiver/last-run.json). Best-effort: read/write
 * failures are silently swallowed — this is a convenience feature, not a
 * critical path.
 *
 * Format:
 *   {
 *     "/abs/path/to/prototype": {
 *       "totalMs": 124310,
 *       "platform": "ios",
 *       "phases": [{ "name": "Parse", "dt": 12340 }, ...],
 *       "ranAt": "2026-04-26T15:21:00.000Z"
 *     },
 *     ...
 *   }
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function getCachePath() {
  const xdg =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(xdg, "quiver", "last-run.json");
}

function loadAll() {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function loadFor(prototypePath) {
  const all = loadAll();
  const key = path.resolve(prototypePath);
  return all[key] || null;
}

function saveFor(prototypePath, data) {
  try {
    const all = loadAll();
    all[path.resolve(prototypePath)] = {
      ...data,
      ranAt: new Date().toISOString(),
    };
    const cachePath = getCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(all, null, 2));
  } catch {
    // best-effort
  }
}

module.exports = { loadFor, saveFor, getCachePath };

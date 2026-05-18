/**
 * Per-page disk cache for web jump-off crawls.
 *
 * Why this exists: when a user has both an iOS and Android prototype that
 * link to the same hosted web prototypes, the second platform run
 * re-crawls every page the first run already captured. With this cache,
 * each visited URL's metadata + screenshot persist on disk keyed by
 * canonical URL + a fingerprint of the config fields that affect a single
 * page's output (viewport, chrome-stripping, screenshot toggle). A second
 * run on the same machine then hits the cache for any URL the first run
 * touched — no network round-trip, no fresh screenshot, instant.
 *
 * Granularity is per-page rather than per-origin because the seed sets
 * differ between platforms (each native parser produces its own list of
 * native→web handoffs); per-origin caching would only kick in if the seed
 * sets matched exactly. Per-page caches every URL the BFS visits, so any
 * URL overlap is reused regardless of how the seeds differ.
 *
 * What's NOT in the fingerprint: maxDepth, maxPages, timeoutMs, allowlist.
 * These affect BFS shape (how far the crawl walks) but not the captured
 * output of any single page, so changing them shouldn't invalidate
 * existing entries.
 *
 * Errors aren't cached — let them retry each run, since they're often
 * transient (timeouts, 503s).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default cache directory: `$XDG_CACHE_HOME/quiver/web-pages/`,
 * falling back to `~/.cache/...` when XDG_CACHE_HOME is unset (the OS-X
 * convention follows the same path even though it's not officially XDG).
 */
function getCacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "quiver", "web-pages");
}

/**
 * Build the per-run config fingerprint that identifies "what would this
 * page look like if I captured it now?". A hit on this fingerprint means
 * the cached PNG is byte-equivalent to what we'd produce.
 *
 * Stable JSON stringify (sorted keys) so reordering the config block
 * doesn't trigger a miss.
 */
function buildFingerprint(config, viewport) {
  const fields = {
    viewport: {
      w: viewport ? viewport.width : null,
      h: viewport ? viewport.height : null,
    },
    hideNativeChrome: config && config.hideNativeChrome !== false,
    injectCss:
      typeof (config && config.injectCss) === "string"
        ? config.injectCss
        : null,
    screenshots: config && config.screenshots !== false,
  };
  return crypto
    .createHash("sha256")
    .update(stableStringify(fields))
    .digest("hex")
    .slice(0, 16);
}

function cacheKey(canonicalUrl, fingerprint) {
  return crypto
    .createHash("sha256")
    .update(`${canonicalUrl}::${fingerprint}`)
    .digest("hex");
}

/**
 * Look up a cached entry. Returns `null` on miss / expired / corrupt;
 * otherwise `{ meta, screenshotPath }` where:
 *   meta.label, meta.urlPath, meta.title  — what to write back onto the node
 *   meta.children                         — list of child canonical URLs
 *                                           (replays BFS expansion without
 *                                            re-fetching the HTML)
 *   screenshotPath                        — absolute path to the cached PNG,
 *                                           or null if no screenshot was
 *                                           captured on the original run
 */
function readCache(canonicalUrl, fingerprint, options = {}) {
  const cacheDir = options.cacheDir || getCacheDir();
  const ttlMs = options.ttlMs != null ? options.ttlMs : DEFAULT_TTL_MS;
  const key = cacheKey(canonicalUrl, fingerprint);
  const metaPath = path.join(cacheDir, `${key}.json`);
  const pngPath = path.join(cacheDir, `${key}.png`);
  try {
    const stat = fs.statSync(metaPath);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    if (!meta || typeof meta !== "object") return null;
    return {
      meta,
      screenshotPath: fs.existsSync(pngPath) ? pngPath : null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a freshly-crawled page's metadata + screenshot to the cache.
 * `screenshotSrcPath` may be null if the run was --no-screenshots; the
 * meta entry still gets written so child links can be replayed.
 */
function writeCache(canonicalUrl, fingerprint, meta, screenshotSrcPath, options = {}) {
  const cacheDir = options.cacheDir || getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = cacheKey(canonicalUrl, fingerprint);
  const metaPath = path.join(cacheDir, `${key}.json`);
  const pngPath = path.join(cacheDir, `${key}.png`);
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    if (screenshotSrcPath && fs.existsSync(screenshotSrcPath)) {
      fs.copyFileSync(screenshotSrcPath, pngPath);
    }
    return true;
  } catch {
    // Cache write is best-effort — failing to write should never break
    // the crawl. Silently swallow disk-full / permission errors.
    return false;
  }
}

/**
 * Wipe the cache directory. Used by `--clear-web-cache`.
 */
function clearCache(options = {}) {
  const cacheDir = options.cacheDir || getCacheDir();
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the cache dir and remove any entries older than `ttlMs`. Cheap
 * housekeeping pass — we don't need this to be perfectly accurate, just
 * to keep the directory from growing without bound. Returns the number
 * of entries pruned.
 */
function pruneExpired(options = {}) {
  const cacheDir = options.cacheDir || getCacheDir();
  const ttlMs = options.ttlMs != null ? options.ttlMs : DEFAULT_TTL_MS;
  let pruned = 0;
  try {
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(cacheDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(full);
          pruned++;
        }
      } catch {
        // Concurrent delete or stat failure — ignore.
      }
    }
  } catch {
    // Cache dir doesn't exist yet — nothing to prune.
  }
  return pruned;
}

/**
 * Stable stringify with sorted object keys (recursive). Crypto hashes are
 * sensitive to key order, so we have to normalise.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`,
  );
  return `{${parts.join(",")}}`;
}

module.exports = {
  getCacheDir,
  buildFingerprint,
  readCache,
  writeCache,
  clearCache,
  pruneExpired,
  DEFAULT_TTL_MS,
};

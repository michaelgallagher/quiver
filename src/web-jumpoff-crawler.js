const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  extractRuntimeLinks,
  canonicalizePath,
  urlToFilename,
} = require("./crawler");
const {
  buildFingerprint,
  readCache,
  writeCache,
  pruneExpired,
  DEFAULT_TTL_MS,
} = require("./web-jumpoff-cache");

/**
 * Crawl one or more externally-hosted web prototypes that a native (iOS /
 * Android) prototype links out to, and return a graph-compatible subgraph
 * that can be spliced into the native map.
 *
 * Strategy: shallow BFS following `<a href>` links only. Per-origin browser
 * context. No form submission, no click-through. Each seed URL becomes a
 * subgraph root; internal same-origin links become further web-page nodes.
 *
 * Inputs:
 *   seedUrls   — array of absolute URL strings extracted from native parsers
 *                (typically `type: "external"` nodes from the native graph)
 *   options    — { outputDir, config, viewport }
 *                outputDir: map output dir (screenshots written to
 *                           `<outputDir>/screenshots/web/<file>.png`)
 *                config:    webJumpoffs block from quiver.config.yml
 *                           (enabled, maxDepth, maxPages, timeoutMs,
 *                            sameOriginOnly, screenshots, allowlist)
 *                viewport:  { width, height } — reused from the native run
 *
 * Output: { nodes, edges, stats }
 *   nodes[i] = {
 *     id: canonicalUrl,                 // full URL, used for splicing
 *     label: "/path/or/host",
 *     urlPath: "/canonicalPath",
 *     origin: "https://host",
 *     type: "web-page",
 *     subgraphRoot: true | undefined,
 *     screenshot: "screenshots/web/<file>.png" | undefined,
 *     error: "message" | undefined,
 *   }
 *   edges[i] = { source: canonicalUrl, target: canonicalUrl, type: "link" }
 */
async function crawlWebJumpoffs(seedUrls, { outputDir, config, viewport } = {}) {
  const {
    maxDepth = 3,
    maxPages = 40,
    timeoutMs = 15000,
    sameOriginOnly = true,
    screenshots: screenshotsEnabled = true,
    allowlist = [],
    hideNativeChrome = true,
    injectCss = null,
    cache: cacheConfig = {},
  } = config || {};

  const effectiveViewport = viewport || { width: 375, height: 812 };

  // Per-page cache: a hit short-circuits the network round-trip for any
  // URL that was crawled on a previous run with the same fingerprint.
  // Disabled gracefully if the cache module isn't reachable.
  const cacheEnabled = cacheConfig.enabled !== false;
  const cacheTtlMs =
    typeof cacheConfig.ttlMs === "number" && cacheConfig.ttlMs > 0
      ? cacheConfig.ttlMs
      : DEFAULT_TTL_MS;
  const cacheDir = cacheConfig.dir || undefined; // undefined → use default
  const cacheFingerprint = cacheEnabled
    ? buildFingerprint(
        {
          hideNativeChrome,
          injectCss,
          screenshots: screenshotsEnabled,
        },
        effectiveViewport,
      )
    : null;

  // Best-effort prune of expired entries before this run. Keeps the cache
  // dir from growing unbounded; failure is silent.
  if (cacheEnabled) {
    try {
      pruneExpired({ cacheDir, ttlMs: cacheTtlMs });
    } catch {
      /* ignore */
    }
  }

  const stats = {
    seedsRequested: seedUrls.length,
    seedsCrawled: 0,
    pagesVisited: 0,
    pagesFailed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    // Total <a href>/<form action> elements skipped because the link itself
    // or one of its ancestors had `display: none` / `visibility: hidden` /
    // zero-area box. These are typically inside the production chrome we
    // strip via the `hideNativeChrome` CSS injection — the user can't see
    // them, so following them would surface unreachable pages.
    linksHidden: 0,
    originsSkipped: [],
  };

  // Partition seeds into allowed vs. skipped based on the origin allowlist.
  const allowedOrigins = new Set(allowlist);
  const seedsByOrigin = new Map(); // origin -> Set<canonicalUrl>
  for (const raw of seedUrls) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const origin = parsed.origin;
    if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      if (!stats.originsSkipped.includes(origin)) {
        stats.originsSkipped.push(origin);
      }
      continue;
    }
    const canonical = canonicalizeAbsolute(raw);
    if (!canonical) continue;
    if (!seedsByOrigin.has(origin)) seedsByOrigin.set(origin, new Set());
    seedsByOrigin.get(origin).add(canonical);
  }

  if (seedsByOrigin.size === 0) {
    return { nodes: [], edges: [], stats };
  }

  const screenshotsDir = screenshotsEnabled
    ? path.join(outputDir, "screenshots", "web")
    : null;
  if (screenshotsDir) fs.mkdirSync(screenshotsDir, { recursive: true });

  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  const edgeKeys = new Set();
  let totalPagesCrawled = 0;

  const browser = await chromium.launch();

  // Per-origin working state. We visit seeds across all origins first (so no
  // single origin can starve the rest of their subgraph roots), then
  // round-robin BFS expansion until `maxPages` is exhausted. This prevents a
  // single wide-branching seed (e.g. www.nhs.uk) from eating the global
  // budget before other origins are touched.
  const originState = new Map(); // origin -> { context, visited, queue }

  // CSS injection mirrors the production native InAppBrowser (Android
   // `WebView.evaluateJavascript` in onPageFinished, iOS WKWebView via
   // `WKUserScript(.atDocumentStart)`). Both apps inject the same four
   // base rules so hosted prototypes can opt in to "in-app mode" by
   // tagging chrome with `.hide-on-native` and adjusting NHS prototype-kit
   // wrapper paddings.
   //
   // We use Playwright's addInitScript (runs before any page script) so
   // chrome never paints — equivalent to iOS's .atDocumentStart and
   // stricter than Android's onPageFinished (which briefly flashes
   // chrome). The screenshots match what the user actually sees in the
   // native app, not what the URL serves to a plain browser.
   //
   // The "Belt-and-braces" block is a fallback that targets the
   // well-known NHS prototype-kit chrome selectors directly. Some hosted
   // prototypes (e.g. the GP-appointment one in
   // `native-nhsapp-prototype-web-test`) wrap their header and bottom
   // nav in `<div class="hide-on-native">`, so the first rule is enough.
   // Others (e.g. `nhsapp-prototype-prescriptions`) render the chrome
   // raw, so we also hide the chrome containers by class/id. Rules only
   // fire when the selector matches — safe no-op on prototypes that
   // don't use these conventions.
  const NATIVE_APP_CSS = `
    /* Production InAppBrowser rules — match what the real app injects */
    .hide-on-native { display: none !important; }
    .nhsuk-back-link { margin-bottom: 0 !important; margin-top: 16px !important; }
    .nhsuk-main-wrapper { padding-top: 16px !important; }
    .app-width-container { padding-top: 0 !important; }

    /* Belt-and-braces: NHS prototype-kit chrome that some hosted
       prototypes don't wrap in .hide-on-native */
    .app-global-navigation-native,
    .app-global-navigation-web,
    header.nhsuk-header,
    .nhsuk-header,
    .app-bottom-navigation,
    #bottomNav,
    .nhsapp-tab-bar,
    .nhsuk-footer-container,
    .nhsuk-footer,
    /* Cookie / consent banners on nhs.uk and similar */
    #nhsuk-cookie-banner,
    .nhsuk-cookie-banner,
    #cookiebanner { display: none !important; }
  `;

  function buildInitScript() {
    const parts = [];
    if (hideNativeChrome) parts.push(NATIVE_APP_CSS);
    if (typeof injectCss === "string" && injectCss.trim()) {
      parts.push(injectCss);
    }
    if (parts.length === 0) return null;
    // Escape the CSS so it survives being embedded as a JS string literal.
    const css = JSON.stringify(parts.join("\n"));
    // Init scripts on chromium fire BEFORE document.documentElement exists,
    // so any naive `appendChild` call throws "Cannot read properties of null"
    // and the script silently aborts. We retry from multiple lifecycle
    // hooks until a target node exists.
    return `(() => {
      const CSS = ${css};
      const apply = () => {
        if (typeof document === 'undefined') return false;
        if (document.getElementById('flow-map-native-styles')) return true;
        const target = document.head || document.documentElement;
        if (!target) return false;
        const style = document.createElement('style');
        style.id = 'flow-map-native-styles';
        style.textContent = CSS;
        target.appendChild(style);
        return true;
      };
      if (apply()) return;
      // documentElement not yet available — try again on every readystate
      // change and once DOMContentLoaded fires. Also observe document for
      // mutations so we catch the moment <html> is parsed.
      const tryAgain = () => { if (apply()) cleanup(); };
      const cleanup = () => {
        document.removeEventListener('readystatechange', tryAgain);
        document.removeEventListener('DOMContentLoaded', tryAgain);
        if (obs) obs.disconnect();
      };
      document.addEventListener('readystatechange', tryAgain);
      document.addEventListener('DOMContentLoaded', tryAgain);
      let obs = null;
      if (typeof MutationObserver === 'function') {
        obs = new MutationObserver(() => { tryAgain(); });
        try { obs.observe(document, { childList: true, subtree: true }); }
        catch (_) { obs = null; }
      }
    })();`;
  }
  const initScript = buildInitScript();

  async function ensureContext(origin) {
    let state = originState.get(origin);
    if (!state) {
      const context = await browser.newContext({
        viewport: effectiveViewport,
        deviceScaleFactor: 2,
      });
      if (initScript) {
        await context.addInitScript({ content: initScript });
      }
      state = { context, visited: new Set(), queue: [] };
      originState.set(origin, state);
    }
    return state;
  }

  async function visitOne(origin, state, task) {
    const { canonical, depth, isSeed } = task;
    if (state.visited.has(canonical)) return;
    state.visited.add(canonical);

    const urlPath = canonicalPathFor(canonical);
    const nodeId = canonical;
    let node = nodeById.get(nodeId);
    if (!node) {
      node = {
        id: nodeId,
        label: labelFor(canonical),
        urlPath,
        origin,
        type: "web-page",
        hub: null,
        filePath: null,
        screenshot: null,
      };
      if (isSeed) node.subgraphRoot = true;
      nodes.push(node);
      nodeById.set(nodeId, node);
    } else if (isSeed) {
      node.subgraphRoot = true;
    }

    // Cache hit path: skip the network round-trip + screenshot capture and
    // replay the cached children into the BFS queue. Always check before
    // launching a page (Playwright contexts cost a few ms per page open).
    if (cacheEnabled && cacheFingerprint) {
      const hit = readCache(canonical, cacheFingerprint, {
        cacheDir,
        ttlMs: cacheTtlMs,
      });
      if (hit) {
        if (hit.meta.label) node.label = hit.meta.label;

        // Copy the cached PNG into this run's output dir if screenshots
        // are still enabled. If the original run had screenshots off
        // there's nothing to copy — leave node.screenshot null.
        if (screenshotsDir && hit.screenshotPath) {
          try {
            const filename = webScreenshotName(canonical);
            const outPath = path.join(screenshotsDir, filename);
            fs.copyFileSync(hit.screenshotPath, outPath);
            node.screenshot = `screenshots/web/${filename}`;
          } catch (copyErr) {
            node.screenshotError = copyErr.message;
          }
        }

        // Replay child links — same as the live crawl, just without
        // re-fetching HTML to extract them.
        if (depth < maxDepth && Array.isArray(hit.meta.children)) {
          for (const childCanonical of hit.meta.children) {
            if (sameOriginOnly) {
              try {
                if (new URL(childCanonical).origin !== origin) continue;
              } catch {
                continue;
              }
            }
            addEdge(edges, edgeKeys, {
              source: canonical,
              target: childCanonical,
              type: "link",
            });
            if (!state.visited.has(childCanonical)) {
              state.queue.push({
                canonical: childCanonical,
                depth: depth + 1,
                isSeed: false,
              });
            }
          }
        }

        stats.pagesVisited += 1;
        stats.cacheHits += 1;
        totalPagesCrawled += 1;
        if (isSeed) stats.seedsCrawled += 1;
        return;
      }
      stats.cacheMisses += 1;
    }

    const page = await state.context.newPage();
    let outPath = null; // remembered so we can write to cache after capture
    const childCanonicals = []; // children discovered live, persisted on success
    try {
      const response = await page.goto(canonical, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      await Promise.race([
        page.waitForLoadState("networkidle").catch(() => {}),
        page.waitForTimeout(2000),
      ]);

      if (response && !response.ok()) {
        node.error = `HTTP ${response.status()}`;
      }

      stats.pagesVisited += 1;
      totalPagesCrawled += 1;
      if (isSeed) stats.seedsCrawled += 1;

      try {
        const title = (await page.title())?.trim();
        if (title) node.label = title.slice(0, 80);
      } catch {
        /* ignore */
      }

      if (screenshotsDir) {
        try {
          const filename = webScreenshotName(canonical);
          outPath = path.join(screenshotsDir, filename);
          await dismissOverlays(page);
          // Clip to viewport size so web screenshots have the same aspect
          // ratio as native screenshots. Without this, fullPage:true would
          // capture a long page in its entirety, producing a tall thumbnail
          // that visually dominates a row of native portrait screens.
          await page.screenshot({
            path: outPath,
            fullPage: false,
            clip: {
              x: 0,
              y: 0,
              width: effectiveViewport.width,
              height: effectiveViewport.height,
            },
          });
          node.screenshot = `screenshots/web/${filename}`;
        } catch (shotErr) {
          node.screenshotError = shotErr.message;
          outPath = null;
        }
      }

      if (depth < maxDepth) {
        // Filter links inside hidden chrome only when chrome-stripping is
        // active. With `hideNativeChrome: false` the user is asking to see
        // pages with their full chrome, so the chrome links should still
        // be followed to give an honest map.
        const { links, hiddenCount = 0 } = await extractRuntimeLinks(
          page,
          urlPath,
          origin,
          { skipHidden: hideNativeChrome },
        );
        stats.linksHidden += hiddenCount;
        for (const link of links) {
          if (link.kind !== "anchor") continue;
          const childUrl = origin + link.target;
          const childCanonical = canonicalizeAbsolute(childUrl);
          if (!childCanonical) continue;
          if (sameOriginOnly) {
            try {
              if (new URL(childCanonical).origin !== origin) continue;
            } catch {
              continue;
            }
          }
          childCanonicals.push(childCanonical);
          addEdge(edges, edgeKeys, {
            source: canonical,
            target: childCanonical,
            type: "link",
          });
          if (!state.visited.has(childCanonical)) {
            state.queue.push({
              canonical: childCanonical,
              depth: depth + 1,
              isSeed: false,
            });
          }
        }
      }

      // Persist successful capture to cache. Errors aren't cached — let
      // them retry on the next run, since they're often transient.
      if (cacheEnabled && cacheFingerprint && !node.error) {
        writeCache(
          canonical,
          cacheFingerprint,
          {
            label: node.label,
            urlPath: node.urlPath,
            children: childCanonicals,
            cachedAt: Date.now(),
          },
          outPath,
          { cacheDir },
        );
      }
    } catch (err) {
      stats.pagesFailed += 1;
      node.error = err.message || String(err);
    } finally {
      await page.close().catch(() => {});
    }
  }

  try {
    // Phase 1: visit every seed across every origin, so each allowed
    // jump-off gets its root node + screenshot even under tight budgets.
    for (const [origin, seedSet] of seedsByOrigin) {
      for (const seed of seedSet) {
        if (totalPagesCrawled >= maxPages) break;
        const state = await ensureContext(origin);
        await visitOne(origin, state, {
          canonical: seed,
          depth: 0,
          isSeed: true,
        });
      }
      if (totalPagesCrawled >= maxPages) break;
    }

    // Phase 2: round-robin BFS expansion across origin queues. Each pass
    // pops one task from each non-empty origin queue, ensuring no origin
    // monopolises the remaining budget.
    while (totalPagesCrawled < maxPages) {
      let progressed = false;
      for (const [origin, state] of originState) {
        if (totalPagesCrawled >= maxPages) break;
        if (state.queue.length === 0) continue;
        const task = state.queue.shift();
        if (state.visited.has(task.canonical)) continue;
        await visitOne(origin, state, task);
        progressed = true;
      }
      if (!progressed) break;
    }
  } finally {
    for (const { context } of originState.values()) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }

  return { nodes, edges, stats };
}

function addEdge(edges, edgeKeys, edge) {
  if (edge.source === edge.target) return;
  const key = `${edge.source}|${edge.target}|${edge.type}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push(edge);
}

function canonicalizeAbsolute(raw) {
  try {
    const u = new URL(raw);
    const pathPart = canonicalizePath(`${u.pathname}${u.search}`);
    if (!pathPart) return null;
    return `${u.origin}${pathPart}`;
  } catch {
    return null;
  }
}

function canonicalPathFor(absolute) {
  try {
    const u = new URL(absolute);
    return canonicalizePath(`${u.pathname}${u.search}`) || "/";
  } catch {
    return "/";
  }
}

function labelFor(absolute) {
  try {
    const u = new URL(absolute);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return u.hostname.replace(/^www\./, "");
    return segments[segments.length - 1];
  } catch {
    return absolute;
  }
}

function webScreenshotName(absolute) {
  try {
    const u = new URL(absolute);
    const host = u.hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const pathName = urlToFilename(u.pathname + u.search); // ends with .png
    return `${host}--${pathName}`;
  } catch {
    return urlToFilename(absolute);
  }
}

async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll(
          '.app-modal__overlay, .app-modal--open, [role="dialog"], .modal-backdrop, .modal.show, .overlay, .nhsuk-notification-banner'
        )
        .forEach((el) => el.remove());
      document.body.classList.remove("app-modal-open");
    });
  } catch {
    /* ignore */
  }
}

module.exports = { crawlWebJumpoffs, canonicalizeAbsolute };

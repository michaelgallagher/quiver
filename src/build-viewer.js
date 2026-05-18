const fs = require("fs");
const path = require("path");

// Stamped onto meta.json so the upgrade command can decide whether a map
// needs migration or just a straight rebake. Bump on breaking shape changes
// to graph-data.json or runtime.json — not on UI changes.
const VIEWER_SCHEMA_VERSION = 1;

/**
 * Build a self-contained HTML viewer for the flow map.
 * Outputs a single index.html with embedded JS that renders
 * an interactive, zoomable, pannable flow diagram.
 */
async function buildViewer(
  graph,
  outputDir,
  hasScreenshots,
  viewport,
  options = {},
) {
  const { name, title, rootOutputDir } = options;
  fs.mkdirSync(outputDir, { recursive: true });

  // Read saved positions and hidden nodes if they exist (regeneration merge).
  // Both are persisted to disk by the server (PUT /api/maps/:name/{positions,hidden}).
  // We only carry forward entries for nodes that still exist in the graph —
  // stale entries are silently dropped so the carry-forward never misplaces
  // positions or accidentally hides newly-added nodes that share an old ID.
  const currentNodeIds = new Set(graph.nodes.map((n) => n.id));

  let savedPositions = {};
  const savedPosPath = path.join(outputDir, "positions.json");
  if (fs.existsSync(savedPosPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(savedPosPath, "utf-8"));
      for (const [nodeId, pos] of Object.entries(raw)) {
        if (currentNodeIds.has(nodeId)) {
          savedPositions[nodeId] = pos;
        }
      }
    } catch {
      // Ignore malformed positions file
    }
  }

  let savedHidden = {};
  const savedHiddenPath = path.join(outputDir, "hidden.json");
  if (fs.existsSync(savedHiddenPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(savedHiddenPath, "utf-8"));
      for (const [nodeId, val] of Object.entries(raw)) {
        if (val === true && currentNodeIds.has(nodeId)) {
          savedHidden[nodeId] = true;
        }
      }
    } catch {
      // Ignore malformed hidden file
    }
  }

  // CSS and JS live in the root output dir (shared across all maps).
  // When running in named-map mode the map's index.html is two levels deep
  // (maps/<name>/index.html), so we need to adjust the relative paths.
  const sharedAssetsDir = rootOutputDir || outputDir;
  const assetPrefix = rootOutputDir ? "../../" : "";

  // Write graph data as JSON. The viewer prefers this sidecar over the
  // inline copy in index.html — that way an upgrade can ship new viewer.js
  // logic against existing graph data without touching every map's HTML.
  const dataPath = path.join(outputDir, "graph-data.json");
  fs.writeFileSync(dataPath, JSON.stringify(graph, null, 2));

  // Runtime knobs that aren't part of the graph itself (viewport, saved
  // positions/hidden, map name, generation id). Same fetch-first /
  // inline-fallback pattern as graph-data.json. The generation id changes
  // every build so stale localStorage positions get invalidated cleanly.
  const generationId = Date.now().toString(36);
  const vpWidth = (viewport && viewport.width) || 375;
  const vpHeight = (viewport && viewport.height) || 812;
  const runtime = {
    hasScreenshots: Boolean(hasScreenshots),
    viewport: { width: vpWidth, height: vpHeight },
    generationId,
    mapName: name || "",
    savedPositions,
    savedHidden,
  };
  fs.writeFileSync(
    path.join(outputDir, "runtime.json"),
    JSON.stringify(runtime, null, 2),
  );

  // Write the HTML viewer
  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(
    htmlPath,
    renderMapShell({
      graph,
      hasScreenshots,
      viewport,
      name,
      title,
      assetPrefix,
      savedPositions,
      savedHidden,
      generationId,
    }),
  );

  // Write the CSS and JS only to the shared root directory
  fs.mkdirSync(sharedAssetsDir, { recursive: true });
  const cssPath = path.join(sharedAssetsDir, "styles.css");
  fs.writeFileSync(cssPath, generateViewerCss());

  const jsPath = path.join(sharedAssetsDir, "viewer.js");
  fs.writeFileSync(jsPath, generateViewerJs());

  const bootstrapPath = path.join(sharedAssetsDir, "theme-bootstrap.js");
  fs.writeFileSync(bootstrapPath, generateThemeBootstrapJs());

  // Copy dagre.min.js into vendor/ alongside the shared assets so the viewer
  // doesn't need a network round-trip to a CDN. We resolve from this module's
  // node_modules so it works whether quiver is installed globally
  // or run from a checkout.
  const vendorDir = path.join(sharedAssetsDir, "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  const dagreSrc = require.resolve("dagre/dist/dagre.min.js");
  fs.copyFileSync(dagreSrc, path.join(vendorDir, "dagre.min.js"));

  // Remove any stale per-map copies left over from older builds
  if (rootOutputDir) {
    for (const stale of ["viewer.js", "styles.css"]) {
      const stalePath = path.join(outputDir, stale);
      if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
    }
  }
}

/**
 * Render the per-map shell HTML — toolbar, legend, dialogs, and the inline
 * data island used as a fallback on file://. Both the generate codepath
 * (src/index.js → buildViewer) and the upgrade codepath (src/upgrade.js →
 * buildViewer) flow through here, so any UI change picked up by upgrade
 * will look identical to a fresh generate.
 */
function renderMapShell({
  graph,
  hasScreenshots,
  viewport,
  name,
  title,
  assetPrefix = "",
  savedPositions = {},
  savedHidden = {},
  generationId = Date.now().toString(36),
}) {
  const vpWidth = (viewport && viewport.width) || 375;
  const vpHeight = (viewport && viewport.height) || 812;
  const backLink = name
    ? '<a href="../../index.html" class="back-to-index">&larr; All maps</a>'
    : "";

  // Title resolution: caller-supplied title wins, falling back to the
  // folder slug. The browser tab and the visible H1 share this single
  // value so they stay in sync.
  const displayTitle = title || name || "";

  // The shell HTML is now feature-stable: every gate-able element is always
  // emitted (with display:none where applicable), and viewer.js shows them
  // at runtime based on what's in the graph. That way upgrading viewer.js
  // doesn't need to rewrite the shell of every map for these features.

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtmlForAttr(displayTitle || "Quiver")}</title>
  <script src="${assetPrefix}theme-bootstrap.js"></script>
  <link rel="stylesheet" href="${assetPrefix}styles.css">
</head>
<body>
  <a class="skip-link" href="#canvas-container">Skip to flow map</a>
  <div id="toolbar" role="toolbar" aria-label="Flow map controls">
    <div class="toolbar-row">
      <div class="toolbar-row__left">
        ${backLink}
        <h1>${displayTitle ? `<span class="scenario-name">${escapeHtmlForAttr(displayTitle)}</span>` : "Quiver"}</h1>
        <span id="node-count" aria-live="polite" aria-atomic="true"></span>
      </div>
    </div>
    <div class="toolbar-row">
      <div class="toolbar-row__left toolbar-controls">
        <label class="visually-hidden" for="search">Search pages</label>
        <input type="text" id="search" placeholder="Search pages..." />
        <label class="visually-hidden" id="hub-filter-label" for="hub-filter">Filter by hub</label>
        <select id="hub-filter" style="display:none">
          <option value="">All hubs</option>
        </select>
        <button id="toggle-thumbnail" type="button" onclick="toggleThumbnail()" aria-pressed="false" style="display:none">Show thumbnails</button>
        <button id="toggle-screenshots" type="button" onclick="toggleScreenshots()" aria-pressed="false" style="display:none">Hide screenshots</button>
        <button id="toggle-labels" type="button" aria-pressed="true">Hide labels</button>
        <label id="toggle-global-nav-label" style="display:none"><input type="checkbox" id="toggle-global-nav"> Global nav</label>
        <label class="visually-hidden" for="provenance-filter" id="provenance-filter-label">Filter by provenance</label>
        <select id="provenance-filter" style="display:none">
          <option value="">All edges</option>
          <option value="runtime">Runtime only</option>
          <option value="static">Static only</option>
          <option value="both">Both sources</option>
        </select>
        <button id="outline-toggle" type="button" onclick="toggleOutlineView()" aria-pressed="false">View as outline</button>
        <button type="button" onclick="fitToScreen()">Fit to screen</button>
        <button id="show-all-btn" type="button" onclick="showHiddenListPopover()" aria-haspopup="dialog" aria-expanded="false" style="display:none">Show hidden (0)</button>
        <button id="reset-positions-btn" type="button" onclick="resetPositions()">Reset positions</button>
        <button id="save-layout-btn" type="button" onclick="saveLayout()" style="display:none">Save layout</button>
      </div>
      <div class="toolbar-row__right toolbar-controls">
        <button id="theme-toggle" type="button" aria-pressed="false">Light mode</button>
        <button id="keyboard-help-btn" type="button" onclick="openKeyboardHelp()" aria-haspopup="dialog" aria-expanded="false" title="Keyboard shortcuts (press ?)">Keyboard shortcuts</button>
      </div>
    </div>
  </div>
  <div id="a11y-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
  <div id="canvas-container" tabindex="-1">
    <svg id="flow-svg"></svg>
  </div>
  <nav id="flow-outline" aria-labelledby="outline-heading"></nav>
  <div id="keyboard-help-overlay" class="kb-help-overlay" hidden></div>
  <div id="keyboard-help-dialog" class="kb-help-dialog" role="dialog" aria-modal="true" aria-labelledby="kb-help-title" hidden tabindex="-1">
    <div class="kb-help-header">
      <h2 id="kb-help-title">Keyboard shortcuts</h2>
      <button id="kb-help-close" type="button" aria-label="Close keyboard shortcuts">✕</button>
    </div>
    <div class="kb-help-body">
      <h3>Navigation</h3>
      <dl class="kb-help-list">
        <dt><kbd>Tab</kbd></dt><dd>Move between toolbar, graph, and panels</dd>
        <dt><kbd>Arrow</kbd> keys</dt><dd>On a node: move to spatial neighbour; otherwise: pan the canvas</dd>
        <dt><kbd>]</kbd> / <kbd>[</kbd></dt><dd>Follow outgoing / incoming connection</dd>
        <dt><kbd>Home</kbd> / <kbd>End</kbd></dt><dd>First / last node by visit order</dd>
        <dt><kbd>Enter</kbd> or <kbd>Space</kbd></dt><dd>Open the focused node's details</dd>
      </dl>
      <h3>Zoom &amp; view</h3>
      <dl class="kb-help-list">
        <dt><kbd>+</kbd> or <kbd>=</kbd></dt><dd>Zoom in</dd>
        <dt><kbd>−</kbd> or <kbd>_</kbd></dt><dd>Zoom out</dd>
        <dt><kbd>0</kbd></dt><dd>Fit to screen</dd>
      </dl>
      <h3>Editing</h3>
      <dl class="kb-help-list">
        <dt><kbd>M</kbd></dt><dd>Enter move mode for the focused node (arrows nudge, <kbd>Shift</kbd>+arrows step further, <kbd>Enter</kbd> commits, <kbd>Esc</kbd> cancels)</dd>
        <dt><kbd>Shift</kbd>+<kbd>F10</kbd> or <kbd>ContextMenu</kbd></dt><dd>Open node actions menu (also: Node actions toolbar button)</dd>
      </dl>
      <h3>Dialogs &amp; menus</h3>
      <dl class="kb-help-list">
        <dt><kbd>Esc</kbd></dt><dd>Close the open menu, popover, or panel; cancel move mode</dd>
        <dt><kbd>?</kbd></dt><dd>Open this help dialog</dd>
      </dl>
    </div>
  </div>
  <aside id="legend" aria-labelledby="legend-title">
    <h3 id="legend-title">Edge types</h3>
    <ul class="legend-list" role="list">
      <li class="legend-item"><span class="legend-swatch legend-swatch--form" aria-hidden="true"></span> Form submission</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--link" aria-hidden="true"></span> Link / push nav</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--conditional" aria-hidden="true"></span> Conditional</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--nav" aria-hidden="true"></span> Tab / global nav</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--sheet" aria-hidden="true"></span> Sheet (modal)</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--full-screen" aria-hidden="true"></span> Full-screen cover</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--web-view" aria-hidden="true"></span> Web view</li>
      <li class="legend-item"><span class="legend-swatch legend-swatch--safari" aria-hidden="true"></span> Safari / external</li>
    </ul>
    <div id="legend-provenance" style="display:none">
      <h3 class="legend-subhead">Provenance</h3>
      <ul class="legend-list" role="list">
        <li class="legend-item"><span class="legend-swatch legend-swatch--solid" aria-hidden="true"></span> Runtime</li>
        <li class="legend-item"><span class="legend-swatch legend-swatch--dashed" aria-hidden="true"></span> Static only</li>
        <li class="legend-item"><span class="legend-swatch legend-swatch--both" aria-hidden="true"></span> Both sources</li>
      </ul>
    </div>
  </aside>
  <aside id="detail-panel" class="hidden" role="complementary" aria-labelledby="panel-title" aria-hidden="true" inert tabindex="-1">
    <button id="close-panel" type="button" onclick="closePanel()" aria-label="Close details">✕</button>
    <div id="panel-content"></div>
  </aside>
  <script>
    // Inline data island. The viewer prefers fetched sidecars
    // (graph-data.json, runtime.json) when those load successfully, and
    // falls back to these globals on file:// (where fetch is CORS-blocked).
    window.__GRAPH_DATA__ = ${JSON.stringify(graph)};
    window.__HAS_SCREENSHOTS__ = ${hasScreenshots ? "true" : "false"};
    window.__VIEWPORT_WIDTH__ = ${vpWidth};
    window.__VIEWPORT_HEIGHT__ = ${vpHeight};
    window.__GENERATION_ID__ = ${JSON.stringify(generationId)};
    window.__SAVED_POSITIONS__ = ${JSON.stringify(savedPositions)};
    window.__SAVED_HIDDEN__ = ${JSON.stringify(savedHidden)};
    window.__MAP_NAME__ = ${JSON.stringify(name || "")};
  </script>
  <script src="${assetPrefix}vendor/dagre.min.js"></script>
  <script src="${assetPrefix}viewer.js"></script>
</body>
</html>`;
}

function escapeHtmlForAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// No-flash theme bootstrap. Loaded synchronously from <head> so data-theme
// is set before stylesheets paint. Shared between the per-map viewer and the
// gallery index page (build-index.js). If the user has a saved preference
// it wins; otherwise we honour the OS-level prefers-color-scheme.
function generateThemeBootstrapJs() {
  return `(function () {
  try {
    var saved = localStorage.getItem('flowmap-theme');
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    var theme = saved === 'light' || saved === 'dark' ? saved : (prefersLight ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* localStorage may be unavailable — default dark */ }
})();
`;
}

function generateViewerCss() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }

/* ===== Theme tokens =====
 * Dark = default. Light is opt-in via :root[data-theme="light"].
 * The bootstrap script in <head> sets data-theme before stylesheets
 * paint, so users with a saved or system light preference don't see
 * a dark flash. */
:root, :root[data-theme="dark"] {
  --bg: #1a1a2e;
  --surface-1: #16213e;
  --surface-2: #1a1f2e;
  --surface-3: #161b27;
  --border: #496e9a;
  --border-strong: #3e6eae;
  --border-popover: #646c82;
  --border-popover-2: #2a3245;
  --control-bg: #0f3460;
  --control-bg-hover: #1a4a8a;
  --text: #e0e0e0;
  --text-strong: #ffffff;
  --text-muted: #9a9a9a;
  --text-subtle: #8a8a8a;
  --text-popover: #c4cad6;
  --text-meta-key: #aabbcc;
  --text-meta-value: #8899aa;
  --text-meta-faint: #828a9e;
  --accent: #53d8fb;
  --accent-rgb: 83, 216, 251;
  --accent-soft: #8fb8e0;
  --accent-link: #6b9fd4;
  --focus-ring: #53d8fb;
  --warn: #e8a838;
  --ok: #5aaf6a;
  --highlight: #ffcc00;
  --purple: #aa55cc;
  --err-fg: #ef4444;
  --err-fg-soft: #ef9a9a;
  --err-bg: #3f1e1e;
  --err-bg-hover: #5f2e2e;
  --err-border: #8f2a2a;
  --edge-form: #5aaf6a;
  --edge-link: #6b9fd4;
  --edge-conditional: #e8a838;
  --edge-redirect: #aa55cc;
  --edge-render: #aa55cc;
  --edge-nav: #53d8fb;
  --edge-sheet: #c47ab0;
  --edge-full-screen: #d47a6b;
  --edge-tab: #53d8fb;
  --edge-web-view: #5aaf6a;
  --edge-safari: #8f8f40;
  --edge-label: #aabbcc;
  --edge-condition-label: #e8a838;
  --provenance-runtime-bg: #1a3a2a;
  --provenance-runtime-fg: #5aaf6a;
  --provenance-static-bg: #2a1a3a;
  --provenance-static-fg: #ba65dc;
  --provenance-both-bg: #1a2a3a;
  --provenance-both-fg: #6b9fd4;
  --provenance-nav-bg: #1a3a4a;
  --provenance-nav-fg: #53d8fb;
  --provenance-both-grad-1: #6b9fd4;
  --provenance-both-grad-2: #aa55cc;
  --node-content-fill: #1e3a5f;
  --node-content-stroke: #3a6a9f;
  --node-question-fill: #1e3f5f;
  --node-question-stroke: #2a8f5a;
  --node-check-answers-fill: #3f3a1e;
  --node-check-answers-stroke: #8f7a2a;
  --node-confirmation-fill: #1e3f2f;
  --node-confirmation-stroke: #2a8f4a;
  --node-error-fill: #3f1e1e;
  --node-error-stroke: #ab4646;
  --node-splash-fill: #2e1e4f;
  --node-splash-stroke: #8050b5;
  --node-index-fill: #0f3460;
  --node-index-stroke: #53d8fb;
  --node-screen-fill: #1a3545;
  --node-screen-stroke: #2a7a9f;
  --node-web-view-fill: #1a3f22;
  --node-web-view-stroke: #2a8f40;
  --node-external-fill: #3a3520;
  --node-external-stroke: #8f7a30;
  --node-web-page-fill: #1e3548;
  --node-web-page-stroke: #6b9fd4;
  --node-label: #ffffff;
  --node-label-muted: #8899aa;
}

:root[data-theme="light"] {
  --bg: #f4f6fa;
  --surface-1: #ffffff;
  --surface-2: #ffffff;
  --surface-3: #eef1f6;
  --border: #8e949d;
  --border-strong: #8a95a6;
  --border-popover: #9095a0;
  --control-bg: #E2E8F1;
  --control-bg-hover: #C2CDDE;
  --border-popover-2: #d8dce4;
  --text: #1c2030;
  --text-strong: #0a0d18;
  --text-muted: #5a6378;
  --text-subtle: #6a7286;
  --text-popover: #2a3045;
  --text-meta-key: #2a3045;
  --text-meta-value: #4a536a;
  --text-meta-faint: #6a7286;
  --accent: #0a6480;
  --accent-rgb: 10, 100, 128;
  --accent-soft: #0a4870;
  --accent-link: #2a5a8f;
  --focus-ring: #0a4870;
  --warn: #8a5a00;
  --ok: #1a6e3a;
  --highlight: #8a6a00;
  --purple: #6a2a8f;
  --err-fg: #b32424;
  --err-fg-soft: #b32424;
  --err-bg: #fce8e8;
  --err-bg-hover: #f8d7d7;
  --err-border: #d59999;
  --edge-form: #1a6e3a;
  --edge-link: #2a5a8f;
  --edge-conditional: #8a5a00;
  --edge-redirect: #6a2a8f;
  --edge-render: #6a2a8f;
  --edge-nav: #0a6480;
  --edge-sheet: #8a3470;
  --edge-full-screen: #9a3a2a;
  --edge-tab: #0a6480;
  --edge-web-view: #1a6e3a;
  --edge-safari: #5a5a20;
  --edge-label: #2a3045;
  --edge-condition-label: #8a5a00;
  --provenance-runtime-bg: #d4eedd;
  --provenance-runtime-fg: #0e5a2c;
  --provenance-static-bg: #ead4f0;
  --provenance-static-fg: #5a1f7a;
  --provenance-both-bg: #d4e0f0;
  --provenance-both-fg: #1f4a7a;
  --provenance-nav-bg: #d4ecf2;
  --provenance-nav-fg: #0a4d70;
  --provenance-both-grad-1: #4a78ad;
  --provenance-both-grad-2: #6a2a8f;
  --node-content-fill: #d8e4f5;
  --node-content-stroke: #4a78ad;
  --node-question-fill: #d8eedf;
  --node-question-stroke: #2a7a4a;
  --node-check-answers-fill: #faecc8;
  --node-check-answers-stroke: #a07820;
  --node-confirmation-fill: #d4ecd8;
  --node-confirmation-stroke: #2a7a4a;
  --node-error-fill: #faddd6;
  --node-error-stroke: #a03828;
  --node-splash-fill: #e3d8f0;
  --node-splash-stroke: #5a1f8a;
  --node-index-fill: #d4e4f5;
  --node-index-stroke: #0a6480;
  --node-screen-fill: #d8e8ef;
  --node-screen-stroke: #2a6478;
  --node-web-view-fill: #d8eedb;
  --node-web-view-stroke: #2a7a40;
  --node-external-fill: #f0e8c8;
  --node-external-stroke: #7a6020;
  --node-web-page-fill: #dde6f0;
  --node-web-page-stroke: #2a5a8f;
  --node-label: #0a0d18;
  --node-label-muted: #4a536a;
}

/* Match native form widgets and scrollbars to the active theme. */
:root { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }

/* Visually-hidden utility — used for skip links and screen-reader-only
 * labels. Position is fixed at -1px clip so it stays in the AT tree. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Skip link — first focusable element in the page. Visually hidden until
 * focused, at which point it slides into view at the top-left so a
 * keyboard user can jump past the toolbar to the diagram. WCAG 2.4.1. */
.skip-link {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 200;
  padding: 8px 12px;
  background: var(--surface-1);
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 13px;
  text-decoration: none;
  transform: translateY(calc(-100% - 16px));
  transition: transform 0.15s;
}
.skip-link:focus {
  transform: translateY(0);
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Legend list — new in Phase 2; resets default <ul> bullet/padding. */
.legend-list { list-style: none; padding: 0; margin: 0; }
.legend-subhead { margin-top: 8px; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  height: 100vh;
}

#toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
}

.toolbar-row__left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.toolbar-row__right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

#toolbar h1 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
  white-space: nowrap;
}

.back-to-index {
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  white-space: nowrap;
}
.back-to-index:hover {
  background: var(--control-bg);
}

.toolbar-controls {
  font-size: 13px;
}

.toolbar-controls button {
  background: var(--control-bg);
  color: var(--text);
  border: 1px solid var(--border-strong);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.toolbar-controls button:hover { background: var(--control-bg-hover); }

.toolbar-controls label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}

.toolbar-controls select,
.toolbar-controls input[type="text"] {
  background: var(--control-bg);
  color: var(--text);
  border: 1px solid var(--border-strong);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.toolbar-controls input[type="text"] { width: 160px; }

#node-count {
  font-size: 12px;
  color: var(--text-muted);
}

/* Visible focus rings on all keyboard-reachable controls. Uses
 * :focus-visible so mouse clicks don't draw the ring but keyboard
 * users always do. WCAG 2.4.7 / 2.4.11. */
.toolbar-controls button:focus-visible,
.toolbar-controls select:focus-visible,
.toolbar-controls input:focus-visible,
.back-to-index:focus-visible,
#close-panel:focus-visible,
.hide-node-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Keyboard focus on a node uses a thicker, theme-aware ring so it is
 * distinguishable from :hover (which uses --accent at 2px). */
.node-group:focus { outline: none; }
.node-group:focus-visible .node-rect {
  stroke: var(--focus-ring) !important;
  stroke-width: 3 !important;
}
.node-rect--focused {
  stroke: var(--focus-ring) !important;
  stroke-width: 3 !important;
}
/* Strip the SVG's native focus halo on Safari/Chrome — we paint our own. */
.node-group:focus-visible { outline: none; }

#canvas-container {
  position: fixed;
  top: 80px;
  left: 0;
  right: 0;
  bottom: 0;
}

#flow-svg {
  width: 100%;
  height: 100%;
  cursor: grab;
}

#flow-svg:active { cursor: grabbing; }

/* Outline view — Phase 5.
 * Visually hidden (but in the AT tree) when SVG view is active so screen
 * readers and search engines always have a navigable text representation.
 * Becomes a full scrollable panel when .outline-active is set. */
#flow-outline:not(.outline-active) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

#flow-outline.outline-active {
  position: fixed;
  top: 50px;
  left: 0;
  right: 0;
  bottom: 0;
  overflow-y: auto;
  background: var(--bg);
  padding: 24px 32px;
  z-index: 10;
}

#flow-outline h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
  margin: 0 0 16px;
}

.outline-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 800px;
}

.outline-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  background: var(--surface-1);
}

.outline-node-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  padding: 0;
  text-align: left;
}

.outline-node-btn:hover { text-decoration: underline; }

.outline-node-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}

.outline-type-badge {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 12px;
}

.outline-edges-list {
  list-style: none;
  padding: 4px 0 0 12px;
  margin: 4px 0 0;
  border-left: 2px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.outline-edge-item {
  font-size: 12px;
  color: var(--text-muted);
}

.outline-edge-type {
  font-weight: 500;
  color: var(--text);
  text-transform: capitalize;
}

.outline-edge-target { font-size: 12px; font-weight: 400; }

@media (forced-colors: active) {
  .outline-item { border: 1px solid ButtonText; }
  .outline-node-btn { forced-color-adjust: auto; }
}

/* Node styles */
.node-group { cursor: grab; transition: opacity 0.15s; }
.node-group:active { cursor: grabbing; }
.node-group:hover .node-rect { stroke: var(--accent); stroke-width: 2; }
.hide-node-btn:hover { background: var(--err-bg-hover) !important; }

.node-rect {
  rx: 6;
  ry: 6;
  stroke-width: 1;
}

.node-rect--content   { fill: var(--node-content-fill); stroke: var(--node-content-stroke); }
.node-rect--question  { fill: var(--node-question-fill); stroke: var(--node-question-stroke); }
.node-rect--check-answers { fill: var(--node-check-answers-fill); stroke: var(--node-check-answers-stroke); }
.node-rect--confirmation { fill: var(--node-confirmation-fill); stroke: var(--node-confirmation-stroke); }
.node-rect--error     { fill: var(--node-error-fill); stroke: var(--node-error-stroke); }
.node-rect--splash    { fill: var(--node-splash-fill); stroke: var(--node-splash-stroke); }
.node-rect--index     { fill: var(--node-index-fill); stroke: var(--node-index-stroke); }
/* Selected node (panel open). The class lands on the parent <g>, so we
 * scope the stroke change to the inner .node-rect — applying stroke
 * directly on the <g> would inherit through SVG to every <text> child
 * and render labels with outlined characters. */
.node-rect--highlight .node-rect { stroke: var(--highlight) !important; stroke-width: 3 !important; }
.node-rect--highlight .node-label { fill: var(--highlight); }
/* iOS / native platform node types */
.node-rect--screen    { fill: var(--node-screen-fill); stroke: var(--node-screen-stroke); }
.node-rect--web-view  { fill: var(--node-web-view-fill); stroke: var(--node-web-view-stroke); }
.node-rect--external  { fill: var(--node-external-fill); stroke: var(--node-external-stroke); }
/* Web jump-off pages — discovered by the web crawler and spliced into
   native maps. Upgraded jump-off roots (native screens that hand off to a
   web prototype) get a slightly heavier stroke to stand out as the bridge
   between native and web regions. */
.node-rect--web-page          { fill: var(--node-web-page-fill); stroke: var(--node-web-page-stroke); stroke-dasharray: 4,2; }
.node-rect--web-page.subgraph-root { stroke-width: 2.2; stroke-dasharray: none; }

.node-label {
  fill: var(--node-label);
  font-size: 11px;
  font-weight: 500;
  text-anchor: middle;
  pointer-events: none;
}

.node-path-label {
  fill: var(--node-label-muted);
  font-size: 9px;
  text-anchor: middle;
  pointer-events: none;
}

.node-type-badge {
  fill: var(--node-label-muted);
  font-size: 8px;
  text-anchor: middle;
  pointer-events: none;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.node-screenshot {
  pointer-events: none;
  opacity: 0.9;
}

/* Edge styles */
.edge-path {
  fill: none;
  transition: opacity 0.15s;
}

.edge-path--form        { stroke: var(--edge-form); stroke-width: 2; opacity: 0.85; }
.edge-path--link        { stroke: var(--edge-link); stroke-width: 1.2; opacity: 0.75; }
.edge-path--conditional { stroke: var(--edge-conditional); stroke-width: 1; stroke-dasharray: 6,3; opacity: 0.7; }
.edge-path--redirect    { stroke: var(--edge-redirect); stroke-width: 1; stroke-dasharray: 3,3; opacity: 0.85; }
.edge-path--render      { stroke: var(--edge-render); stroke-width: 1; opacity: 0.85; }
.edge-path--nav         { stroke: var(--edge-nav); stroke-width: 1; stroke-dasharray: 8,4; opacity: 0.75; }
/* iOS / native platform edge types */
.edge-path--sheet       { stroke: var(--edge-sheet); stroke-width: 1.5; stroke-dasharray: 5,3; opacity: 0.8; }
.edge-path--full-screen { stroke: var(--edge-full-screen); stroke-width: 2; opacity: 0.85; }
.edge-path--tab         { stroke: var(--edge-tab); stroke-width: 1.5; opacity: 0.75; }
.edge-path--web-view    { stroke: var(--edge-web-view); stroke-width: 1.5; stroke-dasharray: 4,3; opacity: 0.75; }
.edge-path--safari      { stroke: var(--edge-safari); stroke-width: 1; stroke-dasharray: 3,3; opacity: 0.75; }

.edge-label {
  font-size: 9px;
  fill: var(--edge-label);
  pointer-events: none;
}

.edge-condition-label {
  font-size: 8px;
  fill: var(--edge-condition-label);
  pointer-events: none;
  font-style: italic;
}

.edge-arrowhead { fill: var(--edge-link); }
.edge-arrowhead--form { fill: var(--edge-form); }
.edge-arrowhead--conditional { fill: var(--edge-conditional); }
.edge-arrowhead--redirect { fill: var(--edge-redirect); }
.edge-arrowhead--render { fill: var(--edge-render); }
.edge-arrowhead--nav { fill: var(--edge-nav); }
/* iOS / native platform arrowheads */
.edge-arrowhead--sheet       { fill: var(--edge-sheet); }
.edge-arrowhead--full-screen { fill: var(--edge-full-screen); }
.edge-arrowhead--tab         { fill: var(--edge-tab); }
.edge-arrowhead--web-view    { fill: var(--edge-web-view); }
.edge-arrowhead--safari      { fill: var(--edge-safari); }

.node-rect--start-node {
  stroke: var(--accent) !important;
  stroke-width: 2.5 !important;
  filter: drop-shadow(0 0 4px rgba(var(--accent-rgb), 0.4));
}

.start-node-badge {
  font-size: 9px;
  font-weight: 600;
  fill: var(--accent);
  letter-spacing: 1.5px;
}

/* Detail panel */
#detail-panel {
  position: fixed;
  top: 50px;
  right: 0;
  bottom: 0;
  width: 380px;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
  padding: 16px;
  overflow-y: auto;
  z-index: 50;
  transition: transform 0.2s ease;
}

#detail-panel.hidden {
  transform: translateX(100%);
}

#close-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
}

#panel-content h2 {
  font-size: 16px;
  margin-bottom: 8px;
  color: var(--text-strong);
}

#panel-content .panel-screenshot {
  width: 100%;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-bottom: 12px;
}

#panel-content .panel-meta {
  font-size: 12px;
  color: var(--text-meta-value);
  margin-bottom: 12px;
}

#panel-content .panel-meta dt {
  font-weight: 600;
  color: var(--text-meta-key);
  margin-top: 8px;
}

#panel-content .panel-meta dd {
  margin-left: 0;
  margin-top: 2px;
}

#panel-content .panel-links {
  list-style: none;
  padding: 0;
}

#panel-content .panel-links li {
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

#panel-content .panel-links .link-target {
  color: var(--accent);
}

#panel-content .panel-links .link-condition {
  color: var(--warn);
  font-style: italic;
  font-size: 11px;
}

#panel-content .panel-links .link-edge-type {
  color: var(--text-subtle);
}

/* "Hide this page" button at the bottom of the detail panel.
 * Pulled out of an inline style so it follows the theme. */
.hide-node-btn {
  margin-top: 12px;
  background: var(--err-bg);
  color: var(--err-fg);
  border: 1px solid var(--err-border);
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  width: 100%;
}

.edge-provenance-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.edge-provenance--runtime {
  background: var(--provenance-runtime-bg);
  color: var(--provenance-runtime-fg);
}

.edge-provenance--static {
  background: var(--provenance-static-bg);
  color: var(--provenance-static-fg);
}

.edge-provenance--both {
  background: var(--provenance-both-bg);
  color: var(--provenance-both-fg);
}

.edge-provenance--nav {
  background: var(--provenance-nav-bg);
  color: var(--provenance-nav-fg);
}

/* Legend */
#legend {
  position: fixed;
  bottom: 16px;
  left: 16px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-size: 11px;
  z-index: 50;
}

#legend h3 {
  font-size: 12px;
  margin-bottom: 6px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.legend-swatch {
  width: 20px;
  height: 3px;
  border-radius: 1px;
}

/* Edge-type swatches — moved out of inline styles in the legend markup
 * so colours follow the theme. Shape (solid vs dashed border) mirrors
 * the corresponding edge-path-- rule. */
.legend-swatch--form        { background: var(--edge-form); height: 2px; }
.legend-swatch--link        { background: var(--edge-link); height: 1.5px; }
.legend-swatch--conditional { height: 1px; border-top: 1px dashed var(--edge-conditional); background: none; }
.legend-swatch--nav         { height: 1px; border-top: 1px dashed var(--edge-nav); background: none; }
.legend-swatch--sheet       { height: 1.5px; border-top: 1.5px dashed var(--edge-sheet); background: none; }
.legend-swatch--full-screen { background: var(--edge-full-screen); height: 2px; }
.legend-swatch--web-view    { height: 1.5px; border-top: 1.5px dashed var(--edge-web-view); background: none; }
.legend-swatch--safari      { height: 1px; border-top: 1px dashed var(--edge-safari); background: none; }

/* Provenance legend swatches (rendered only when hasProvenance) */
.legend-swatch--solid {
  background: var(--edge-link);
  height: 2px;
}

.legend-swatch--dashed {
  height: 1px;
  border-top: 2px dashed var(--purple);
  background: none;
}

.legend-swatch--both {
  background: linear-gradient(90deg, var(--provenance-both-grad-1) 50%, var(--provenance-both-grad-2) 50%);
  height: 2px;
}

.scenario-name {
  color: var(--accent);
  font-size: 15px;
}

/* Provenance-based edge opacity modifiers */
.edge-path--static-provenance {
  stroke-dasharray: 4,3 !important;
  opacity: 0.5 !important;
}

.edge-path--global-nav-edge {
  opacity: 0.3 !important;
}

/* Save layout button states */
#save-layout-btn.save-btn--dirty {
  border-color: var(--warn) !important;
  color: var(--warn) !important;
}

#save-layout-btn.save-btn--saved {
  border-color: var(--ok) !important;
  color: var(--ok) !important;
}

#save-layout-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Right-click context menu on nodes */
.node-context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--surface-2);
  border: 1px solid var(--border-popover);
  border-radius: 4px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  min-width: 200px;
  padding: 4px;
  font-size: 13px;
  color: var(--text-popover);
}

.node-context-menu .ncm-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  color: inherit;
  padding: 7px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}

.node-context-menu .ncm-item:hover {
  background: var(--border-popover-2);
  color: var(--err-fg-soft);
}

/* Hidden-list popover (toolbar Show hidden button) */
.hidden-list-popover {
  position: fixed;
  z-index: 1000;
  background: var(--surface-2);
  border: 1px solid var(--border-popover);
  border-radius: 4px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
  min-width: 280px;
  max-width: 360px;
  max-height: 400px;
  overflow-y: auto;
  font-size: 13px;
  color: var(--text-popover);
}

.hidden-list-popover .hlp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-popover-2);
  background: var(--surface-3);
  font-weight: 500;
}

.hidden-list-popover .hlp-restore-all {
  background: transparent;
  color: var(--accent-link);
  border: 1px solid var(--border-popover-2);
  border-radius: 3px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}

.hidden-list-popover .hlp-restore-all:hover {
  background: var(--border-popover-2);
  color: var(--accent-soft);
}

.hidden-list-popover .hlp-empty {
  padding: 12px;
  color: var(--text-meta-faint);
  font-style: italic;
  text-align: center;
}

.hidden-list-popover .hlp-list {
  list-style: none;
  margin: 0;
  padding: 4px;
}

.hidden-list-popover .hlp-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 3px;
}

.hidden-list-popover .hlp-list li:hover {
  background: var(--border-popover-2);
}

.hidden-list-popover .hlp-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-list-popover .hlp-restore {
  background: transparent;
  color: var(--accent-link);
  border: 1px solid var(--border-popover-2);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  flex-shrink: 0;
}

.hidden-list-popover .hlp-restore:hover {
  background: var(--border-popover-2);
  color: var(--accent-soft);
}

/* Move-mode indicator on the focused node (Phase 4). Distinct stroke
 * + dashed outline so a sighted keyboard user can tell move mode from
 * the regular focus state. The pattern is reset by reduced-motion via
 * the global rule below. */
.node-rect--move-mode {
  stroke: var(--warn) !important;
  stroke-width: 3 !important;
  stroke-dasharray: 6 4 !important;
  animation: flowmap-move-pulse 1.4s ease-in-out infinite;
}

@keyframes flowmap-move-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.45; }
}

/* role="menuitem" / role="menu" — keep the existing visual style but
 * add a focus ring so keyboard users see the active item. */
.node-context-menu[role="menu"] { outline: none; }
.node-context-menu .ncm-item:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
  background: var(--border-popover-2);
}

/* Hidden-list popover dialog header */
.hidden-list-popover .hlp-title {
  font-weight: 500;
  font-size: 13px;
}

.hidden-list-popover .hlp-restore-all:focus-visible,
.hidden-list-popover .hlp-restore:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/* Keyboard-shortcuts help dialog (Phase 4). Modal — paints an overlay
 * that dims the canvas and a centred card with the shortcut tables. */
.kb-help-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1100;
}

.kb-help-overlay[hidden],
.kb-help-dialog[hidden] { display: none; }

.kb-help-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1101;
  background: var(--surface-1);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  color: var(--text);
}

.kb-help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.kb-help-header h2 {
  margin: 0;
  font-size: 15px;
  color: var(--text-strong);
}

#kb-help-close {
  background: none;
  border: 0;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

#kb-help-close:hover { color: var(--text); }
#kb-help-close:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.kb-help-body {
  padding: 14px 18px 18px;
  overflow-y: auto;
  font-size: 13px;
}

.kb-help-body h3 {
  margin: 14px 0 6px;
  font-size: 12px;
  color: var(--text-meta-key);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.kb-help-body h3:first-child { margin-top: 0; }

.kb-help-list {
  display: grid;
  grid-template-columns: minmax(120px, max-content) 1fr;
  column-gap: 16px;
  row-gap: 6px;
  margin: 0;
}

.kb-help-list dt {
  font-weight: 500;
  color: var(--text-meta-key);
}

.kb-help-list dd {
  margin: 0;
  color: var(--text-meta-value);
}

.kb-help-list kbd {
  display: inline-block;
  background: var(--surface-3);
  border: 1px solid var(--border-popover-2);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 1px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-strong);
  line-height: 1.4;
}

#node-actions-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Reduced motion: kill the panel slide and edge/node opacity transitions
 * for users with vestibular sensitivity. WCAG 2.3.3 (AAA) but harmless. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}

/* Forced colours (Windows High Contrast and similar): map UI surfaces
 * to system colour keywords so the viewer remains operable when the OS
 * overrides our palette. */
@media (forced-colors: active) {
  body { background: Canvas; color: CanvasText; }
  #toolbar, #legend, #detail-panel,
  .node-context-menu, .hidden-list-popover {
    background: Canvas; border-color: CanvasText; color: CanvasText;
  }
  .toolbar-controls button,
  .toolbar-controls select,
  .toolbar-controls input {
    border-color: CanvasText; color: CanvasText; background: Canvas;
  }
  .toolbar-controls button:focus-visible,
  .toolbar-controls select:focus-visible,
  .toolbar-controls input:focus-visible,
  .back-to-index:focus-visible,
  #close-panel:focus-visible,
  .hide-node-btn:focus-visible {
    outline: 3px solid Highlight; outline-offset: 2px;
  }
  .node-rect--highlight .node-rect { stroke: Highlight !important; }
  .node-rect--highlight .node-label { fill: Highlight; }
  .node-rect--start-node { stroke: Highlight !important; filter: none; }
  .node-group:focus-visible .node-rect,
  .node-rect--focused {
    stroke: Highlight !important; stroke-width: 3 !important;
  }
  .node-rect--move-mode {
    stroke: Mark !important; stroke-width: 3 !important;
  }
  .kb-help-dialog,
  .node-context-menu,
  .hidden-list-popover {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
  .kb-help-overlay { background: rgba(0, 0, 0, 0.5); }
  .kb-help-list kbd {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
}
`;
}

function generateViewerJs() {
  return `
(async function() {
  // Sidecar-first data load. When the page is served over http(s),
  // fetch() resolves and we override the inline data island with the
  // sidecars — that lets a viewer.js upgrade pick up data the inline
  // copy doesn't yet know about. On file:// most browsers reject the
  // fetch (CORS-on-local-files), in which case the inline window.__*
  // values from index.html stand. Either way the rest of init runs
  // synchronously below.
  try {
    const [graphResp, runtimeResp] = await Promise.all([
      fetch('./graph-data.json'),
      fetch('./runtime.json'),
    ]);
    if (graphResp && graphResp.ok) {
      window.__GRAPH_DATA__ = await graphResp.json();
    }
    if (runtimeResp && runtimeResp.ok) {
      const r = await runtimeResp.json();
      if (typeof r.hasScreenshots === 'boolean') window.__HAS_SCREENSHOTS__ = r.hasScreenshots;
      if (r.viewport) {
        if (typeof r.viewport.width === 'number') window.__VIEWPORT_WIDTH__ = r.viewport.width;
        if (typeof r.viewport.height === 'number') window.__VIEWPORT_HEIGHT__ = r.viewport.height;
      }
      if (typeof r.generationId === 'string') window.__GENERATION_ID__ = r.generationId;
      if (typeof r.mapName === 'string') window.__MAP_NAME__ = r.mapName;
      if (r.savedPositions && typeof r.savedPositions === 'object') window.__SAVED_POSITIONS__ = r.savedPositions;
      if (r.savedHidden && typeof r.savedHidden === 'object') window.__SAVED_HIDDEN__ = r.savedHidden;
    }
  } catch (e) {
    // file:// path or sidecars unavailable — inline values already populated.
  }

  const graph = window.__GRAPH_DATA__;
  const hasScreenshots = window.__HAS_SCREENSHOTS__;
  const svg = document.getElementById('flow-svg');
  const container = document.getElementById('canvas-container');

  // State
  let transform = { x: 0, y: 0, scale: 1 };
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let layoutNodes = {};
  let layoutEdges = [];
  let showLabels = true;
  let thumbnailMode = false; // false = full page, true = compact thumbnail
  let hideScreenshots = false;
  let hubFilter = '';
  let searchTerm = '';
  let showGlobalNav = false;
  let provenanceFilter = '';
  let outlineMode = false;

  // Generation ID — changes each time the map is rebuilt, so stale
  // localStorage data (positions) is automatically ignored. Hidden nodes
  // intentionally use a stable key (pathname only) so user-curated hide
  // state survives regeneration; see the hiddenStorageKey definition below.
  const genId = window.__GENERATION_ID__ || '';
  const storageSuffix = location.pathname + (genId ? '-' + genId : '');

  // Persist view mode preference (not scoped to generation — user preference)
  const viewModeKey = 'flowmap-viewmode-' + location.pathname;
  try { thumbnailMode = localStorage.getItem(viewModeKey) === 'thumbnail'; } catch(e) {}

  // Hidden nodes (viewer-time exclusion, persisted in localStorage).
  // Storage key is keyed on pathname only — NOT on storageSuffix — so hidden
  // state survives regeneration. Stale entries for node IDs that no longer
  // exist are harmless (the layout filter is a Set membership check; missing
  // IDs just don't match anything). Server-backed persistence with cross-
  // device durability is the next step (see plans/roadmap.md WS3).
  let hiddenNodes = new Set();
  const hiddenStorageKey = 'flowmap-hidden-' + location.pathname;
  try {
    const savedHidden = localStorage.getItem(hiddenStorageKey);
    if (savedHidden) hiddenNodes = new Set(JSON.parse(savedHidden));
  } catch(e) {}

  function saveHiddenNodes() {
    try { localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenNodes])); } catch(e) {}
    // Mirror to server when in serve mode (fire-and-forget; failures logged).
    saveHiddenToServer();
  }

  // Global forward adjacency, built once from all non-nav edges in the graph.
  // Used by the right-click "Hide subgraph" handler to BFS down to descendants
  // regardless of current filter state. Distinct from the per-render forwardAdj
  // built inside layoutGraph() (which is filtered by the current node-visibility set).
  const globalForwardAdj = {};
  graph.edges.forEach(e => {
    if (e.type === 'nav') return;
    if (!globalForwardAdj[e.source]) globalForwardAdj[e.source] = [];
    globalForwardAdj[e.source].push(e.target);
  });

  function collectDescendants(rootId) {
    const out = new Set();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      (globalForwardAdj[id] || []).forEach(t => {
        if (!out.has(t) && t !== rootId) {
          out.add(t);
          queue.push(t);
        }
      });
    }
    return out;
  }

  // Manual node positions (drag-to-reposition, persisted in localStorage)
  let manualPositions = {};
  let isDragging = false;
  let dragTarget = null;

  // Roving-tabindex focus state. focusedNodeId tracks which node
  // currently holds tabindex="0" in the listbox; siblingCursor records
  // the structural-traversal context so ] cycles through siblings of
  // the same parent before descending to children. Both are reset on
  // spatial navigation and on filter/render cycles that drop the node.
  let focusedNodeId = null;
  let siblingCursor = null;

  // Move mode (Phase 4 — keyboard alternative to drag-to-reposition).
  // When active, arrow keys nudge the focused node instead of moving
  // selection. Enter commits, Escape reverts to original{X,Y}.
  let moveMode = null;
  // Help-dialog open flag — when true, document-level shortcuts are
  // suppressed so keys land in the dialog's focus trap.
  let helpDialogOpen = false;
  const prefersReducedMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const posStorageKey = 'flowmap-positions-' + storageSuffix;
  try {
    const savedPos = localStorage.getItem(posStorageKey);
    if (savedPos) manualPositions = JSON.parse(savedPos);
  } catch(e) {}

  function savePositions() {
    try { localStorage.setItem(posStorageKey, JSON.stringify(manualPositions)); } catch(e) {}
  }

  // Server-saved positions (embedded at build time from positions.json).
  // These serve as the baseline when no localStorage or API positions exist.
  const embeddedPositions = window.__SAVED_POSITIONS__ || {};
  if (Object.keys(manualPositions).length === 0 && Object.keys(embeddedPositions).length > 0) {
    manualPositions = { ...embeddedPositions };
  }

  // Server-saved hidden nodes (embedded at build time from hidden.json).
  // Carry-forward baseline when no localStorage or API hidden state exists.
  const embeddedHidden = window.__SAVED_HIDDEN__ || {};
  if (hiddenNodes.size === 0 && Object.keys(embeddedHidden).length > 0) {
    hiddenNodes = new Set(Object.keys(embeddedHidden));
  }

  // Serve-mode state
  let isServeMode = false;
  let hasUnsavedChanges = false;
  const mapName = window.__MAP_NAME__ || '';

  // Fire-and-forget save of hidden state to the server (when in serve mode).
  // localStorage save still happens via saveHiddenNodes(); this is additive.
  // Failures log to console but don't disturb the UI — localStorage is the
  // source of truth on next load until the next successful API write.
  async function saveHiddenToServer() {
    if (!isServeMode || !mapName) return;
    try {
      const payload = {};
      hiddenNodes.forEach(id => { payload[id] = true; });
      const resp = await fetch('/api/maps/' + encodeURIComponent(mapName) + '/hidden', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) console.warn('[flow-map] Failed to save hidden state to server:', resp.status);
    } catch (e) {
      console.warn('[flow-map] Error saving hidden state:', e);
    }
  }

  // Screenshot viewport ratio (default 375x812 mobile)
  const VIEWPORT_WIDTH = window.__VIEWPORT_WIDTH__ || 375;
  const VIEWPORT_HEIGHT = window.__VIEWPORT_HEIGHT__ || 812;

  // Node sizing constants
  const NODE_WIDTH = 140;
  const LABEL_AREA = 32;
  const IMG_PAD = 3;

  // Returns { w, h } for a node, varying by thumbnailMode.
  // When a node has a screenshotAspectRatio, use it for dynamic height.
  function getNodeDims(node) {
    const w = NODE_WIDTH;
    if (!hasScreenshots || hideScreenshots) {
      return { w, h: 56 };
    }
    const imgW = w - IMG_PAD * 2;
    if (thumbnailMode) {
      return { w, h: 90 + LABEL_AREA + IMG_PAD };
    }
    const ratio = (node && node.screenshotAspectRatio)
      ? node.screenshotAspectRatio
      : VIEWPORT_HEIGHT / VIEWPORT_WIDTH;
    const imgH = Math.round(imgW * ratio);
    return { w, h: imgH + LABEL_AREA + IMG_PAD };
  }

  // Layout the graph using dagre
  function layoutGraph() {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'TB',
      nodesep: 15,
      ranksep: 50,
      edgesep: 8,
      marginx: 30,
      marginy: 30,
      align: 'UL',
    });
    g.setDefaultEdgeLabel(() => ({}));

    const filteredNodes = graph.nodes.filter(n => {
      if (hiddenNodes.has(n.id)) return false;
      if (hubFilter && n.hub !== hubFilter) return false;
      if (searchTerm && !n.label.toLowerCase().includes(searchTerm) && !n.urlPath.toLowerCase().includes(searchTerm)) return false;
      return true;
    });

    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

    filteredNodes.forEach(node => {
      const { w, h } = getNodeDims(node);
      g.setNode(node.id, { width: w, height: h, ...node });
    });

    // Identify start nodes and collect their IDs for layout pinning
    const startNodes = filteredNodes.filter(n => n.isStartNode);
    const startNodeIds = new Set(startNodes.map(n => n.id));

    // Build rank and visit-order lookups for visit-driven layout
    const nodeRank = {};
    const nodeVisitOrder = {};
    const hasRanks = filteredNodes.some(n => n.layoutRank !== undefined);
    if (hasRanks) {
      filteredNodes.forEach(n => {
        if (n.layoutRank !== undefined) nodeRank[n.id] = n.layoutRank;
        if (n.visitOrder !== undefined) nodeVisitOrder[n.id] = n.visitOrder;
      });
    }
    const hasVisitOrder = Object.keys(nodeVisitOrder).length > 0;

    // Separate nav edges and incoming-to-start edges from dagre-layoutable edges
    const navEdges = [];
    const incomingToStartEdges = [];
    const lateralEdges = []; // within-rank edges (tab siblings) — rendered but not laid out
    const backwardEdges = []; // higher rank → lower rank — rendered but not laid out
    const filteredEdges = graph.edges.filter(e => {
      if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return false;
      // Global nav filter: hide global nav edges unless toggled on
      if (e.isGlobalNav && !showGlobalNav) return false;
      // Provenance filter
      if (provenanceFilter && e.provenance && e.provenance !== provenanceFilter) return false;
      if (e.type === 'nav') { navEdges.push(e); return false; }

      // When layout ranks are available, only include forward edges in dagre
      if (hasRanks && nodeRank[e.source] !== undefined && nodeRank[e.target] !== undefined) {
        if (nodeRank[e.source] === nodeRank[e.target]) {
          lateralEdges.push(e);
          return false;
        }
        if (nodeRank[e.source] > nodeRank[e.target]) {
          backwardEdges.push(e);
          return false;
        }
      }

      // Exclude incoming edges to start nodes from dagre so they stay at top rank.
      if (startNodeIds.size >= 1 && startNodeIds.has(e.target) && !startNodeIds.has(e.source)) {
        incomingToStartEdges.push(e);
        return false;
      }
      return true;
    });

    filteredEdges.forEach((edge, i) => {
      g.setEdge(edge.source, edge.target, { ...edge, id: 'edge-' + i });
    });

    // Add virtual root to pin start nodes to the top rank.
    const virtualRootId = '__virtual_root__';
    if (startNodes.length >= 1) {
      g.setNode(virtualRootId, { width: 0, height: 0 });
      startNodes.forEach(n => {
        g.setEdge(virtualRootId, n.id, { weight: 2, minlen: 1 });
      });
    }

    dagre.layout(g);

    layoutNodes = {};
    g.nodes().forEach(id => {
      if (id === virtualRootId) return;
      layoutNodes[id] = g.node(id);
    });

    // Top-align nodes within each dagre rank.
    // Dagre centers nodes on the rank's y-line, which misaligns nodes of different heights.
    // Group by dagre rank (approximate y center) and shift each node so its top edge aligns.
    if (!hasRanks) {
      const RANK_TOLERANCE = 5; // nodes within 5px of same y are in same rank
      const rankGroups = {};
      Object.values(layoutNodes).forEach(n => {
        const roundedY = Math.round(n.y / RANK_TOLERANCE) * RANK_TOLERANCE;
        if (!rankGroups[roundedY]) rankGroups[roundedY] = [];
        rankGroups[roundedY].push(n);
      });
      Object.values(rankGroups).forEach(group => {
        if (group.length < 2) return;
        // Find the topmost top-edge in this rank
        const minTop = Math.min(...group.map(n => n.y - n.height / 2));
        group.forEach(n => {
          n.y = minTop + n.height / 2;
        });
      });
    }

    // When rank data is available, compute the full grid layout ourselves
    // instead of relying on dagre's X positions (which were computed for
    // dagre's own rank structure, not ours).
    if (hasRanks) {
      const RANK_GAP = 50;
      const HORIZ_GAP = 15;
      const MARGIN_X = 30;

      // Bucket nodes by rank, sorted by visit order within each rank
      const rankBuckets = {};
      Object.keys(layoutNodes).forEach(id => {
        const r = nodeRank[id];
        if (r === undefined) return;
        if (!rankBuckets[r]) rankBuckets[r] = [];
        rankBuckets[r].push(id);
      });

      const sortedRanks = Object.keys(rankBuckets).map(Number).sort((a, b) => a - b);
      sortedRanks.forEach(rank => {
        rankBuckets[rank].sort((a, b) => (nodeVisitOrder[a] ?? 999) - (nodeVisitOrder[b] ?? 999));
      });

      // Compute Y positions: stack ranks top-to-bottom
      let currentTop = 30;
      const rankY = {};
      sortedRanks.forEach(rank => {
        const ids = rankBuckets[rank];
        const maxH = Math.max(...ids.map(id => layoutNodes[id].height));
        rankY[rank] = currentTop;
        ids.forEach(id => {
          layoutNodes[id].y = currentTop + layoutNodes[id].height / 2;
        });
        currentTop += maxH + RANK_GAP;
      });

      // Compute X positions.
      // When subgraph ownership is available (native-mobile pipeline), pack
      // each subgraph into its own column: columns sit left-to-right in
      // startOrder, each rank row centers on its column's midpoint. Otherwise
      // fall back to the original global-centered layout.
      const hasOwners = filteredNodes.some(n => n.subgraphOwner !== undefined);
      const COLUMN_GAP = 60;

      if (hasOwners) {
        // Group nodes by (owner, rank).
        // Nodes without a layoutRank get placed in a catch-all "overflow"
        // column at the end of the canvas — previously they were silently
        // skipped, which hid any BFS-discovered web-page children whose
        // layout metadata the splice failed to populate. The overflow column
        // ensures those nodes are still visible so the bug is loud, not
        // silent.
        const columnsByOwner = {};
        const overflowIds = [];
        filteredNodes.forEach(n => {
          if (!layoutNodes[n.id]) return;
          const rank = nodeRank[n.id];
          if (rank === undefined) {
            overflowIds.push(n.id);
            return;
          }
          const owner = n.subgraphOwner || n.id;
          if (!columnsByOwner[owner]) {
            const ownerNode = filteredNodes.find(x => x.id === owner);
            columnsByOwner[owner] = {
              owner,
              order: ownerNode && ownerNode.startOrder !== undefined ? ownerNode.startOrder : Infinity,
              rankIds: {},
            };
          }
          if (!columnsByOwner[owner].rankIds[rank]) columnsByOwner[owner].rankIds[rank] = [];
          columnsByOwner[owner].rankIds[rank].push(n.id);
        });
        if (overflowIds.length > 0 && typeof console !== 'undefined') {
          console.warn('[flow-map] ' + overflowIds.length + ' node(s) lack layoutRank/subgraphOwner and were placed in an overflow column:', overflowIds.slice(0, 5));
        }

        const columns = Object.values(columnsByOwner).sort((a, b) => a.order - b.order);

        let currentLeft = MARGIN_X;
        columns.forEach(col => {
          const ranks = Object.keys(col.rankIds);
          // Column width = widest rank row in this subgraph.
          let colWidth = 0;
          ranks.forEach(r => {
            const ids = col.rankIds[r];
            const rowW = ids.reduce((sum, id) => sum + layoutNodes[id].width, 0)
              + HORIZ_GAP * Math.max(0, ids.length - 1);
            if (rowW > colWidth) colWidth = rowW;
          });
          const colCenterX = currentLeft + colWidth / 2;

          ranks.forEach(r => {
            const ids = col.rankIds[r];
            const rowWidth = ids.reduce((sum, id) => sum + layoutNodes[id].width, 0)
              + HORIZ_GAP * Math.max(0, ids.length - 1);
            let x = colCenterX - rowWidth / 2;
            ids.forEach(id => {
              const n = layoutNodes[id];
              n.x = x + n.width / 2;
              x += n.width + HORIZ_GAP;
            });
          });

          currentLeft += colWidth + COLUMN_GAP;
        });

        // Overflow column: pack unranked nodes into a rightmost column so
        // they stay visible. They keep whatever Y dagre assigned, so if a
        // handful slip through they still don't stack on top of each other.
        if (overflowIds.length > 0) {
          const colWidth = Math.max(
            ...overflowIds.map(id => layoutNodes[id].width),
            NODE_WIDTH,
          );
          const colCenterX = currentLeft + colWidth / 2;
          overflowIds.forEach(id => {
            const n = layoutNodes[id];
            n.x = colCenterX;
          });
        }
      } else {
        // No subgraph owners detected (e.g. iOS without tabs, or any prototype
        // whose graph-builder didn't assign owners). The previous behaviour
        // here was to centre every rank row at a single global X, which
        // collapsed the map into a vertical blob with no horizontal spread.
        //
        // Instead, keep dagre's computed X positions: dagre laid out the real
        // edges with rankdir: 'TB', so its X reflects tree structure (children
        // sit horizontally under their parents). We've already overwritten Y
        // above with our rank-based stacking, so the result is dagre's tree
        // shape projected onto our cleaner rank rows.
        //
        // See plans/roadmap.md WS2 Part A. Part B (generalised virtual
        // subgraph-owner inference) is the deeper improvement on top of this.
      }
    }

    // Assign each node to its nearest start node's subgraph (multi-source BFS)
    const subgraphOf = {};
    if (startNodes.length > 1) {
      // Build adjacency from ALL graph edges (not just dagre-filtered ones)
      // so that crawler-discovered edges don't change subgraph assignment
      const forwardAdj = {};
      const reverseAdj = {};
      graph.edges.forEach(e => {
        if (e.type === 'nav') return;
        if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return;
        if (!forwardAdj[e.source]) forwardAdj[e.source] = [];
        forwardAdj[e.source].push(e.target);
        if (!reverseAdj[e.target]) reverseAdj[e.target] = [];
        reverseAdj[e.target].push(e.source);
      });

      // Multi-source BFS: all start nodes enqueued at distance 0.
      // Processes level-by-level so each node is claimed by its nearest start node.
      const queue = [];
      [...startNodes]
        .sort((a, b) => (a.startOrder || 0) - (b.startOrder || 0))
        .forEach(n => {
          subgraphOf[n.id] = n.id;
          queue.push(n.id);
        });

      let head = 0;
      while (head < queue.length) {
        const current = queue[head++];
        const owner = subgraphOf[current];
        (forwardAdj[current] || []).forEach(t => {
          if (subgraphOf[t] === undefined) {
            subgraphOf[t] = owner;
            queue.push(t);
          }
        });
      }

      // Reverse-edge pass: assign orphan nodes that weren't reached by the
      // forward BFS. These are nodes that have edges pointing TO nodes in an
      // assigned subgraph (e.g. a warning screen that links to home) but no
      // forward path from any start node reaches them. We iteratively assign
      // orphans via their outgoing (forward) edges first, then incoming
      // (reverse) edges, until no more assignments can be made.
      let changed = true;
      while (changed) {
        changed = false;
        Object.keys(layoutNodes).forEach(nodeId => {
          if (subgraphOf[nodeId] !== undefined) return;
          // Try forward edges first: if this node points to an assigned node,
          // join that subgraph (the orphan feeds into that subgraph).
          const forwardTargets = forwardAdj[nodeId] || [];
          for (const t of forwardTargets) {
            if (subgraphOf[t] !== undefined) {
              subgraphOf[nodeId] = subgraphOf[t];
              changed = true;
              return;
            }
          }
          // Try reverse edges: if an assigned node points to this node,
          // join that subgraph.
          const reverseSources = reverseAdj[nodeId] || [];
          for (const s of reverseSources) {
            if (subgraphOf[s] !== undefined) {
              subgraphOf[nodeId] = subgraphOf[s];
              changed = true;
              return;
            }
          }
        });
      }
    }

    // When multiple start nodes exist, re-layout each subgraph independently
    // with dagre and place them side by side in startOrder. The full-graph
    // dagre layout interleaves nodes from different subgraphs, inflating
    // bounding boxes and making post-hoc separation unreliable. Per-subgraph
    // dagre runs produce compact layouts with honest widths.
    if (startNodes.length > 1) {
      const subGap = 40;
      const subMargin = 30;

      const sortedStarts = startNodes
        .map(n => layoutNodes[n.id])
        .filter(Boolean)
        .sort((a, b) => (a.startOrder || 0) - (b.startOrder || 0));

      if (sortedStarts.length > 1) {
        // Bucket nodes by subgraph owner
        const subNodeIds = {};
        Object.keys(layoutNodes).forEach(nodeId => {
          const owner = startNodeIds.has(nodeId) ? nodeId : subgraphOf[nodeId];
          if (!owner) return;
          if (!subNodeIds[owner]) subNodeIds[owner] = [];
          subNodeIds[owner].push(nodeId);
        });

        let currentX = subMargin;
        sortedStarts.forEach(startNode => {
          const nodeIds = subNodeIds[startNode.id] || [startNode.id];
          const nodeIdSet = new Set(nodeIds);

          // Create a fresh dagre graph for this subgraph only
          const sg = new dagre.graphlib.Graph();
          sg.setGraph({
            rankdir: 'TB',
            nodesep: 15,
            ranksep: 50,
            edgesep: 8,
            marginx: 0,
            marginy: 0,
            align: 'UL',
          });
          sg.setDefaultEdgeLabel(() => ({}));

          // Add this subgraph's nodes with their current dimensions
          nodeIds.forEach(id => {
            const n = layoutNodes[id];
            if (!n) return;
            sg.setNode(id, { width: n.width, height: n.height });
          });

          // Add only edges where both endpoints are in this subgraph
          graph.edges.forEach((e, i) => {
            if (!nodeIdSet.has(e.source) || !nodeIdSet.has(e.target)) return;
            if (e.type === 'nav') return;
            if (e.isGlobalNav && !showGlobalNav) return;
            if (provenanceFilter && e.provenance && e.provenance !== provenanceFilter) return;
            // Exclude incoming edges to the start node so it stays at the top
            // rank (mirrors the same filtering in the main dagre graph).
            // Without this, nodes like a warning screen that link TO the start
            // node get placed above it by dagre.
            if (e.target === startNode.id && e.source !== startNode.id) return;
            sg.setEdge(e.source, e.target, { id: 'sub-edge-' + i });
          });

          // Pin the start node to the top rank via a virtual root
          const vRoot = '__vr__';
          sg.setNode(vRoot, { width: 0, height: 0 });
          sg.setEdge(vRoot, startNode.id, { weight: 2, minlen: 1 });

          dagre.layout(sg);

          // Compute bounding box of this subgraph's layout
          let minX = Infinity, maxX = -Infinity, minY = Infinity;
          sg.nodes().forEach(id => {
            if (id === vRoot) return;
            const pos = sg.node(id);
            minX = Math.min(minX, pos.x - pos.width / 2);
            maxX = Math.max(maxX, pos.x + pos.width / 2);
            minY = Math.min(minY, pos.y - pos.height / 2);
          });

          // Translate: place this subgraph at currentX, top-align at subMargin
          const shiftX = currentX - minX;
          const shiftY = subMargin - minY;
          sg.nodes().forEach(id => {
            if (id === vRoot) return;
            const pos = sg.node(id);
            layoutNodes[id].x = pos.x + shiftX;
            layoutNodes[id].y = pos.y + shiftY;
          });

          currentX = (maxX + shiftX) + subGap;
        });

        // Top-align nodes within each per-subgraph rank (same as the
        // non-hasRanks alignment above, but applied per subgraph).
        sortedStarts.forEach(startNode => {
          const nodeIds = subNodeIds[startNode.id] || [];
          const RANK_TOLERANCE = 5;
          const rankGroups = {};
          nodeIds.forEach(id => {
            const n = layoutNodes[id];
            if (!n) return;
            const roundedY = Math.round(n.y / RANK_TOLERANCE) * RANK_TOLERANCE;
            if (!rankGroups[roundedY]) rankGroups[roundedY] = [];
            rankGroups[roundedY].push(n);
          });
          Object.values(rankGroups).forEach(group => {
            if (group.length < 2) return;
            const minTop = Math.min(...group.map(n => n.y - n.height / 2));
            group.forEach(n => { n.y = minTop + n.height / 2; });
          });
        });
      }
    }

    // Apply any manual position overrides
    Object.keys(manualPositions).forEach(nodeId => {
      if (layoutNodes[nodeId]) {
        layoutNodes[nodeId].x = manualPositions[nodeId].x;
        layoutNodes[nodeId].y = manualPositions[nodeId].y;
      }
    });

    layoutEdges = [];
    g.edges().forEach(e => {
      if (e.v === virtualRootId || e.w === virtualRootId) return;
      const edgeData = g.edge(e);
      layoutEdges.push({
        ...edgeData,
        source: e.v,
        target: e.w,
        points: edgeData.points,
      });
    });

    // Use straight border-to-border lines for all edges.
    layoutEdges = layoutEdges.map(edge => {
      return { ...edge, points: computeStraightEdge(edge.source, edge.target) };
    });

    // Add visual-only edges (nav, incoming-to-start, lateral, backward) as straight lines.
    [...navEdges, ...incomingToStartEdges, ...lateralEdges, ...backwardEdges].forEach(edge => {
      // Apply global nav and provenance filters to these too
      if (edge.isGlobalNav && !showGlobalNav) return;
      if (provenanceFilter && edge.provenance && edge.provenance !== provenanceFilter) return;
      layoutEdges.push({
        ...edge,
        points: computeStraightEdge(edge.source, edge.target),
      });
    });

    return g;
  }

  // Friendly type names for a screen reader. Falls back to the raw
  // type if no friendly mapping exists, so unknown types still
  // announce something meaningful.
  function typeFriendly(type) {
    const map = {
      screen: 'Screen',
      'web-view': 'Web view',
      external: 'External link',
      content: 'Content page',
      question: 'Question page',
      'check-answers': 'Check answers',
      confirmation: 'Confirmation',
      error: 'Error page',
      splash: 'Splash',
      index: 'Index',
      'web-page': 'Web page',
    };
    return map[type] || type || 'Page';
  }

  // Compose the aria-label that screen readers announce on focus:
  // label + type + outgoing-edge summary + file path + activation hint.
  function composeNodeAriaLabel(node) {
    const parts = [node.label || node.id];
    parts.push(typeFriendly(node.type));
    const outgoing = graph.edges.filter(e => e.source === node.id);
    if (outgoing.length > 0) {
      const counts = {};
      outgoing.forEach(e => {
        const t = e.type || 'link';
        counts[t] = (counts[t] || 0) + 1;
      });
      const summary = Object.entries(counts)
        .map(([t, n]) => n + ' ' + t + (n === 1 ? '' : 's'))
        .join(', ');
      parts.push(summary + ' outgoing');
    }
    if (node.filePath) parts.push(node.filePath);
    parts.push('Press Enter to open details');
    return parts.join('. ');
  }

  // Pick the listbox's initial focus target. Prefers a designated
  // start node, falling back to the smallest layoutRank/visitOrder
  // and finally the lexicographically-first id so ordering is stable
  // across renders.
  function pickInitialFocusNodeId() {
    const nodes = Object.values(layoutNodes);
    if (nodes.length === 0) return null;
    const starts = nodes.filter(n => n.isStartNode);
    if (starts.length > 0) {
      starts.sort((a, b) =>
        ((a.startOrder == null ? Infinity : a.startOrder)) -
        ((b.startOrder == null ? Infinity : b.startOrder)));
      return starts[0].id;
    }
    const sorted = [...nodes].sort((a, b) => {
      const ra = a.layoutRank == null ? Infinity : a.layoutRank;
      const rb = b.layoutRank == null ? Infinity : b.layoutRank;
      if (ra !== rb) return ra - rb;
      const va = a.visitOrder == null ? Infinity : a.visitOrder;
      const vb = b.visitOrder == null ? Infinity : b.visitOrder;
      if (va !== vb) return va - vb;
      return String(a.id).localeCompare(String(b.id));
    });
    return sorted[0].id;
  }

  // Sort the visible nodes by traversal order — visitOrder if set,
  // else layoutRank — and return the first/last id. Powers Home/End.
  function nodeIdByOrder(reverse) {
    const nodes = Object.values(layoutNodes);
    if (nodes.length === 0) return null;
    const sorted = [...nodes].sort((a, b) => {
      const va = a.visitOrder == null ? Infinity : a.visitOrder;
      const vb = b.visitOrder == null ? Infinity : b.visitOrder;
      if (va !== vb) return va - vb;
      const ra = a.layoutRank == null ? Infinity : a.layoutRank;
      const rb = b.layoutRank == null ? Infinity : b.layoutRank;
      if (ra !== rb) return ra - rb;
      return String(a.id).localeCompare(String(b.id));
    });
    return reverse ? sorted[sorted.length - 1].id : sorted[0].id;
  }

  // Spatial neighbour finder: pick the closest visible node in the
  // pressed direction (half-plane filter), weighting the off-axis
  // distance more so the cursor follows the user's intended axis.
  // Weight 4 chosen to match the plan's recipe; see Phase 3 step 5.
  function findSpatialNeighbour(node, dir) {
    const cx = node.x, cy = node.y;
    let best = null, bestScore = Infinity;
    Object.values(layoutNodes).forEach(n => {
      if (n.id === node.id) return;
      const dx = n.x - cx;
      const dy = n.y - cy;
      let inDir = false;
      if (dir === 'up' && dy < -1) inDir = true;
      else if (dir === 'down' && dy > 1) inDir = true;
      else if (dir === 'left' && dx < -1) inDir = true;
      else if (dir === 'right' && dx > 1) inDir = true;
      if (!inDir) return;
      const score = (dir === 'up' || dir === 'down')
        ? (dx * dx + 4 * dy * dy)
        : (dy * dy + 4 * dx * dx);
      if (score < bestScore) { bestScore = score; best = n; }
    });
    return best;
  }

  // Filtered list of edges whose endpoints are both currently rendered
  // (visible in layoutNodes). Used by structural traversal so users
  // never get sent to a hidden or filtered-out node.
  function visibleEdgesFrom(sourceId) {
    return graph.edges.filter(e =>
      e.source === sourceId &&
      layoutNodes[e.target] != null &&
      !hiddenNodes.has(e.target));
  }
  function visibleEdgesTo(targetId) {
    return graph.edges.filter(e =>
      e.target === targetId &&
      layoutNodes[e.source] != null &&
      !hiddenNodes.has(e.source));
  }

  // ] traversal: cycle through the previous parent's outgoing edges
  // before descending into the current node's own outgoing edges.
  function structuralNext(currentId) {
    if (siblingCursor && layoutNodes[siblingCursor.parentId]) {
      const sibs = visibleEdgesFrom(siblingCursor.parentId);
      const nextIdx = siblingCursor.index + 1;
      if (nextIdx < sibs.length) {
        siblingCursor = { parentId: siblingCursor.parentId, index: nextIdx };
        return sibs[nextIdx].target;
      }
    }
    const out = visibleEdgesFrom(currentId);
    if (out.length === 0) {
      siblingCursor = null;
      return null;
    }
    siblingCursor = { parentId: currentId, index: 0 };
    return out[0].target;
  }

  // [ traversal: jump to the first incoming source of the current
  // node. Resets the sibling cursor — climbing out of a branch is a
  // new structural context.
  function structuralPrev(currentId) {
    const incoming = visibleEdgesTo(currentId);
    if (incoming.length === 0) return null;
    siblingCursor = null;
    return incoming[0].source;
  }

  // Animate the SVG transform so a target translation is reached in
  // ~200ms. Honours prefers-reduced-motion by jumping instantly.
  let panAnimationId = null;
  function panToTransform(tx, ty) {
    if (panAnimationId) {
      cancelAnimationFrame(panAnimationId);
      panAnimationId = null;
    }
    if (prefersReducedMotion) {
      transform.x = tx;
      transform.y = ty;
      applyTransform();
      return;
    }
    const startX = transform.x, startY = transform.y;
    const dur = 200;
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / dur);
      const ease = 1 - Math.pow(1 - t, 2);
      transform.x = startX + (tx - startX) * ease;
      transform.y = startY + (ty - startY) * ease;
      applyTransform();
      if (t < 1) panAnimationId = requestAnimationFrame(step);
      else panAnimationId = null;
    }
    panAnimationId = requestAnimationFrame(step);
  }

  // Pan the focused node into the visible area when it would otherwise
  // be off-screen or clipped near the edge. Centres the node when a
  // pan is needed; leaves the transform alone if it is already
  // comfortably visible. WCAG 2.4.11.
  function ensureNodeVisible(node) {
    if (!node) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const halfW = (node.width || 140) * transform.scale / 2;
    const halfH = (node.height || 56) * transform.scale / 2;
    const padding = 60;
    const screenX = node.x * transform.scale + transform.x;
    const screenY = node.y * transform.scale + transform.y;
    const inX = (screenX - halfW) >= padding && (screenX + halfW) <= (rect.width - padding);
    const inY = (screenY - halfH) >= padding && (screenY + halfH) <= (rect.height - padding);
    if (inX && inY) return;
    const targetX = rect.width / 2 - node.x * transform.scale;
    const targetY = rect.height / 2 - node.y * transform.scale;
    panToTransform(targetX, targetY);
  }

  // Move focus to the named node and update aria-selected/tabindex
  // across the listbox so exactly one option is in the tab order.
  // Pans the new focus into view when needed.
  function focusNode(nodeId) {
    if (!nodeId || !layoutNodes[nodeId]) return;
    const targetGroup = document.querySelector(
      '.node-group[data-node-id="' + CSS.escape(nodeId) + '"]');
    if (!targetGroup) return;
    document.querySelectorAll('.node-group').forEach(g => {
      const isFocus = g === targetGroup;
      g.setAttribute('tabindex', isFocus ? '0' : '-1');
      g.setAttribute('aria-selected', isFocus ? 'true' : 'false');
    });
    focusedNodeId = nodeId;
    targetGroup.focus({ preventScroll: true });
    ensureNodeVisible(layoutNodes[nodeId]);
    updateNodeActionsButton();
  }

  // Reflect "is a node currently focused?" on the toolbar button so
  // keyboards without Shift+F10 / ContextMenu can still open the menu.
  function updateNodeActionsButton() {
    const btn = document.getElementById('node-actions-btn');
    if (!btn) return;
    const hasFocus = !!(focusedNodeId && layoutNodes[focusedNodeId]);
    btn.disabled = !hasFocus;
    btn.setAttribute('aria-expanded', _nodeMenuEl ? 'true' : 'false');
  }

  // Keyboard handler for the listbox. Spatial movement on the four
  // arrow keys, structural movement on ]/[ (with Shift+]/[), Enter or
  // Space to open the detail panel, Home/End to jump by visit order.
  // Tab is left to the browser so users can leave the listbox.
  // M enters move mode; Shift+F10 / ContextMenu open the actions menu.
  function handleNodeKeydown(e) {
    const targetGroup = e.target.closest('.node-group');
    if (!targetGroup) return;
    const nodeId = targetGroup.dataset.nodeId;
    const node = layoutNodes[nodeId];
    if (!node) return;

    // Move mode hijacks the listbox keys for the duration.
    if (moveMode && moveMode.nodeId === nodeId) {
      handleMoveModeKeydown(e);
      return;
    }

    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      showDetail(node);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key.replace('Arrow', '').toLowerCase();
      const next = findSpatialNeighbour(node, dir);
      if (next) {
        e.preventDefault();
        siblingCursor = null;
        focusNode(next.id);
      }
      return;
    }
    if (e.key === ']' || e.key === '}') {
      const nextId = structuralNext(nodeId);
      if (nextId) { e.preventDefault(); focusNode(nextId); }
      return;
    }
    if (e.key === '[' || e.key === '{') {
      const prevId = structuralPrev(nodeId);
      if (prevId) { e.preventDefault(); focusNode(prevId); }
      return;
    }
    if (e.key === 'Home') {
      const id = nodeIdByOrder(false);
      if (id) { e.preventDefault(); siblingCursor = null; focusNode(id); }
      return;
    }
    if (e.key === 'End') {
      const id = nodeIdByOrder(true);
      if (id) { e.preventDefault(); siblingCursor = null; focusNode(id); }
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      enterMoveMode(node);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openNodeMenuForFocused();
      return;
    }
  }

  // Apply the roving tabindex to the freshly-rendered listbox after
  // each render. Picks an initial focus target if the previous one is
  // gone (filtered out, hidden, or never set).
  function applyRovingTabindex() {
    const groups = document.querySelectorAll('.node-group');
    if (groups.length === 0) {
      updateNodeActionsButton();
      return;
    }
    if (!focusedNodeId || !layoutNodes[focusedNodeId]) {
      focusedNodeId = pickInitialFocusNodeId();
      siblingCursor = null;
    }
    groups.forEach(g => {
      const isFocus = g.dataset.nodeId === focusedNodeId;
      g.setAttribute('tabindex', isFocus ? '0' : '-1');
      g.setAttribute('aria-selected', isFocus ? 'true' : 'false');
    });
    updateNodeActionsButton();
  }

  // Render the graph to SVG
  function render() {
    const g = layoutGraph();
    const graphInfo = g.graph();

    // Clear SVG
    svg.innerHTML = '';

    // Add defs for arrowheads
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    ['link', 'form', 'conditional', 'redirect', 'render', 'nav', 'tab', 'sheet', 'full-screen', 'web-view', 'safari'].forEach(type => {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrow-' + type);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '10');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('orient', 'auto');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('class', 'edge-arrowhead edge-arrowhead--' + type);
      marker.appendChild(path);
      defs.appendChild(marker);
    });
    svg.appendChild(defs);

    // Create main group for pan/zoom
    const mainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    mainGroup.setAttribute('id', 'main-group');
    svg.appendChild(mainGroup);

    const edgePriority = { nav: -1, link: 1, render: 2, conditional: 3, redirect: 4, form: 5 };
    const sortedEdges = [...layoutEdges].sort((a, b) => {
      const pa = edgePriority[a.type] || 1;
      const pb = edgePriority[b.type] || 1;
      return pa - pb;
    });

    // Render edges
    sortedEdges.forEach(edge => {
      const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      edgeGroup.setAttribute('class', 'edge-group');
      edgeGroup.dataset.source = edge.source;
      edgeGroup.dataset.target = edge.target;

      // Build orthogonal path with rounded corners from points
      const points = edge.points;
      const d = buildOrthogonalPath(points);

      const edgeType = edge.type || 'link';
      let cssClass = 'edge-path edge-path--' + edgeType;
      if (edge.provenance === 'static') cssClass += ' edge-path--static-provenance';
      if (edge.isGlobalNav) cssClass += ' edge-path--global-nav-edge';
      const arrowType = edgeType;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cssClass);
      path.setAttribute('marker-end', 'url(#arrow-' + arrowType + ')');
      edgeGroup.appendChild(path);

      // Edge label
      if (showLabels && edge.label && edge.type !== 'back') {
        const midPoint = points[Math.floor(points.length / 2)];
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midPoint.x);
        text.setAttribute('y', midPoint.y - 6);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-label');
        text.textContent = truncate(edge.label, 30);
        edgeGroup.appendChild(text);
      }

      // Condition label
      if (showLabels && edge.condition) {
        const midPoint = points[Math.floor(points.length / 2)];
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midPoint.x);
        text.setAttribute('y', midPoint.y + 10);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-condition-label');
        text.textContent = truncate(edge.condition, 40);
        edgeGroup.appendChild(text);
      }

      mainGroup.appendChild(edgeGroup);
    });

    // Container for nodes — separate <g> from edges so we can give it
    // listbox semantics. Each node-group becomes a role="option" that
    // participates in the roving-tabindex pattern (Phase 3).
    const nodeContainer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodeContainer.setAttribute('id', 'node-container');
    nodeContainer.setAttribute('role', 'listbox');
    nodeContainer.setAttribute('aria-label',
      'Screens (' + Object.keys(layoutNodes).length + ' total)');
    nodeContainer.addEventListener('keydown', handleNodeKeydown);
    mainGroup.appendChild(nodeContainer);

    // Render nodes
    Object.values(layoutNodes).forEach(node => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'node-group');
      group.setAttribute('role', 'option');
      group.setAttribute('aria-selected', 'false');
      group.setAttribute('tabindex', '-1');
      group.setAttribute('aria-label', composeNodeAriaLabel(node));
      group.dataset.nodeId = node.id;
      group.setAttribute('transform', 'translate(' + (node.x - node.width/2) + ',' + (node.y - node.height/2) + ')');
      group.addEventListener('click', (e) => { e.stopPropagation(); if (!isDragging) showDetail(node); });
      group.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showNodeContextMenu(e.clientX, e.clientY, node); });
      group.addEventListener('mouseenter', () => { if (!dragTarget) highlightConnections(node.id); });
      group.addEventListener('mouseleave', () => { if (!dragTarget) clearHighlight(); });
      group.addEventListener('focus', () => {
        focusedNodeId = node.id;
        highlightConnections(node.id);
      });
      group.addEventListener('blur', () => {
        clearHighlight();
      });
      group.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const svgRect = svg.getBoundingClientRect();
        const mouseX = (e.clientX - svgRect.left - transform.x) / transform.scale;
        const mouseY = (e.clientY - svgRect.top - transform.y) / transform.scale;
        dragTarget = {
          nodeId: node.id,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          offsetX: mouseX - node.x,
          offsetY: mouseY - node.y,
          hasMoved: false,
          group: group,
          node: node,
        };
      });

      // Background rect
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', node.width);
      rect.setAttribute('height', node.height);
      let rectClass = 'node-rect node-rect--' + (node.type || 'content');
      if (node.isStartNode) rectClass += ' node-rect--start-node';
      if (node.subgraphRoot) rectClass += ' subgraph-root';
      rect.setAttribute('class', rectClass);
      rect.dataset.nodeId = node.id;
      group.appendChild(rect);

      // Hub color strip on left edge
      if (node.hub) {
        const hubStrip = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hubStrip.setAttribute('x', 0);
        hubStrip.setAttribute('y', 0);
        hubStrip.setAttribute('width', 3);
        hubStrip.setAttribute('height', node.height);
        hubStrip.setAttribute('fill', hubColor(node.hub));
        hubStrip.setAttribute('rx', '1');
        group.appendChild(hubStrip);
      }

      // Screenshot — full page by default, cropped thumbnail when thumbnailMode is on
      if (hasScreenshots && !hideScreenshots && node.screenshot) {
        const imgWidth = node.width - IMG_PAD * 2;
        const imgHeight = node.height - LABEL_AREA - IMG_PAD;
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.setAttribute('href', node.screenshot);
        img.setAttribute('x', IMG_PAD);
        img.setAttribute('y', IMG_PAD);
        img.setAttribute('width', imgWidth);
        img.setAttribute('height', imgHeight);
        // Full-page: fit entire screenshot without cropping
        // Thumbnail: crop to top portion only
        img.setAttribute('preserveAspectRatio', thumbnailMode ? 'xMidYMin slice' : 'xMidYMid meet');
        img.setAttribute('class', 'node-screenshot');
        // Clip to rounded rect
        const clipId = 'clip-' + node.id.replace(/[^a-zA-Z0-9]/g, '-');
        const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clipPath.setAttribute('id', clipId);
        const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        clipRect.setAttribute('x', IMG_PAD);
        clipRect.setAttribute('y', IMG_PAD);
        clipRect.setAttribute('width', imgWidth);
        clipRect.setAttribute('height', imgHeight);
        clipRect.setAttribute('rx', '3');
        clipPath.appendChild(clipRect);
        defs.appendChild(clipPath);
        img.setAttribute('clip-path', 'url(#' + clipId + ')');
        group.appendChild(img);
      }

      // Title label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', node.width / 2);
      label.setAttribute('y', (hasScreenshots && !hideScreenshots) ? node.height - 14 : 28);
      label.setAttribute('class', 'node-label');
      label.textContent = truncate(node.actualTitle || node.label, 20);
      group.appendChild(label);

      // Start node badge
      if (node.isStartNode) {
        const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        badge.setAttribute('x', node.width / 2);
        badge.setAttribute('y', -6);
        badge.setAttribute('text-anchor', 'middle');
        badge.setAttribute('class', 'start-node-badge');
        badge.textContent = 'START';
        group.appendChild(badge);
      }

      // Type badge (always visible)
      const typeBadge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      typeBadge.setAttribute('x', node.width / 2);
      typeBadge.setAttribute('y', (hasScreenshots && !hideScreenshots) ? node.height - 3 : 42);
      typeBadge.setAttribute('class', 'node-type-badge');
      typeBadge.textContent = (node.type || 'content').toUpperCase();
      group.appendChild(typeBadge);

      // URL path (small text) — only when screenshots are hidden or absent
      if (!hasScreenshots || hideScreenshots) {
        const pathLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pathLabel.setAttribute('x', node.width / 2);
        pathLabel.setAttribute('y', 54);
        pathLabel.setAttribute('class', 'node-path-label');
        pathLabel.textContent = truncate(node.urlPath, 30);
        group.appendChild(pathLabel);
      }

      nodeContainer.appendChild(group);
    });

    // Roving tabindex / aria-selected sync — exactly one option in
    // the listbox carries tabindex="0" so Tab can land on the graph.
    applyRovingTabindex();

    // Update node count
    document.getElementById('node-count').textContent =
      Object.keys(layoutNodes).length + ' pages, ' + layoutEdges.length + ' connections';

    // Populate hub filter — show only when there are multiple hubs
    const hubs = [...new Set(graph.nodes.map(n => n.hub).filter(Boolean))];
    const hubSelect = document.getElementById('hub-filter');
    if (hubSelect.options.length <= 1) {
      hubs.forEach(hub => {
        const opt = document.createElement('option');
        opt.value = hub;
        opt.textContent = hub;
        hubSelect.appendChild(opt);
      });
    }
    const showHubFilter = hubs.length > 1;
    hubSelect.style.display = showHubFilter ? '' : 'none';
    document.getElementById('hub-filter-label').style.display = showHubFilter ? '' : 'none';

    // Toggle toolbar buttons
    const showAllBtn = document.getElementById('show-all-btn');
    if (hiddenNodes.size > 0) {
      showAllBtn.style.display = '';
      showAllBtn.textContent = 'Show hidden (' + hiddenNodes.size + ')';
    } else {
      showAllBtn.style.display = 'none';
    }
    document.getElementById('toggle-screenshots').style.display = hasScreenshots ? '' : 'none';

    // Apply transform
    applyTransform();

    // Fit to screen on first render
    if (transform.x === 0 && transform.y === 0 && transform.scale === 1) {
      fitToScreen();
    }

    // Rebuild outline (always kept in DOM — visually hidden when SVG is active).
    buildOutline();
  }

  // Element that had focus before the panel opened, so closePanel can
  // restore it. Phase 3 will make the SVG nodes focusable; for now this
  // is mostly a no-op for mouse users (activeElement = body) but works
  // when the panel is opened from a keyboard-focused trigger.
  let lastPanelTrigger = null;

  // Show detail panel for a node
  function showDetail(node) {
    const panel = document.getElementById('detail-panel');
    const content = document.getElementById('panel-content');

    lastPanelTrigger = document.activeElement;

    let html = '<h2 id="panel-title" tabindex="-1">' + escapeHtml(node.label) + '</h2>';

    if (hasScreenshots && !hideScreenshots && node.screenshot) {
      html += '<img class="panel-screenshot" src="' + node.screenshot + '" alt="Screenshot of ' + escapeHtml(node.label) + '" />';
    }

    html += '<dl class="panel-meta">';
    html += '<dt>URL</dt><dd>' + escapeHtml(node.urlPath) + '</dd>';
    html += '<dt>File</dt><dd>' + escapeHtml(node.filePath || '–') + '</dd>';
    html += '<dt>Type</dt><dd>' + escapeHtml(node.type || '–') + '</dd>';
    if (node.hub) html += '<dt>Hub</dt><dd>' + escapeHtml(node.hub) + '</dd>';
    if (node.isStartNode) html += '<dt>Role</dt><dd>Start page (--from)</dd>';
    if (node.scenario) html += '<dt>Scenario</dt><dd>' + escapeHtml(node.scenario) + '</dd>';
    if (node.staticEnriched) html += '<dt>Enriched</dt><dd>Static analysis</dd>';
    html += '</dl>';

    // Outgoing edges
    const outgoing = graph.edges.filter(e => e.source === node.id);
    if (outgoing.length > 0) {
      html += '<h3 style="margin-top:12px;font-size:13px;">Navigates to (' + outgoing.length + ')</h3>';
      html += '<ul class="panel-links">';
      outgoing.forEach(e => {
        html += '<li>';
        html += '<span class="link-target">' + escapeHtml(e.target) + '</span>';
        html += ' <span class="link-edge-type">(' + escapeHtml(e.type) + ')</span>';
        if (e.provenance) html += ' <span class="edge-provenance-badge edge-provenance--' + e.provenance + '">' + e.provenance + '</span>';
        if (e.isGlobalNav) html += ' <span class="edge-provenance-badge edge-provenance--nav">nav</span>';
        if (e.label) html += ' — ' + escapeHtml(e.label);
        if (e.condition) html += '<br><span class="link-condition">if ' + escapeHtml(e.condition) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }

    // Incoming edges
    const incoming = graph.edges.filter(e => e.target === node.id);
    if (incoming.length > 0) {
      html += '<h3 style="margin-top:12px;font-size:13px;">Reached from (' + incoming.length + ')</h3>';
      html += '<ul class="panel-links">';
      incoming.forEach(e => {
        html += '<li>';
        html += '<span class="link-target">' + escapeHtml(e.source) + '</span>';
        html += ' <span class="link-edge-type">(' + escapeHtml(e.type) + ')</span>';
        if (e.provenance) html += ' <span class="edge-provenance-badge edge-provenance--' + e.provenance + '">' + e.provenance + '</span>';
        if (e.isGlobalNav) html += ' <span class="edge-provenance-badge edge-provenance--nav">nav</span>';
        if (e.condition) html += '<br><span class="link-condition">if ' + escapeHtml(e.condition) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }

    html += '<button class="hide-node-btn" data-node-id="' + escapeHtml(node.id) + '">Hide this page</button>';

    content.innerHTML = html;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    panel.removeAttribute('inert');

    // Move focus to the panel title so screen reader users start reading
    // there. tabindex="-1" on the heading makes it programmatically
    // focusable without adding it to the tab order.
    const heading = document.getElementById('panel-title');
    if (heading) heading.focus({ preventScroll: true });

    // Highlight the node
    document.querySelectorAll('.node-rect--highlight').forEach(el => el.classList.remove('node-rect--highlight'));
    const nodeRect = document.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]');
    if (nodeRect) nodeRect.classList.add('node-rect--highlight');
  }

  window.closePanel = function() {
    const panel = document.getElementById('detail-panel');
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    document.querySelectorAll('.node-rect--highlight').forEach(el => el.classList.remove('node-rect--highlight'));
    // Return focus to whatever opened the panel, if it's still in the DOM
    // and focusable. Falls back to the close button's parent (body) which
    // is a sensible default for mouse users.
    if (lastPanelTrigger && document.body.contains(lastPanelTrigger) && typeof lastPanelTrigger.focus === 'function') {
      try { lastPanelTrigger.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    lastPanelTrigger = null;
  };

  // Pan and zoom
  function applyTransform() {
    const mainGroup = document.getElementById('main-group');
    if (mainGroup) {
      mainGroup.setAttribute('transform',
        'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')'
      );
    }
  }

  svg.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-group')) return;
    isPanning = true;
    panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    transform.x = e.clientX - panStart.x;
    transform.y = e.clientY - panStart.y;
    applyTransform();
  });

  window.addEventListener('mouseup', () => { isPanning = false; });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const newScale = Math.min(Math.max(transform.scale * delta, 0.05), 3);
    const scaleChange = newScale / transform.scale;

    transform.x = mouseX - scaleChange * (mouseX - transform.x);
    transform.y = mouseY - scaleChange * (mouseY - transform.y);
    transform.scale = newScale;

    applyTransform();
  }, { passive: false });

  window.zoomIn = function() {
    transform.scale = Math.min(transform.scale * 1.2, 3);
    applyTransform();
  };

  window.zoomOut = function() {
    transform.scale = Math.max(transform.scale * 0.8, 0.05);
    applyTransform();
  };

  window.fitToScreen = function() {
    const mainGroup = document.getElementById('main-group');
    if (!mainGroup) return;

    // Temporarily reset transform to get true bounding box
    mainGroup.setAttribute('transform', 'translate(0,0) scale(1)');
    const bbox = mainGroup.getBBox();
    mainGroup.setAttribute('transform',
      'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')'
    );

    if (bbox.width === 0 || bbox.height === 0) return;

    const containerRect = container.getBoundingClientRect();
    const padding = 60;
    const scaleX = (containerRect.width - padding * 2) / bbox.width;
    const scaleY = (containerRect.height - padding * 2) / bbox.height;
    const newScale = Math.min(scaleX, scaleY, 1.5);

    transform.scale = newScale;
    transform.x = (containerRect.width / 2) - (bbox.x + bbox.width / 2) * newScale;
    transform.y = (containerRect.height / 2) - (bbox.y + bbox.height / 2) * newScale;

    applyTransform();
  };

  // Controls
  document.getElementById('toggle-labels').addEventListener('click', () => {
    showLabels = !showLabels;
    const btn = document.getElementById('toggle-labels');
    btn.setAttribute('aria-pressed', String(showLabels));
    btn.textContent = showLabels ? 'Hide labels' : 'Show labels';
    render();
  });

  document.getElementById('hub-filter').addEventListener('change', (e) => {
    hubFilter = e.target.value;
    render();
  });

  // Global nav toggle
  const globalNavToggle = document.getElementById('toggle-global-nav');
  if (globalNavToggle) {
    globalNavToggle.addEventListener('change', (e) => {
      showGlobalNav = e.target.checked;
      render();
    });
  }

  // Provenance filter
  const provenanceSelect = document.getElementById('provenance-filter');
  if (provenanceSelect) {
    provenanceSelect.addEventListener('change', (e) => {
      provenanceFilter = e.target.value;
      render();
    });
  }

  let searchTimeout;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchTerm = e.target.value.toLowerCase();
      render();
    }, 250);
  });

  // Theme toggle. The bootstrap script in <head> has already set
  // data-theme based on saved preference or prefers-color-scheme; we
  // sync the button label and aria-pressed to that state, then handle
  // clicks. While the user has no explicit override, we follow OS-level
  // changes; once they click, the explicit choice persists.
  (function() {
    const root = document.documentElement;
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    function syncUi(theme) {
      const isLight = theme === 'light';
      btn.setAttribute('aria-pressed', String(isLight));
      btn.textContent = isLight ? 'Dark mode' : 'Light mode';
      btn.setAttribute('title', isLight ? 'Switch to dark mode' : 'Switch to light mode');
    }

    syncUi(root.getAttribute('data-theme') || 'dark');

    btn.addEventListener('click', () => {
      const next = (root.getAttribute('data-theme') || 'dark') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('flowmap-theme', next); } catch (e) { /* ignore */ }
      syncUi(next);
    });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const followSystem = (e) => {
        try {
          if (localStorage.getItem('flowmap-theme')) return; // explicit choice wins
        } catch (err) { /* ignore */ }
        const next = e.matches ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        syncUi(next);
      };
      if (mq.addEventListener) mq.addEventListener('change', followSystem);
      else if (mq.addListener) mq.addListener(followSystem);
    }
  })();

  // Hover highlighting
  function highlightConnections(nodeId) {
    const connectedNodes = new Set([nodeId]);
    document.querySelectorAll('.edge-group').forEach(eg => {
      if (eg.dataset.source === nodeId || eg.dataset.target === nodeId) {
        eg.style.opacity = '1';
        connectedNodes.add(eg.dataset.source);
        connectedNodes.add(eg.dataset.target);
      } else {
        eg.style.opacity = '0.08';
      }
    });
    document.querySelectorAll('.node-group').forEach(ng => {
      const nId = ng.querySelector('.node-rect') && ng.querySelector('.node-rect').dataset.nodeId;
      ng.style.opacity = connectedNodes.has(nId) ? '1' : '0.2';
    });
  }

  function clearHighlight() {
    document.querySelectorAll('.edge-group').forEach(eg => { eg.style.opacity = ''; });
    document.querySelectorAll('.node-group').forEach(ng => { ng.style.opacity = ''; });
  }

  // Thumbnail / full-page toggle
  window.toggleThumbnail = function() {
    thumbnailMode = !thumbnailMode;
    try { localStorage.setItem(viewModeKey, thumbnailMode ? 'thumbnail' : 'full'); } catch(e) {}
    const btn = document.getElementById('toggle-thumbnail');
    btn.textContent = thumbnailMode ? 'Show full pages' : 'Show thumbnails';
    btn.setAttribute('aria-pressed', String(thumbnailMode));
    render();
  };

  // Hide/show nodes
  window.hideNode = function(nodeId) {
    hiddenNodes.add(nodeId);
    saveHiddenNodes();
    closePanel();
    hideNodeContextMenu();
    render();
  };

  window.hideSubgraph = function(nodeId) {
    const descendants = collectDescendants(nodeId);
    hiddenNodes.add(nodeId);
    descendants.forEach(id => hiddenNodes.add(id));
    saveHiddenNodes();
    closePanel();
    hideNodeContextMenu();
    render();
  };

  window.restoreNode = function(nodeId) {
    hiddenNodes.delete(nodeId);
    saveHiddenNodes();
    if (hiddenNodes.size === 0) hideHiddenListPopover();
    else updateHiddenListPopover();
    render();
  };

  window.showAllNodes = function() {
    hiddenNodes.clear();
    saveHiddenNodes();
    hideHiddenListPopover();
    render();
  };

  // ===== Status announcements =====
  // Single live region for transient messages (save success, move-mode
  // start/commit/cancel, etc). Distinct from #node-count, which is
  // overwritten on every render. Resets after a beat so the same
  // message can be announced twice in a row.
  let _statusClearTimer = null;
  function announceStatus(msg) {
    const region = document.getElementById('a11y-status');
    if (!region) return;
    clearTimeout(_statusClearTimer);
    region.textContent = '';
    // Schedule the write a tick later so AT pick up the change.
    requestAnimationFrame(() => { region.textContent = msg; });
    _statusClearTimer = setTimeout(() => { region.textContent = ''; }, 4000);
  }

  // ===== Outline view (Phase 5) =====
  // Builds (or rebuilds) the accessible outline list from the currently
  // visible layoutNodes. Called at the end of every render() so the outline
  // always reflects the current filter state, even when the SVG view is
  // active and the outline is only visually hidden.
  function buildOutline() {
    const outline = document.getElementById('flow-outline');
    if (!outline) return;

    const nodeById = {};
    graph.nodes.forEach(n => { nodeById[n.id] = n; });

    // Use layoutNodes — populated by the most recent layoutGraph() run.
    const visible = Object.values(layoutNodes);

    if (!visible.length) {
      outline.innerHTML = '<p id="outline-heading" tabindex="-1" style="color:var(--text-muted);font-size:13px">No screens match the current filters.</p>';
      return;
    }

    // Sort by layoutRank → visitOrder → label
    visible.sort((a, b) => {
      const ra = a.layoutRank == null ? Infinity : a.layoutRank;
      const rb = b.layoutRank == null ? Infinity : b.layoutRank;
      if (ra !== rb) return ra - rb;
      const va = a.visitOrder == null ? Infinity : a.visitOrder;
      const vb = b.visitOrder == null ? Infinity : b.visitOrder;
      if (va !== vb) return va - vb;
      return (a.label || '').localeCompare(b.label || '');
    });

    const visibleIds = new Set(visible.map(n => n.id));

    let html = '<h2 id="outline-heading" tabindex="-1">Screens (' + visible.length + ')</h2>';
    html += '<ul class="outline-list">';

    visible.forEach(node => {
      const outEdges = graph.edges.filter(e =>
        e.source === node.id &&
        visibleIds.has(e.target) &&
        (!e.isGlobalNav || showGlobalNav) &&
        (!provenanceFilter || !e.provenance || e.provenance === provenanceFilter)
      );

      html += '<li class="outline-item">';
      html += '<button class="outline-node-btn" data-node-id="' + escapeHtml(node.id) + '" type="button">';
      html += escapeHtml(node.label || node.id);
      if (node.type) html += ' <span class="outline-type-badge">(' + escapeHtml(node.type) + ')</span>';
      html += '</button>';

      if (outEdges.length > 0) {
        html += '<ul class="outline-edges-list" aria-label="Navigates to">';
        outEdges.forEach(e => {
          const target = nodeById[e.target];
          const targetLabel = target ? (target.label || target.id) : e.target;
          const edgeDesc = e.label ? e.label : '';
          html += '<li class="outline-edge-item">';
          html += '<span class="outline-edge-type">' + escapeHtml(e.type) + '</span> to ';
          html += '<button class="outline-node-btn outline-edge-target" data-node-id="' + escapeHtml(e.target) + '" type="button">';
          html += escapeHtml(targetLabel);
          if (edgeDesc) html += ' — ' + escapeHtml(edgeDesc);
          html += '</button>';
          html += '</li>';
        });
        html += '</ul>';
      }

      html += '</li>';
    });

    html += '</ul>';
    outline.innerHTML = html;

    outline.querySelectorAll('.outline-node-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const node = nodeById[btn.dataset.nodeId];
        if (node) showDetail(node);
      });
    });
  }

  window.toggleOutlineView = function() {
    outlineMode = !outlineMode;
    const btn = document.getElementById('outline-toggle');
    const outline = document.getElementById('flow-outline');
    const canvas = document.getElementById('canvas-container');
    const skipLink = document.querySelector('.skip-link');

    btn.setAttribute('aria-pressed', String(outlineMode));

    if (outlineMode) {
      outline.classList.add('outline-active');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.display = 'none';
      btn.textContent = 'View as map';
      buildOutline();
      const heading = document.getElementById('outline-heading');
      if (heading) heading.focus({ preventScroll: true });
      if (skipLink) skipLink.setAttribute('href', '#flow-outline');
      announceStatus('Outline view. ' + Object.keys(layoutNodes).length + ' screens listed.');
    } else {
      outline.classList.remove('outline-active');
      canvas.removeAttribute('aria-hidden');
      canvas.style.display = '';
      btn.textContent = 'View as outline';
      btn.focus();
      if (skipLink) skipLink.setAttribute('href', '#canvas-container');
      announceStatus('Map view.');
    }
  };

  // ===== Context menu (Phase 4 — accessible) =====
  // role="menu" with role="menuitem" buttons; arrow keys move focus,
  // Enter/Space activate, Esc and Tab close. Focus is returned to the
  // element that triggered the menu.
  let _nodeMenuEl = null;
  let _nodeMenuTrigger = null;
  let _nodeMenuNodeId = null;

  function showNodeContextMenu(clientX, clientY, node, opts) {
    hideNodeContextMenu();
    hideHiddenListPopover();
    const fromKeyboard = !!(opts && opts.fromKeyboard);
    const trigger = (opts && opts.trigger) || document.activeElement;
    const descendantCount = collectDescendants(node.id).size;
    const menu = document.createElement('div');
    menu.className = 'node-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Actions for ' + (node.label || node.id));
    menu.style.left = clientX + 'px';
    menu.style.top = clientY + 'px';
    let html = '<button type="button" class="ncm-item" role="menuitem" tabindex="-1" data-action="hide" data-node-id="' + escapeHtml(node.id) + '">Hide node</button>';
    if (descendantCount > 0) {
      html += '<button type="button" class="ncm-item" role="menuitem" tabindex="-1" data-action="hide-subgraph" data-node-id="' + escapeHtml(node.id) + '">Hide subgraph (' + descendantCount + ' descendant' + (descendantCount === 1 ? '' : 's') + ')</button>';
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    _nodeMenuEl = menu;
    _nodeMenuTrigger = trigger;
    _nodeMenuNodeId = node.id;
    // Position adjustment if menu would overflow viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    // Click handlers — activate item then close.
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.ncm-item');
      if (!btn) return;
      activateMenuItem(btn);
    });
    // Keyboard handler — arrow movement, Enter/Space activate, Esc close.
    menu.addEventListener('keydown', handleNodeMenuKeydown);
    // Reflect open state on toolbar button.
    const btn = document.getElementById('node-actions-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    // Move focus to the first item when opened from the keyboard. For
    // mouse-opened menus we leave focus alone but still expose tabindex
    // so AT can reach the items.
    const items = menu.querySelectorAll('.ncm-item');
    if (items.length > 0) {
      items[0].setAttribute('tabindex', '0');
      if (fromKeyboard) items[0].focus({ preventScroll: true });
    }
  }

  function activateMenuItem(btn) {
    if (!btn) return;
    const action = btn.dataset.action;
    const nodeId = btn.dataset.nodeId;
    if (action === 'hide') hideNode(nodeId);
    else if (action === 'hide-subgraph') hideSubgraph(nodeId);
  }

  function handleNodeMenuKeydown(e) {
    if (!_nodeMenuEl) return;
    const items = [..._nodeMenuEl.querySelectorAll('.ncm-item')];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[(idx + 1 + items.length) % items.length];
      items.forEach(b => b.setAttribute('tabindex', '-1'));
      next.setAttribute('tabindex', '0');
      next.focus();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[(idx - 1 + items.length) % items.length];
      items.forEach(b => b.setAttribute('tabindex', '-1'));
      prev.setAttribute('tabindex', '0');
      prev.focus();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      items.forEach(b => b.setAttribute('tabindex', '-1'));
      items[0].setAttribute('tabindex', '0');
      items[0].focus();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      items.forEach(b => b.setAttribute('tabindex', '-1'));
      items[items.length - 1].setAttribute('tabindex', '0');
      items[items.length - 1].focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      activateMenuItem(document.activeElement);
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      hideNodeContextMenu({ returnFocus: true });
      return;
    }
  }

  function hideNodeContextMenu(opts) {
    if (!_nodeMenuEl) return;
    _nodeMenuEl.remove();
    _nodeMenuEl = null;
    const trigger = _nodeMenuTrigger;
    _nodeMenuTrigger = null;
    const btn = document.getElementById('node-actions-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (opts && opts.returnFocus && trigger && document.body.contains(trigger)
        && typeof trigger.focus === 'function') {
      try { trigger.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    _nodeMenuNodeId = null;
  }

  // Open the actions menu for the currently-focused node, positioned
  // near the node so sighted keyboard users see it next to its target.
  function openNodeMenuForFocused() {
    if (!focusedNodeId || !layoutNodes[focusedNodeId]) return;
    const node = layoutNodes[focusedNodeId];
    const group = document.querySelector(
      '.node-group[data-node-id="' + CSS.escape(node.id) + '"]');
    if (!group) return;
    const r = group.getBoundingClientRect();
    showNodeContextMenu(r.left + r.width / 2, r.bottom, node, {
      fromKeyboard: true,
      trigger: group,
    });
  }
  window.openFocusedNodeMenu = openNodeMenuForFocused;

  // ===== Hidden-list popover (Phase 4 — accessible dialog) =====
  // role="dialog" aria-modal="true". Focus is moved into the dialog on
  // open, trapped while it remains, and returned to the toolbar trigger
  // on close. The popover is small enough that "modal" semantics work
  // even though the canvas stays visually behind it.
  let _hiddenPopoverEl = null;
  let _hiddenPopoverTrigger = null;

  window.showHiddenListPopover = function() {
    hideNodeContextMenu();
    if (_hiddenPopoverEl) { hideHiddenListPopover({ returnFocus: true }); return; }
    const btn = document.getElementById('show-all-btn');
    if (!btn) return;
    _hiddenPopoverTrigger = btn;
    const pop = document.createElement('div');
    pop.className = 'hidden-list-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'hlp-title');
    pop.setAttribute('tabindex', '-1');
    document.body.appendChild(pop);
    _hiddenPopoverEl = pop;
    updateHiddenListPopover();
    // Position below the toolbar button
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - pop.offsetWidth) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    pop.addEventListener('keydown', handleHiddenPopoverKeydown);
    // Move focus to the first interactive element (Restore all when
    // hidden nodes exist; otherwise the dialog itself).
    const firstFocus = pop.querySelector('.hlp-restore-all, .hlp-restore') || pop;
    try { firstFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  function updateHiddenListPopover() {
    if (!_hiddenPopoverEl) return;
    const ids = [...hiddenNodes];
    const labelById = {};
    graph.nodes.forEach(n => { labelById[n.id] = n.label; });
    let html = '<div class="hlp-header">';
    html += '<span id="hlp-title" class="hlp-title">' + ids.length + ' hidden</span>';
    html += '<button type="button" class="hlp-restore-all" onclick="showAllNodes()">Restore all</button>';
    html += '</div>';
    if (ids.length === 0) {
      html += '<div class="hlp-empty">Nothing hidden.</div>';
    } else {
      html += '<ul class="hlp-list">';
      ids.forEach(id => {
        const label = labelById[id] || id;
        html += '<li><span class="hlp-label" title="' + escapeHtml(id) + '">' + escapeHtml(label) + '</span>';
        html += '<button type="button" class="hlp-restore" data-node-id="' + escapeHtml(id) + '" aria-label="Restore ' + escapeHtml(label) + '">Restore</button></li>';
      });
      html += '</ul>';
    }
    _hiddenPopoverEl.innerHTML = html;
    // Wire per-row Restore buttons
    _hiddenPopoverEl.querySelectorAll('.hlp-restore').forEach(b => {
      b.addEventListener('click', () => restoreNode(b.dataset.nodeId));
    });
  }

  function handleHiddenPopoverKeydown(e) {
    if (!_hiddenPopoverEl) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideHiddenListPopover({ returnFocus: true });
      return;
    }
    if (e.key === 'Tab') {
      // Focus trap: cycle through focusable items inside the dialog.
      const focusables = _hiddenPopoverEl.querySelectorAll(
        'button, [href], input, [tabindex]:not([tabindex="-1"])');
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function hideHiddenListPopover(opts) {
    if (!_hiddenPopoverEl) return;
    _hiddenPopoverEl.remove();
    _hiddenPopoverEl = null;
    const trigger = _hiddenPopoverTrigger;
    _hiddenPopoverTrigger = null;
    const btn = document.getElementById('show-all-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (opts && opts.returnFocus && trigger && document.body.contains(trigger)
        && typeof trigger.focus === 'function') {
      try { trigger.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  // ===== Move mode (Phase 4) =====
  // Keyboard alternative to drag-to-reposition. WCAG 2.5.7. Arrow nudges
  // the focused node by 8px (Shift+Arrow by 32px); Enter commits the new
  // position via the existing manualPositions machinery; Escape reverts
  // to the recorded original{X,Y}.
  function enterMoveMode(node) {
    if (!node) return;
    if (moveMode) cancelMoveMode();
    moveMode = {
      nodeId: node.id,
      originalX: node.x,
      originalY: node.y,
    };
    const group = document.querySelector(
      '.node-group[data-node-id="' + CSS.escape(node.id) + '"]');
    if (group) {
      const rect = group.querySelector('.node-rect');
      if (rect) rect.classList.add('node-rect--move-mode');
      group.setAttribute('aria-grabbed', 'true');
    }
    announceStatus('Move mode for ' + (node.label || node.id) +
      '. Use arrow keys to nudge, Enter to commit, Escape to cancel.');
  }

  function exitMoveModeUi() {
    if (!moveMode) return;
    const group = document.querySelector(
      '.node-group[data-node-id="' + CSS.escape(moveMode.nodeId) + '"]');
    if (group) {
      const rect = group.querySelector('.node-rect');
      if (rect) rect.classList.remove('node-rect--move-mode');
      group.removeAttribute('aria-grabbed');
    }
  }

  function commitMoveMode() {
    if (!moveMode) return;
    const node = layoutNodes[moveMode.nodeId];
    if (!node) { moveMode = null; return; }
    manualPositions[moveMode.nodeId] = { x: node.x, y: node.y };
    savePositions();
    if (isServeMode) {
      hasUnsavedChanges = true;
      const saveBtn = document.getElementById('save-layout-btn');
      if (saveBtn) {
        saveBtn.classList.add('save-btn--dirty');
        saveBtn.textContent = 'Save layout *';
      }
    }
    announceStatus((node.label || node.id) + ' moved.' +
      (isServeMode ? ' Press Save layout to persist.' : ''));
    exitMoveModeUi();
    moveMode = null;
  }

  function cancelMoveMode() {
    if (!moveMode) return;
    const node = layoutNodes[moveMode.nodeId];
    if (node) {
      node.x = moveMode.originalX;
      node.y = moveMode.originalY;
      const group = document.querySelector(
        '.node-group[data-node-id="' + CSS.escape(moveMode.nodeId) + '"]');
      if (group) {
        group.setAttribute('transform',
          'translate(' + (node.x - node.width / 2) + ',' + (node.y - node.height / 2) + ')');
      }
      updateConnectedEdges(moveMode.nodeId);
    }
    announceStatus('Move cancelled.');
    exitMoveModeUi();
    moveMode = null;
  }

  function nudgeMoveMode(dx, dy) {
    if (!moveMode) return;
    const node = layoutNodes[moveMode.nodeId];
    if (!node) return;
    node.x += dx;
    node.y += dy;
    const group = document.querySelector(
      '.node-group[data-node-id="' + CSS.escape(moveMode.nodeId) + '"]');
    if (group) {
      group.setAttribute('transform',
        'translate(' + (node.x - node.width / 2) + ',' + (node.y - node.height / 2) + ')');
    }
    updateConnectedEdges(moveMode.nodeId);
    ensureNodeVisible(node);
  }

  function handleMoveModeKeydown(e) {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowUp')    { e.preventDefault(); nudgeMoveMode(0, -step); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); nudgeMoveMode(0,  step); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeMoveMode(-step, 0); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudgeMoveMode( step, 0); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitMoveMode();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelMoveMode();
      return;
    }
    // Any other key in move mode: swallow so it can't accidentally
    // navigate selection or activate other shortcuts.
    if (e.key !== 'Tab' && e.key !== 'Shift' && e.key !== 'Control' &&
        e.key !== 'Alt' && e.key !== 'Meta') {
      e.preventDefault();
    }
  }

  // ===== Help dialog (Phase 4) =====
  let _helpReturnFocus = null;
  window.openKeyboardHelp = function() {
    const dialog = document.getElementById('keyboard-help-dialog');
    const overlay = document.getElementById('keyboard-help-overlay');
    if (!dialog || !overlay || helpDialogOpen) return;
    _helpReturnFocus = document.activeElement;
    helpDialogOpen = true;
    overlay.hidden = false;
    dialog.hidden = false;
    const helpBtn = document.getElementById('keyboard-help-btn');
    if (helpBtn) helpBtn.setAttribute('aria-expanded', 'true');
    const closeBtn = document.getElementById('kb-help-close');
    try { (closeBtn || dialog).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    overlay.addEventListener('click', closeKeyboardHelp, { once: true });
    dialog.addEventListener('keydown', handleHelpDialogKeydown);
  };

  function closeKeyboardHelp() {
    const dialog = document.getElementById('keyboard-help-dialog');
    const overlay = document.getElementById('keyboard-help-overlay');
    if (!dialog || !overlay || !helpDialogOpen) return;
    overlay.hidden = true;
    dialog.hidden = true;
    helpDialogOpen = false;
    dialog.removeEventListener('keydown', handleHelpDialogKeydown);
    const helpBtn = document.getElementById('keyboard-help-btn');
    if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
    if (_helpReturnFocus && document.body.contains(_helpReturnFocus) &&
        typeof _helpReturnFocus.focus === 'function') {
      try { _helpReturnFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    _helpReturnFocus = null;
  }
  window.closeKeyboardHelp = closeKeyboardHelp;

  function handleHelpDialogKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeKeyboardHelp();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = document.getElementById('keyboard-help-dialog');
      if (!dialog) return;
      const focusables = [...dialog.querySelectorAll(
        'button, [href], input, [tabindex]:not([tabindex="-1"])')];
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // ===== Global keyboard shortcuts =====
  // Pan when nothing is focused; +/-/0 zoom; ? opens help; Esc closes
  // open menus / panel / cancels move mode.
  function isTypingTarget(t) {
    return !!(t && t.matches && t.matches(
      'input, select, textarea, [contenteditable], [contenteditable="true"]'));
  }

  document.addEventListener('mousedown', (e) => {
    if (_nodeMenuEl && !_nodeMenuEl.contains(e.target)) hideNodeContextMenu();
    if (_hiddenPopoverEl && !_hiddenPopoverEl.contains(e.target)
        && !e.target.closest('#show-all-btn')) hideHiddenListPopover();
  });

  document.addEventListener('keydown', (e) => {
    // Esc cascade — first whatever can be most-recently dismissed.
    if (e.key === 'Escape') {
      if (helpDialogOpen) { closeKeyboardHelp(); return; }
      if (moveMode) { cancelMoveMode(); return; }
      if (_nodeMenuEl) { hideNodeContextMenu({ returnFocus: true }); return; }
      if (_hiddenPopoverEl) { hideHiddenListPopover({ returnFocus: true }); return; }
      const panel = document.getElementById('detail-panel');
      if (panel && !panel.classList.contains('hidden')) closePanel();
      return;
    }

    // Help dialog swallows other keys via its own focus-trap handler.
    if (helpDialogOpen) return;
    // While move mode is active, the listbox handler handles arrows etc.
    if (moveMode) return;
    // Don't intercept while the user is typing in a control.
    if (isTypingTarget(e.target)) return;
    // Don't fight focus traps inside the menu / popover.
    if (_nodeMenuEl && _nodeMenuEl.contains(e.target)) return;
    if (_hiddenPopoverEl && _hiddenPopoverEl.contains(e.target)) return;

    // ? opens the help dialog (Shift+/, but accept the literal '?' too).
    if (e.key === '?') {
      e.preventDefault();
      window.openKeyboardHelp();
      return;
    }

    // Zoom shortcuts.
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      window.zoomIn();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      window.zoomOut();
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      window.fitToScreen();
      announceStatus('Fit to screen.');
      return;
    }

    // Pan when no node has focus. (When a node has focus, the listbox
    // keydown handler runs first and consumes arrow keys.)
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const onNode = e.target && e.target.closest && e.target.closest('.node-group');
      if (onNode) return; // listbox handler will manage it
      e.preventDefault();
      const step = e.shiftKey ? 80 : 30;
      if (e.key === 'ArrowUp')    transform.y += step;
      if (e.key === 'ArrowDown')  transform.y -= step;
      if (e.key === 'ArrowLeft')  transform.x += step;
      if (e.key === 'ArrowRight') transform.x -= step;
      applyTransform();
    }
  });

  // Toggle screenshot visibility
  window.toggleScreenshots = function() {
    hideScreenshots = !hideScreenshots;
    const btn = document.getElementById('toggle-screenshots');
    btn.textContent = hideScreenshots ? 'Show screenshots' : 'Hide screenshots';
    btn.setAttribute('aria-pressed', String(hideScreenshots));
    render();
  };

  // Reset manual positions
  window.resetPositions = function() {
    manualPositions = {};
    savePositions();
    if (isServeMode) {
      hasUnsavedChanges = true;
      const saveBtn = document.getElementById('save-layout-btn');
      if (saveBtn) {
        saveBtn.classList.add('save-btn--dirty');
        saveBtn.textContent = 'Save layout *';
      }
    }
    announceStatus('Positions reset.');
    render();
  };

  // Wire the keyboard-help dialog close button (no inline onclick so we
  // don't have to thread it through escapeHtml in the markup).
  (function wireHelpDialog() {
    const closeBtn = document.getElementById('kb-help-close');
    if (closeBtn) closeBtn.addEventListener('click', closeKeyboardHelp);
  })();

  // Save layout to server (serve mode only)
  window.saveLayout = async function() {
    if (!isServeMode || !mapName) return;
    const saveBtn = document.getElementById('save-layout-btn');
    if (!saveBtn) return;
    try {
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      const resp = await fetch('/api/maps/' + encodeURIComponent(mapName) + '/positions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualPositions),
      });
      if (resp.ok) {
        hasUnsavedChanges = false;
        saveBtn.textContent = 'Layout saved \\u2713';
        saveBtn.classList.remove('save-btn--dirty');
        saveBtn.classList.add('save-btn--saved');
        announceStatus('Layout saved.');
        setTimeout(() => {
          saveBtn.textContent = 'Save layout';
          saveBtn.classList.remove('save-btn--saved');
          saveBtn.disabled = false;
        }, 2000);
      } else {
        throw new Error('Server returned ' + resp.status);
      }
    } catch(e) {
      saveBtn.textContent = 'Save failed';
      saveBtn.disabled = false;
      announceStatus('Save failed.');
      setTimeout(() => { saveBtn.textContent = 'Save layout'; }, 2000);
    }
  };

  // Edge geometry helpers

  // Build a straight SVG path string from two points.
  function buildOrthogonalPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
    const p0 = points[0], p1 = points[points.length - 1];
    return 'M ' + p0.x + ' ' + p0.y + ' L ' + p1.x + ' ' + p1.y;
  }


  // Returns the point on the border of a rectangle (cx, cy, w, h) that lies
  // on the straight line towards (targetX, targetY).
  function getEdgePoint(cx, cy, w, h, targetX, targetY) {
    const dx = targetX - cx;
    const dy = targetY - cy;
    const hw = w / 2;
    const hh = h / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx * hh > absDy * hw) {
      const sign = dx > 0 ? 1 : -1;
      return { x: cx + sign * hw, y: cy + (dy * hw) / absDx };
    } else {
      const sign = dy > 0 ? 1 : -1;
      return { x: cx + (dx * hh) / absDy, y: cy + sign * hh };
    }
  }

  // Straight border-to-border line (used for manually repositioned nodes).
  function computeStraightEdge(sourceId, targetId) {
    const s = layoutNodes[sourceId];
    const t = layoutNodes[targetId];
    if (!s || !t) return [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    return [
      getEdgePoint(s.x, s.y, s.width, s.height, t.x, t.y),
      getEdgePoint(t.x, t.y, t.width, t.height, s.x, s.y),
    ];
  }



  function updateConnectedEdges(nodeId) {
    document.querySelectorAll('.edge-group').forEach(eg => {
      if (eg.dataset.source !== nodeId && eg.dataset.target !== nodeId) return;
      const pts = computeStraightEdge(eg.dataset.source, eg.dataset.target);
      const d = 'M ' + pts[0].x + ' ' + pts[0].y + ' L ' + pts[1].x + ' ' + pts[1].y;
      const path = eg.querySelector('.edge-path');
      if (path) path.setAttribute('d', d);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const lbl = eg.querySelector('.edge-label');
      if (lbl) { lbl.setAttribute('x', midX); lbl.setAttribute('y', midY - 6); }
      const cLbl = eg.querySelector('.edge-condition-label');
      if (cLbl) { cLbl.setAttribute('x', midX); cLbl.setAttribute('y', midY + 10); }
    });
  }

  // Drag-to-reposition: global mouse handlers
  window.addEventListener('mousemove', (e) => {
    if (!dragTarget) return;
    const dx = e.clientX - dragTarget.startMouseX;
    const dy = e.clientY - dragTarget.startMouseY;
    if (!dragTarget.hasMoved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    dragTarget.hasMoved = true;
    isDragging = true;

    const svgRect = svg.getBoundingClientRect();
    const mouseX = (e.clientX - svgRect.left - transform.x) / transform.scale;
    const mouseY = (e.clientY - svgRect.top - transform.y) / transform.scale;
    const rawX = mouseX - dragTarget.offsetX;
    const rawY = mouseY - dragTarget.offsetY;

    // Snap to grid (15px increments)
    const GRID = 15;
    const newX = Math.round(rawX / GRID) * GRID;
    const newY = Math.round(rawY / GRID) * GRID;

    dragTarget.node.x = newX;
    dragTarget.node.y = newY;
    dragTarget.group.setAttribute('transform',
      'translate(' + (newX - dragTarget.node.width/2) + ',' + (newY - dragTarget.node.height/2) + ')'
    );
    updateConnectedEdges(dragTarget.nodeId);
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragTarget) return;
    if (dragTarget.hasMoved) {
      manualPositions[dragTarget.nodeId] = { x: dragTarget.node.x, y: dragTarget.node.y };
      savePositions();
      // Mark layout as having unsaved changes (serve mode)
      if (isServeMode) {
        hasUnsavedChanges = true;
        const saveBtn = document.getElementById('save-layout-btn');
        if (saveBtn) {
          saveBtn.classList.add('save-btn--dirty');
          saveBtn.textContent = 'Save layout *';
        }
      }
      setTimeout(() => { isDragging = false; }, 0);
    }
    dragTarget = null;
  });

  // Delegated click handler for hide button in detail panel
  document.addEventListener('click', function(e) {
    if (e.target.classList.contains('hide-node-btn')) {
      hideNode(e.target.dataset.nodeId);
    }
  });

  // Helpers
  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '…' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hubColor(hub) {
    const colors = ['#53d8fb', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#ef4444', '#22c55e'];
    let hash = 0;
    for (let i = 0; i < hub.length; i++) hash = hub.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // Show screenshot-related toggles only when screenshots are present
  if (hasScreenshots) {
    const btn = document.getElementById('toggle-thumbnail');
    btn.style.display = '';
    btn.textContent = thumbnailMode ? 'Show full pages' : 'Show thumbnails';
    btn.setAttribute('aria-pressed', String(thumbnailMode));
    const ssBtn = document.getElementById('toggle-screenshots');
    ssBtn.style.display = '';
    ssBtn.setAttribute('aria-pressed', String(hideScreenshots));
  }

  // Show feature-gated controls based on what the graph actually contains.
  // Markup is always emitted by the shell (display:none); we reveal it here
  // so the shell stays identical across map versions.
  const hasGlobalNavEdges = graph.edges.some(e => e.isGlobalNav);
  if (hasGlobalNavEdges) {
    const lbl = document.getElementById('toggle-global-nav-label');
    if (lbl) lbl.style.display = '';
  }
  const hasProvenanceEdges = graph.edges.some(e => e.provenance);
  if (hasProvenanceEdges) {
    const select = document.getElementById('provenance-filter');
    if (select) select.style.display = '';
    const legendProv = document.getElementById('legend-provenance');
    if (legendProv) legendProv.style.display = '';
  }

  // Initial render
  render();

  // Keep canvas and detail panel flush with the toolbar bottom as it resizes
  // (two-row layout means height varies with content and window width).
  (function syncToolbarOffset() {
    const toolbar = document.getElementById('toolbar');
    const canvas = document.getElementById('canvas-container');
    const panel = document.getElementById('detail-panel');
    function update() {
      const h = toolbar.offsetHeight + 'px';
      canvas.style.top = h;
      panel.style.top = h;
    }
    new ResizeObserver(update).observe(toolbar);
    update();
  })();

  // Detect serve mode and load shared positions + hidden state from the API.
  // Health check uses a short timeout so file:// loads (no server) fall through
  // to localStorage quickly, instead of hanging on a slow network failure.
  (async function detectServeMode() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      let resp;
      try {
        resp = await fetch('/api/health', { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) return;
      isServeMode = true;

      // Show the save button (positions only — hidden auto-saves)
      const saveBtn = document.getElementById('save-layout-btn');
      if (saveBtn) saveBtn.style.display = '';

      if (!mapName) return;

      // Load positions from the server (overrides localStorage and embedded).
      let positionsChanged = false;
      try {
        const posResp = await fetch('/api/maps/' + encodeURIComponent(mapName) + '/positions');
        if (posResp.ok) {
          const apiPositions = await posResp.json();
          if (Object.keys(apiPositions).length > 0) {
            manualPositions = apiPositions;
            savePositions();
            positionsChanged = true;
          }
        }
      } catch (e) {
        console.warn('[flow-map] Error loading positions from server:', e);
      }

      // Load hidden state from the server (overrides localStorage and embedded).
      let hiddenChanged = false;
      try {
        const hidResp = await fetch('/api/maps/' + encodeURIComponent(mapName) + '/hidden');
        if (hidResp.ok) {
          const apiHidden = await hidResp.json();
          if (Object.keys(apiHidden).length > 0) {
            hiddenNodes = new Set(Object.keys(apiHidden));
            // Sync to localStorage but DON'T re-PUT to server (we just read this)
            try { localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenNodes])); } catch(e) {}
            hiddenChanged = true;
          }
        }
      } catch (e) {
        console.warn('[flow-map] Error loading hidden state from server:', e);
      }

      if (positionsChanged || hiddenChanged) render();
    } catch(e) {
      // Not in serve mode — no server available, or health check timed out.
      // localStorage / embedded values stand. This is the file:// path.
    }
  })();
})();
`;
}

module.exports = {
  buildViewer,
  VIEWER_SCHEMA_VERSION,
  generateThemeBootstrapJs,
};

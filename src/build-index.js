const fs = require("fs");
const path = require("path");
const { generateThemeBootstrapJs } = require("./build-viewer");

/**
 * Scan all maps in the output directory and generate a root index page
 * that lists them with titles, dates, and links.
 */
function buildIndex(outputDir) {
  const mapsDir = path.join(outputDir, "maps");

  // Scan for all meta.json files
  const maps = [];
  if (fs.existsSync(mapsDir)) {
    const entries = fs.readdirSync(mapsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(mapsDir, entry.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          maps.push(meta);
        } catch {
          // Skip malformed meta.json
        }
      }
    }
  }

  // Sort by updatedAt descending (most recently updated first)
  maps.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  // Write the index HTML and the shared theme bootstrap
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "theme-bootstrap.js"),
    generateThemeBootstrapJs(),
  );
  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(htmlPath, generateIndexHtml(maps));
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateIndexHtml(maps) {
  const mapCards = maps
    .map((meta) => {
      const date = new Date(meta.updatedAt);
      const formattedDate = date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const isoDate = date.toISOString();

      return `      <li>
        <a href="maps/${encodeURIComponent(meta.name)}/index.html" class="map-card">
          <div class="map-card-header">
            <h2>${escapeHtml(meta.title)}</h2>
            <time class="map-card-date" datetime="${isoDate}">${formattedDate}</time>
          </div>
          <div class="map-card-stats">
            <span>${meta.nodeCount} pages</span>
            <span>${meta.edgeCount} connections</span>
            ${meta.hasScreenshots ? "<span>Screenshots</span>" : "<span>No screenshots</span>"}
            ${meta.scenario ? `<span class="map-card-scenario">${escapeHtml(meta.scenario)}</span>` : ""}
          </div>
          ${meta.from ? `<div class="map-card-from">From: ${escapeHtml(meta.from)}</div>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  const emptyState =
    maps.length === 0
      ? '<p class="empty-state">No maps yet. Run the CLI with --name to create one.</p>'
      : `<ul class="maps-list" role="list">\n${mapCards}\n  </ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <title>Quiver</title>
  <script src="theme-bootstrap.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* Theme tokens — focused subset of the viewer's palette. Dark is
     * default; light is opt-in via data-theme="light". Values mirror
     * src/build-viewer.js so the two pages feel like one product. */
    :root, :root[data-theme="dark"] {
      --bg: #1a1a2e;
      --surface-1: #16213e;
      --surface-2: #1a2a4e;
      --border: #496e9a;
      --border-strong: #3e6eae;
      --control-bg: #0f3460;
      --text: #e0e0e0;
      --text-strong: #ffffff;
      --text-muted: #9a9a9a;
      --text-meta-value: #8899aa;
      --accent: #53d8fb;
      --focus-ring: #53d8fb;
      color-scheme: dark;
    }

    :root[data-theme="light"] {
      --bg: #f4f6fa;
      --surface-1: #ffffff;
      --surface-2: #eef1f6;
      --border: #8e949d;
      --border-strong: #8a95a6;
      --control-bg: #E2E8F1;
      --text: #1c2030;
      --text-strong: #0a0d18;
      --text-muted: #5a6378;
      --text-meta-value: #4a536a;
      --accent: #0a6480;
      --focus-ring: #0a4870;
      color-scheme: light;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 32px;
    }

    /* Skip link — visible only when focused. */
    .skip-link {
      position: absolute;
      top: 8px;
      left: 8px;
      padding: 8px 12px;
      background: var(--surface-1);
      color: var(--text-strong);
      border: 2px solid var(--focus-ring);
      border-radius: 4px;
      text-decoration: none;
      transform: translateY(-200%);
      transition: transform 0.15s;
      z-index: 100;
    }
    .skip-link:focus { transform: translateY(0); }

    header {
      max-width: 800px;
      margin: 0 auto 32px;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
    }
    header h1 {
      font-size: 24px;
      color: var(--text-strong);
      margin-bottom: 4px;
    }
    header p {
      font-size: 14px;
      color: var(--text-meta-value);
    }

    #theme-toggle {
      background: var(--control-bg);
      color: var(--text);
      border: 1px solid var(--border-strong);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      min-height: 32px;
    }
    #theme-toggle:hover { background: var(--surface-2); }

    .maps-list {
      max-width: 800px;
      margin: 0 auto;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .map-card {
      display: block;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .map-card:hover {
      border-color: var(--accent);
      background: var(--surface-2);
    }
    .map-card-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .map-card-header h2 {
      font-size: 16px;
      color: var(--text-strong);
      font-weight: 600;
    }
    .map-card-date {
      font-size: 12px;
      color: var(--text-meta-value);
      white-space: nowrap;
      margin-left: 16px;
    }
    .map-card-stats {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--text-meta-value);
    }
    .map-card-scenario {
      background: var(--control-bg);
      padding: 1px 6px;
      border-radius: 3px;
      color: var(--accent);
    }
    .map-card-from {
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: monospace;
    }
    .empty-state {
      text-align: center;
      color: var(--text-muted);
      padding: 48px 16px;
      font-size: 14px;
    }

    /* WCAG 2.4.7 / 2.4.11 — visible focus on every keyboard target. */
    .skip-link:focus-visible,
    #theme-toggle:focus-visible,
    .map-card:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }

    /* Reduced motion — no transitions or transforms. */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
      .skip-link { transition: none; }
    }

    /* Forced colours (Windows High Contrast) — defer to system tokens
     * so user-defined palettes win. */
    @media (forced-colors: active) {
      .map-card { border-color: CanvasText; }
      .map-card:hover, .map-card:focus-visible {
        border-color: Highlight;
        background: Canvas;
      }
      .skip-link:focus-visible,
      #theme-toggle:focus-visible,
      .map-card:focus-visible {
        outline-color: Highlight;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to map list</a>
  <header>
    <div class="header-row">
      <div>
        <h1>Quiver</h1>
        <p>${maps.length} map${maps.length !== 1 ? "s" : ""}</p>
      </div>
      <button id="theme-toggle" type="button" aria-pressed="false" aria-label="Switch to light mode">Light mode</button>
    </div>
  </header>
  <main id="main" tabindex="-1">
    ${emptyState}
  </main>
  <script>
    (function () {
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

      function syncToggle() {
        var theme = document.documentElement.getAttribute('data-theme') || 'dark';
        var nextLabel = theme === 'light' ? 'Dark mode' : 'Light mode';
        var nextDesc  = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
        btn.textContent = nextLabel;
        btn.setAttribute('aria-label', nextDesc);
        btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      }

      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        var next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('flowmap-theme', next); } catch (e) {}
        syncToggle();
      });

      if (media && media.addEventListener) {
        media.addEventListener('change', function () {
          // Only follow OS changes if the user hasn't made an explicit choice.
          try {
            if (!localStorage.getItem('flowmap-theme')) {
              document.documentElement.setAttribute('data-theme', media.matches ? 'light' : 'dark');
              syncToggle();
            }
          } catch (e) {}
        });
      }

      syncToggle();
    })();
  </script>
</body>
</html>`;
}

module.exports = { buildIndex };

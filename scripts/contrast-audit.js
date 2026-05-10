#!/usr/bin/env node
// Contrast audit for the generated viewer. Loads a fixture in both
// themes, runs axe-core, and computes WCAG 2.x contrast ratios for
// every meaningful foreground/background pairing. Output: JSON to
// flow-map-output/contrast-audit.json.
//
// Usage: node scripts/contrast-audit.js [fixture-name]
// Default fixture: check-in-test (smallest under flow-map-output/maps/).

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const FIXTURE = process.argv[2] || "check-in-test";
const ROOT = path.join(__dirname, "..");
const FIXTURE_PATH = path.join(ROOT, "flow-map-output", "maps", FIXTURE, "index.html");
const AXE_PATH = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");
const OUT_PATH = path.join(ROOT, "flow-map-output", "contrast-audit.json");

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error("Fixture not found:", FIXTURE_PATH);
  process.exit(1);
}
if (!fs.existsSync(AXE_PATH)) {
  console.error("axe-core not installed. Run: npm install --no-save axe-core");
  process.exit(1);
}

// --- WCAG contrast math ---------------------------------------------------
function parseColor(input) {
  if (!input) return null;
  const s = input.trim();
  // #rgb / #rrggbb
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1].length === 3
      ? m[1].split("").map((c) => c + c).join("")
      : m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  // rgb(...) / rgba(...)
  m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }
  return null;
}

// Composite a foreground colour (with optional alpha or stroke opacity) on a
// solid background, returning the effective sRGB colour.
function composite(fg, bg, opacity = 1) {
  const a = fg.a * opacity;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function relativeLuminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

function ratio(fgInput, bgInput, opacity = 1) {
  const fg = parseColor(fgInput);
  const bg = parseColor(bgInput);
  if (!fg || !bg) return null;
  const effective = opacity < 1 ? composite(fg, bg, opacity) : fg;
  return Math.round(contrast(effective, bg) * 100) / 100;
}

// --- Theme reading inside the browser -------------------------------------
async function readTheme(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    // Discover token names by scanning the inline stylesheet text — the
    // CSSOM `rule.style[i]` enumeration omits custom properties in some
    // browsers, so a regex over the source is more reliable.
    const seen = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (_) { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.cssText && rule.selectorText && /:root/.test(rule.selectorText)) {
          const re = /(--[a-z0-9-]+)\s*:/gi;
          let m;
          while ((m = re.exec(rule.cssText)) !== null) seen.add(m[1]);
        }
      }
    }
    const tokens = {};
    for (const prop of seen) {
      tokens[prop] = cs.getPropertyValue(prop).trim();
    }
    return {
      tokens,
      dataTheme: root.getAttribute("data-theme") || "dark",
    };
  });
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("flowmap-theme", t); } catch (_) {}
  }, theme);
}

async function runAxe(page) {
  return page.evaluate(async () => {
    // axe-core is loaded via addScriptTag.
    // eslint-disable-next-line no-undef
    const results = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });
    return {
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
      })),
      passes: results.passes.length,
      incomplete: results.incomplete.length,
    };
  });
}

// --- Pairings to evaluate -------------------------------------------------
//
// For each pairing we compute contrast in both themes. The "kind" decides
// the WCAG threshold we judge against:
//   text  → 4.5:1 (AA body text)
//   ui    → 3:1   (1.4.11 non-text contrast: borders, edges, focus rings)
function buildPairings(t) {
  const canvasBg = t["--bg"];
  const surface1 = t["--surface-1"];
  const surface2 = t["--surface-2"];
  const surface3 = t["--surface-3"];

  const pairs = [];

  // Text / surface
  pairs.push(
    { id: "text on surface-1", kind: "text", fg: t["--text"], bg: surface1 },
    { id: "text on surface-2", kind: "text", fg: t["--text"], bg: surface2 },
    { id: "text on bg", kind: "text", fg: t["--text"], bg: canvasBg },
    { id: "text-strong on surface-1", kind: "text", fg: t["--text-strong"], bg: surface1 },
    { id: "text-muted on surface-1", kind: "text", fg: t["--text-muted"], bg: surface1 },
    { id: "text-subtle on surface-1", kind: "text", fg: t["--text-subtle"], bg: surface1 },
    { id: "text-popover on surface-1", kind: "text", fg: t["--text-popover"], bg: surface1 },
    { id: "text-meta-key on surface-1", kind: "text", fg: t["--text-meta-key"], bg: surface1 },
    { id: "text-meta-value on surface-1", kind: "text", fg: t["--text-meta-value"], bg: surface1 },
    { id: "text-meta-faint on surface-1", kind: "text", fg: t["--text-meta-faint"], bg: surface1 },
    { id: "accent-link on surface-1", kind: "text", fg: t["--accent-link"], bg: surface1 },
    { id: "accent-soft on surface-1", kind: "text", fg: t["--accent-soft"], bg: surface1 }
  );

  // Borders and focus
  pairs.push(
    { id: "border on surface-1", kind: "ui", fg: t["--border"], bg: surface1 },
    { id: "border-strong on surface-1", kind: "ui", fg: t["--border-strong"], bg: surface1 },
    { id: "border-popover on surface-1", kind: "ui", fg: t["--border-popover"], bg: surface1 },
    { id: "focus-ring on surface-1", kind: "ui", fg: t["--focus-ring"], bg: surface1 },
    { id: "focus-ring on bg", kind: "ui", fg: t["--focus-ring"], bg: canvasBg },
    { id: "accent on surface-1", kind: "ui", fg: t["--accent"], bg: surface1 }
  );

  // Node strokes vs canvas (drawn on --bg, not surface-1)
  const nodeTypes = [
    "content", "question", "check-answers", "confirmation", "error",
    "splash", "index", "screen", "web-view", "external", "web-page",
  ];
  for (const type of nodeTypes) {
    pairs.push({
      id: `node-${type} stroke on bg`,
      kind: "ui",
      fg: t[`--node-${type}-stroke`],
      bg: canvasBg,
    });
    pairs.push({
      id: `node-${type} fill on bg`,
      kind: "ui",
      fg: t[`--node-${type}-fill`],
      bg: canvasBg,
    });
    // Label text on the fill (label uses --node-label / --text).
    pairs.push({
      id: `node-${type} label on fill`,
      kind: "text",
      fg: t["--node-label"],
      bg: t[`--node-${type}-fill`],
    });
  }

  // Edge strokes vs canvas. Edges use opacity 0.5–0.85 in CSS; we report
  // both raw stroke and the effective composited colour.
  const edges = [
    { type: "form", opacity: 0.85 },
    { type: "link", opacity: 0.75 },
    { type: "conditional", opacity: 0.7 },
    { type: "redirect", opacity: 0.85 },
    { type: "render", opacity: 0.85 },
    { type: "nav", opacity: 0.75 },
    { type: "sheet", opacity: 0.8 },
    { type: "full-screen", opacity: 0.85 },
    { type: "tab", opacity: 0.75 },
    { type: "web-view", opacity: 0.75 },
    { type: "safari", opacity: 0.75 },
  ];
  for (const e of edges) {
    pairs.push({
      id: `edge-${e.type} stroke on bg (raw)`,
      kind: "ui",
      fg: t[`--edge-${e.type}`],
      bg: canvasBg,
    });
    pairs.push({
      id: `edge-${e.type} stroke on bg (effective @${e.opacity})`,
      kind: "ui",
      fg: t[`--edge-${e.type}`],
      bg: canvasBg,
      opacity: e.opacity,
    });
  }

  // Edge labels.
  pairs.push(
    { id: "edge-label on bg", kind: "text", fg: t["--edge-label"], bg: canvasBg },
    { id: "edge-condition-label on bg", kind: "text", fg: t["--edge-condition-label"], bg: canvasBg }
  );

  // Provenance pill text on its own bg.
  for (const p of ["runtime", "static", "both", "nav"]) {
    pairs.push({
      id: `provenance-${p} text on its bg`,
      kind: "text",
      fg: t[`--provenance-${p}-fg`],
      bg: t[`--provenance-${p}-bg`],
    });
  }

  // Compute ratios.
  return pairs.map((p) => ({
    ...p,
    ratio: ratio(p.fg, p.bg, p.opacity || 1),
    threshold: p.kind === "text" ? 4.5 : 3,
    pass: (() => {
      const r = ratio(p.fg, p.bg, p.opacity || 1);
      if (r === null) return null;
      return r >= (p.kind === "text" ? 4.5 : 3);
    })(),
  }));
}

// --- Main -----------------------------------------------------------------
(async () => {
  const browser = await chromium.launch({
    headless: true,
    // Allow CSSStyleSheet.cssRules access for stylesheets loaded from the
    // same file:// directory tree. Without this flag the inline viewer's
    // linked styles.css raises a SecurityError when we try to enumerate
    // custom properties.
    args: ["--allow-file-access-from-files"],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const url = "file://" + FIXTURE_PATH;

  const results = { fixture: FIXTURE, themes: {} };

  for (const theme of ["dark", "light"]) {
    // Pre-set the theme in localStorage via init script so the bootstrap
    // <head> script picks it up before stylesheets paint.
    await ctx.addInitScript((t) => {
      try { localStorage.setItem("flowmap-theme", t); } catch (_) {}
    }, theme);

    await page.goto(url, { waitUntil: "load" });
    // Belt-and-braces: also force the attribute (covers any race).
    await setTheme(page, theme);
    await page.waitForTimeout(150);

    await page.addScriptTag({ path: AXE_PATH });
    const axeResults = await runAxe(page);

    const themeData = await readTheme(page);
    const pairings = buildPairings(themeData.tokens);

    results.themes[theme] = {
      dataTheme: themeData.dataTheme,
      tokens: themeData.tokens,
      pairings,
      axe: axeResults,
    };

    // Reset init scripts between themes.
    await ctx.clearCookies();
  }

  await browser.close();

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));

  // Console summary.
  for (const theme of ["dark", "light"]) {
    const r = results.themes[theme];
    const fails = r.pairings.filter((p) => p.pass === false);
    console.log(
      `[${theme}] axe violations: ${r.axe.violations.length}, ` +
      `contrast pairings: ${r.pairings.length}, failing: ${fails.length}`
    );
    for (const f of fails) {
      console.log(
        `  FAIL  ${f.id.padEnd(48)} ${String(f.ratio).padStart(5)}:1 (need ${f.threshold}:1)`
      );
    }
  }

  console.log("\nWrote", OUT_PATH);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

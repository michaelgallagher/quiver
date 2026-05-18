#!/usr/bin/env node
// Smoke-test the Phase 5 accessibility additions — the screen reader-friendly
// outline view. Greps over emitted index.html / styles.css / viewer.js so the
// test is cheap and fast.
//
// Usage: node scripts/smoke-test-phase5.js [map-name]

const fs = require("fs");
const path = require("path");

const mapName = process.argv[2] || "demonhsapp2";
const rootOutputDir = path.join(__dirname, "..", "quiver-output");
const mapDir = path.join(rootOutputDir, "maps", mapName);
const html = fs.readFileSync(path.join(mapDir, "index.html"), "utf-8");
const css = fs.readFileSync(path.join(rootOutputDir, "styles.css"), "utf-8");
const js = fs.readFileSync(path.join(rootOutputDir, "viewer.js"), "utf-8");

let passed = 0;
let failed = 0;

function assertContains(haystack, needle, name) {
  if (haystack.includes(needle)) {
    console.log("  ✓ " + name);
    passed += 1;
  } else {
    console.log("  ✗ " + name + " — missing: " + JSON.stringify(needle));
    failed += 1;
  }
}

console.log("HTML — outline toggle button");
assertContains(html, 'id="outline-toggle"', "Outline toggle button exists");
assertContains(html, 'aria-pressed="false"', "Toggle starts unpressed");
assertContains(html, 'onclick="toggleOutlineView()"', "Toggle calls toggleOutlineView");
assertContains(html, 'View as outline', "Toggle has visible label");

console.log("\nHTML — outline nav element");
assertContains(html, 'id="flow-outline"', "Outline nav element exists");
assertContains(html, 'aria-labelledby="outline-heading"', "Outline labelled by heading");
assertContains(html, '<nav', "Outline uses <nav> landmark");

console.log("\nCSS — outline panel");
assertContains(css, "#flow-outline:not(.outline-active)", "Visually-hidden rule when inactive");
assertContains(css, "clip: rect(0, 0, 0, 0)", "Outline uses clip technique (not display:none)");
assertContains(css, "#flow-outline.outline-active", "Active state shows the panel");
assertContains(css, "overflow-y: auto", "Active outline scrolls vertically");
assertContains(css, ".outline-list", "Outline list style defined");
assertContains(css, ".outline-item", "Outline item style defined");
assertContains(css, ".outline-node-btn", "Outline node button style");
assertContains(css, ".outline-node-btn:focus-visible", "Outline button focus ring");
assertContains(css, ".outline-type-badge", "Type badge style defined");
assertContains(css, ".outline-edges-list", "Nested edge list style");
assertContains(css, ".outline-edge-item", "Edge list item style");
assertContains(css, ".outline-edge-type", "Edge type label style");

console.log("\nJS — buildOutline");
assertContains(js, "function buildOutline()", "buildOutline defined");
assertContains(js, "outline-heading", "buildOutline writes outline-heading id");
assertContains(js, "outline-list", "buildOutline renders outline-list");
assertContains(js, "outline-item", "buildOutline renders outline items");
assertContains(js, "outline-node-btn", "buildOutline renders node buttons");
assertContains(js, "outline-edges-list", "buildOutline renders edge sublists");
assertContains(js, "outline-edge-type", "buildOutline renders edge types");
assertContains(js, "buildOutline()", "buildOutline called from render");

console.log("\nJS — toggleOutlineView");
assertContains(js, "window.toggleOutlineView", "toggleOutlineView exposed");
assertContains(js, "outlineMode = !outlineMode", "toggleOutlineView flips state");
assertContains(js, "outline-toggle", "toggleOutlineView references toggle button");
assertContains(js, "outline.classList.add('outline-active')", "Adds active class on enable");
assertContains(js, "outline.classList.remove('outline-active')", "Removes active class on disable");
assertContains(js, "canvas.setAttribute('aria-hidden', 'true')", "Hides canvas from AT when outline active");
assertContains(js, "canvas.style.display = 'none'", "Canvas display:none when outline active");
assertContains(js, "canvas.style.display = ''", "Canvas restored when outline inactive");
assertContains(js, "View as map", "Button label flips to 'View as map' when outline active");
assertContains(js, "View as outline", "Button label resets to 'View as outline'");
assertContains(js, "btn.setAttribute('aria-pressed'", "aria-pressed updated on toggle");
assertContains(js, "heading.focus(", "Focus moves to outline heading on enable");
assertContains(js, "announceStatus('Outline view", "Status announced on enable");
assertContains(js, "announceStatus('Map view", "Status announced on disable");

console.log("\nJS — skip-link update");
assertContains(js, "skipLink.setAttribute('href', '#flow-outline')", "Skip link updated to outline when active");
assertContains(js, "skipLink.setAttribute('href', '#canvas-container')", "Skip link restored to canvas when inactive");

console.log("\n=================================");
console.log(`Passed: ${passed}, Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);

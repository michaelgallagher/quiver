#!/usr/bin/env node
// Boot the generated viewer in headless Chromium and exercise the new
// Phase 4 keyboard shortcuts. Verifies:
//  - the page loads without JS errors
//  - ? opens and Esc closes the keyboard help dialog
//  - + / - / 0 mutate the SVG transform
//  - M enters move mode and applies the move-mode class
//  - arrow keys in move mode move the node, Esc reverts, Enter commits
//  - Shift+F10 opens the role=menu node-actions menu

const path = require("path");
const url = require("url");
const { chromium } = require("playwright");

const mapName = process.argv[2] || "demonhsapp2";
const mapDir = path.join(
  __dirname,
  "..",
  "quiver-output",
  "maps",
  mapName,
);
const fileUrl = url.pathToFileURL(path.join(mapDir, "index.html")).href;

let pass = 0;
let fail = 0;
function ok(name) { console.log("  ✓ " + name); pass += 1; }
function bad(name, why) { console.log("  ✗ " + name + " — " + why); fail += 1; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const txt = msg.text();
    // The serve-mode health check is fire-and-forget; under file:// the
    // fetch fails with "URL scheme 'file' is not supported", which is
    // expected and unrelated to the viewer's behaviour.
    if (txt.includes("/api/health") || txt.includes("file:///api/")) return;
    errors.push("[console] " + txt);
  });

  await page.goto(fileUrl);
  await page.waitForFunction(() => document.querySelectorAll(".node-group").length > 0);

  console.log("Page load");
  if (errors.length === 0) ok("No JS errors on load");
  else bad("No JS errors on load", errors.join("\n"));

  console.log("\nHelp dialog");
  await page.keyboard.press("?");
  let dialogVisible = await page.evaluate(() => {
    const d = document.getElementById("keyboard-help-dialog");
    return d && !d.hidden;
  });
  if (dialogVisible) ok("? opens help dialog");
  else bad("? opens help dialog", "dialog still hidden");
  const focusOnClose = await page.evaluate(() =>
    document.activeElement && document.activeElement.id === "kb-help-close");
  if (focusOnClose) ok("Initial focus on Close button");
  else bad("Initial focus on Close button", "active element != #kb-help-close");
  await page.keyboard.press("Escape");
  dialogVisible = await page.evaluate(() => {
    const d = document.getElementById("keyboard-help-dialog");
    return d && !d.hidden;
  });
  if (!dialogVisible) ok("Escape closes help dialog");
  else bad("Escape closes help dialog", "still visible");

  console.log("\nZoom shortcuts");
  const baseScale = await page.evaluate(() => {
    const g = document.getElementById("main-group");
    const t = g && g.getAttribute("transform");
    const m = t && t.match(/scale\(([0-9.]+)/);
    return m ? parseFloat(m[1]) : 1;
  });
  // Click empty canvas so focus is not on the search input or a node-group.
  await page.mouse.click(640, 700);
  await page.keyboard.press("=");
  await page.keyboard.press("=");
  const afterPlus = await page.evaluate(() => {
    const t = document.getElementById("main-group").getAttribute("transform");
    const m = t.match(/scale\(([0-9.]+)/);
    return parseFloat(m[1]);
  });
  if (afterPlus > baseScale) ok("Plus zooms in (" + baseScale.toFixed(2) + " -> " + afterPlus.toFixed(2) + ")");
  else bad("Plus zooms in", baseScale + " -> " + afterPlus);
  await page.keyboard.press("-");
  const afterMinus = await page.evaluate(() => {
    const t = document.getElementById("main-group").getAttribute("transform");
    const m = t.match(/scale\(([0-9.]+)/);
    return parseFloat(m[1]);
  });
  if (afterMinus < afterPlus) ok("Minus zooms out");
  else bad("Minus zooms out", afterPlus + " -> " + afterMinus);
  await page.keyboard.press("0");
  const afterFit = await page.evaluate(() => {
    const t = document.getElementById("main-group").getAttribute("transform");
    return t;
  });
  if (afterFit) ok("0 fits to screen (" + afterFit + ")");
  else bad("0 fits to screen", "no transform");

  console.log("\nMove mode");
  // Focus the first focusable node by Tab-ing past skip + toolbar + canvas.
  await page.evaluate(() => {
    const g = document.querySelector('.node-group[tabindex="0"]');
    if (g) g.focus();
  });
  let focusedId = await page.evaluate(() =>
    document.activeElement && document.activeElement.dataset && document.activeElement.dataset.nodeId);
  if (focusedId) ok("Focused a node-group (id=" + focusedId + ")");
  else bad("Focused a node-group", "no node focused");

  const before = await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    return g ? g.getAttribute("transform") : null;
  }, focusedId);

  await page.keyboard.press("m");
  const inMoveMode = await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    return g && g.getAttribute("aria-grabbed") === "true" &&
      g.querySelector(".node-rect").classList.contains("node-rect--move-mode");
  }, focusedId);
  if (inMoveMode) ok("M enters move mode (aria-grabbed + class)");
  else bad("M enters move mode", "no aria-grabbed");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const duringMove = await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    return g ? g.getAttribute("transform") : null;
  }, focusedId);
  if (duringMove !== before) ok("Arrow keys nudge node");
  else bad("Arrow keys nudge node", "transform unchanged: " + before);

  await page.keyboard.press("Escape");
  const afterCancel = await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    return {
      transform: g.getAttribute("transform"),
      grabbed: g.getAttribute("aria-grabbed"),
      hasClass: g.querySelector(".node-rect").classList.contains("node-rect--move-mode"),
    };
  }, focusedId);
  if (afterCancel.transform === before) ok("Escape reverts position");
  else bad("Escape reverts position", before + " -> " + afterCancel.transform);
  if (!afterCancel.grabbed && !afterCancel.hasClass) ok("Escape exits move mode");
  else bad("Escape exits move mode", JSON.stringify(afterCancel));

  // Now commit instead.
  await page.keyboard.press("m");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const afterCommit = await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    return {
      transform: g.getAttribute("transform"),
      grabbed: g.getAttribute("aria-grabbed"),
      hasClass: g.querySelector(".node-rect").classList.contains("node-rect--move-mode"),
    };
  }, focusedId);
  if (afterCommit.transform !== before) ok("Enter commits new position");
  else bad("Enter commits new position", "transform unchanged");
  if (!afterCommit.grabbed && !afterCommit.hasClass) ok("Enter exits move mode");
  else bad("Enter exits move mode", JSON.stringify(afterCommit));

  console.log("\nContext menu");
  // Refocus the same node, then trigger Shift+F10.
  await page.evaluate((id) => {
    const g = document.querySelector('.node-group[data-node-id="' + CSS.escape(id) + '"]');
    if (g) g.focus();
  }, focusedId);
  await page.keyboard.down("Shift");
  await page.keyboard.press("F10");
  await page.keyboard.up("Shift");
  const menuPresent = await page.evaluate(() => {
    const m = document.querySelector(".node-context-menu");
    return m && m.getAttribute("role") === "menu" &&
      !!m.querySelector('[role="menuitem"]') &&
      document.activeElement && document.activeElement.classList.contains("ncm-item");
  });
  if (menuPresent) ok("Shift+F10 opens role=menu with focused menuitem");
  else bad("Shift+F10 opens role=menu", "menu/state mismatch");
  await page.keyboard.press("Escape");
  const menuGone = await page.evaluate(() => !document.querySelector(".node-context-menu"));
  if (menuGone) ok("Escape closes menu");
  else bad("Escape closes menu", "menu still present");

  await browser.close();

  console.log("\n=================================");
  console.log(`Passed: ${pass}, Failed: ${fail}`);
  if (errors.length) {
    console.log("\nErrors captured:");
    errors.forEach(e => console.log("  - " + e));
  }
  process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
})();

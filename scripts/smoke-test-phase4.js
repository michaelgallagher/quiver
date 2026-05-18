#!/usr/bin/env node
// Smoke-test the Phase 4 accessibility additions in the generated
// viewer. We grep over the emitted index.html / styles.css / viewer.js
// rather than booting a real browser so the test is cheap and tied to
// the build output the user actually ships.
//
// Usage: node scripts/smoke-test-phase4.js [map-name]

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
    console.log("  ✗ " + name + " — missing: " + needle);
    failed += 1;
  }
}

console.log("HTML structure");
assertContains(html, 'id="keyboard-help-btn"', "Keyboard shortcuts toolbar button");
assertContains(html, 'aria-haspopup="dialog"', "Keyboard help button advertises dialog");
assertContains(html, 'id="node-actions-btn"', "Node actions toolbar button");
assertContains(html, 'aria-haspopup="menu"', "Node actions advertises menu");
assertContains(html, 'id="a11y-status"', "A11y live-status region exists");
assertContains(html, 'role="status"', "A11y region has role=status");
assertContains(html, 'aria-live="polite"', "A11y region is polite");
assertContains(html, 'id="keyboard-help-overlay"', "Help overlay element exists");
assertContains(html, 'id="keyboard-help-dialog"', "Help dialog element exists");
assertContains(html, 'role="dialog"', "Help has dialog role");
assertContains(html, 'aria-modal="true"', "Help dialog is modal");
assertContains(html, 'aria-labelledby="kb-help-title"', "Help dialog labelled by title");
assertContains(html, 'id="kb-help-title"', "Help dialog has title element");
assertContains(html, 'id="kb-help-close"', "Help dialog close button exists");
assertContains(html, "<kbd>?</kbd>", "Help mentions the ? key");
assertContains(html, "move mode", "Help describes move mode");
assertContains(html, "Shift</kbd>+<kbd>F10</kbd>", "Help describes Shift+F10");

console.log("\nCSS");
assertContains(css, ".node-rect--move-mode", "Move-mode visual style exists");
assertContains(css, "@keyframes flowmap-move-pulse", "Move-mode pulse animation defined");
assertContains(css, ".kb-help-overlay", "Help dialog overlay style");
assertContains(css, ".kb-help-dialog", "Help dialog card style");
assertContains(css, ".kb-help-list kbd", "Help dialog kbd styling");
assertContains(css, "#node-actions-btn:disabled", "Node actions disabled state");
assertContains(css, ".node-context-menu .ncm-item:focus-visible",
  "Menu item focus ring");
assertContains(css, ".hidden-list-popover .hlp-restore:focus-visible",
  "Hidden popover focus ring");
assertContains(css, "node-rect--move-mode {", "Move-mode rule body");
assertContains(css, "stroke: Mark !important", "Forced-colors fallback for move-mode");

console.log("\nJS — keyboard shortcuts");
assertContains(js, "openKeyboardHelp", "Help dialog open exposed");
assertContains(js, "closeKeyboardHelp", "Help dialog close exposed");
assertContains(js, "openFocusedNodeMenu", "Focused-node menu opener exposed");
assertContains(js, "if (e.key === '?')", "? opens help dialog");
assertContains(js, "if (e.key === '+' || e.key === '=')", "Plus zooms in");
assertContains(js, "if (e.key === '-' || e.key === '_')", "Minus zooms out");
assertContains(js, "if (e.key === '0')", "0 fits to screen");
assertContains(js, "isTypingTarget", "Typing-target guard defined");
assertContains(js, "ArrowUp", "Arrow handling present");
assertContains(js, "transform.x += step", "Arrow-pan when no node focused");

console.log("\nJS — move mode");
assertContains(js, "function enterMoveMode", "enterMoveMode defined");
assertContains(js, "function commitMoveMode", "commitMoveMode defined");
assertContains(js, "function cancelMoveMode", "cancelMoveMode defined");
assertContains(js, "function nudgeMoveMode", "nudgeMoveMode defined");
assertContains(js, "function handleMoveModeKeydown", "Move-mode keydown handler defined");
assertContains(js, "node-rect--move-mode", "Move-mode class applied");
assertContains(js, "originalX", "Original position recorded");
assertContains(js, "e.shiftKey ? 32 : 8", "Shift modifier scales nudge step");
assertContains(js, "if (e.key === 'm' || e.key === 'M')", "M enters move mode");
assertContains(js, "aria-grabbed", "aria-grabbed reflected on move-mode node");

console.log("\nJS — context menu");
assertContains(js, "menu.setAttribute('role', 'menu')", "Menu uses role=menu");
assertContains(js, "role=\"menuitem\"", "Items use role=menuitem");
assertContains(js, "function handleNodeMenuKeydown", "Menu keydown handler defined");
assertContains(js, "function openNodeMenuForFocused", "Keyboard menu opener defined");
assertContains(js, "ContextMenu", "ContextMenu key triggers menu");
assertContains(js, "F10' && e.shiftKey", "Shift+F10 triggers menu");
assertContains(js, "fromKeyboard", "Menu remembers keyboard origin");
assertContains(js, "_nodeMenuTrigger", "Menu remembers trigger for focus return");

console.log("\nJS — hidden-list popover");
assertContains(js, "pop.setAttribute('role', 'dialog')", "Popover uses role=dialog");
assertContains(js, "pop.setAttribute('aria-modal', 'true')", "Popover is modal");
assertContains(js, "function handleHiddenPopoverKeydown",
  "Popover keydown handler defined");
assertContains(js, "_hiddenPopoverTrigger", "Popover remembers trigger");
assertContains(js, "id=\"hlp-title\"", "Popover has labelled title");

console.log("\nJS — live-region announcements");
assertContains(js, "function announceStatus", "announceStatus helper");
assertContains(js, "announceStatus('Layout saved.')", "Layout save announces");
assertContains(js, "announceStatus('Positions reset.')", "Reset announces");
assertContains(js, "announceStatus('Move mode for ", "Move-mode start announces");
assertContains(js, "announceStatus('Move cancelled.')", "Move cancel announces");
assertContains(js, "moved.'", "Move commit announces");

console.log("\n=================================");
console.log(`Passed: ${passed}, Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);

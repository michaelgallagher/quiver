#!/usr/bin/env node
// One-shot accessibility check for the maps index page (src/build-index.js).
// Loads the regenerated flow-map-output/index.html in both themes, runs
// axe-core under WCAG 2.0/2.1/2.2 AA tags, asserts a few semantic
// landmarks the generator promises, and prints a pass/fail summary.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "flow-map-output", "index.html");
const AXE_PATH = path.join(ROOT, "node_modules", "axe-core", "axe.min.js");

if (!fs.existsSync(INDEX_PATH)) {
  console.error("Index not found:", INDEX_PATH, "— run buildIndex first.");
  process.exit(1);
}
if (!fs.existsSync(AXE_PATH)) {
  console.error("axe-core not installed. Run: npm install --no-save axe-core");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  let totalFailures = 0;

  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript((t) => {
      try { localStorage.setItem("flowmap-theme", t); } catch (e) {}
    }, theme);
    await page.goto("file://" + INDEX_PATH);
    await page.waitForLoadState("domcontentloaded");

    // Verify theme bootstrap actually took.
    const appliedTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (appliedTheme !== theme) {
      console.error(`[${theme}] theme bootstrap failed — got data-theme="${appliedTheme}"`);
      totalFailures++;
    }

    // Structural checks — match expectations from build-index.js.
    const structural = await page.evaluate(() => {
      const skip = document.querySelector("a.skip-link[href='#main']");
      const main = document.querySelector("main#main");
      const toggle = document.getElementById("theme-toggle");
      return {
        hasSkipLink: !!skip,
        skipLinkText: skip ? skip.textContent.trim() : null,
        hasMain: !!main,
        mainTabindex: main ? main.getAttribute("tabindex") : null,
        hasH1: !!document.querySelector("header h1"),
        toggleAriaPressed: toggle ? toggle.getAttribute("aria-pressed") : null,
        toggleAriaLabel: toggle ? toggle.getAttribute("aria-label") : null,
        listRole: (() => {
          const ul = document.querySelector("ul.maps-list");
          return ul ? ul.getAttribute("role") : "no-list";
        })(),
        timeWithDatetime: !!document.querySelector("time.map-card-date[datetime]"),
        cardCount: document.querySelectorAll("a.map-card").length,
      };
    });

    const expectations = [
      ["skip link exists", structural.hasSkipLink],
      ["skip link mentions map list", /map list/i.test(structural.skipLinkText || "")],
      ["main landmark with tabindex=-1", structural.hasMain && structural.mainTabindex === "-1"],
      ["header h1 present", structural.hasH1],
      ["theme toggle has aria-pressed", structural.toggleAriaPressed === "true" || structural.toggleAriaPressed === "false"],
      ["theme toggle has aria-label", !!structural.toggleAriaLabel],
      ["maps list has role=list (or no list when empty)", structural.listRole === "list" || structural.listRole === "no-list"],
      ["dates use <time datetime>", structural.cardCount === 0 || structural.timeWithDatetime],
    ];

    console.log(`\n== ${theme} ==`);
    for (const [label, ok] of expectations) {
      console.log(`  ${ok ? "✓" : "✗"} ${label}`);
      if (!ok) totalFailures++;
    }

    // Run axe.
    await page.addScriptTag({ path: AXE_PATH });
    const results = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      return await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      });
    });

    console.log(`  axe violations: ${results.violations.length}`);
    for (const v of results.violations) {
      console.log(`    ✗ ${v.id} — ${v.help}`);
      totalFailures++;
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`      ${(node.target || []).join(", ")}`);
      }
    }

    await ctx.close();
  }

  await browser.close();

  console.log("\n=================================");
  if (totalFailures === 0) {
    console.log("All checks passed.");
    process.exit(0);
  } else {
    console.log(`Total failures: ${totalFailures}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

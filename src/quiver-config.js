const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const {
  loadFlowScenarios,
  loadFlowFragments,
  loadFlowScenarioSets,
} = require("./flow-parser");

// New `quiver.config.*` names are preferred; the legacy `flow-map.config.*`
// / `.flow-map.json` names are still accepted so existing prototypes don't break.
const JSON_CONFIG_FILENAMES = [
  ".quiver.json",
  "quiver.config.json",
  ".flow-map.json",
  "flow-map.config.json",
];
const YAML_CONFIG_FILENAMES = [
  "quiver.config.yml",
  "quiver.config.yaml",
  "flow-map.config.yml",
  "flow-map.config.yaml",
];
const ALL_CONFIG_FILENAMES = [
  ...YAML_CONFIG_FILENAMES,
  ...JSON_CONFIG_FILENAMES,
];

const VALID_MODES = ["static", "scenario", "audit"];

const VALID_STEP_TYPES = [
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "submit",
  "waitForUrl",
  "waitForSelector",
  "wait",
  "beginMap",
  "endMap",
  "use",
  "visit",
  "snapshot",
  "clickLink",
  "clickButton",
  "fillIn",
  "selectFrom",
  "checkByLabel",
  "choose",
];

/**
 * Load a Quiver config file from the prototype root.
 * Looks for YAML first (quiver.config.yml), then JSON fallbacks, then the
 * legacy flow-map.config.* names.
 * Returns a validated config object, or an empty default if no file found.
 */
function loadConfig(prototypePath) {
  let config;

  for (const filename of ALL_CONFIG_FILENAMES) {
    const configPath = path.join(prototypePath, filename);
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const isYaml = YAML_CONFIG_FILENAMES.includes(filename);
        const parsed = isYaml ? YAML.parse(raw) : JSON.parse(raw);
        console.log(`   Config: ${filename}`);
        config = validateConfig(parsed);
        break;
      } catch (err) {
        console.warn(`   ⚠️  Failed to parse ${filename}: ${err.message}`);
        config = defaultConfig();
        break;
      }
    }
  }

  if (!config) config = defaultConfig();

  // Load .flow fragments from scenarios/fragments/ directory.
  // These merge with (and override) any YAML-defined fragments.
  const flowFragments = loadFlowFragments(prototypePath);
  const fragmentCount = Object.keys(flowFragments).length;
  if (fragmentCount > 0) {
    Object.assign(config.fragments, flowFragments);
    console.log(
      `   Loaded ${fragmentCount} .flow fragment(s): ${Object.keys(flowFragments).join(", ")}`,
    );
  }

  // Load .set files from scenarios/ directory.
  // These merge with (and override) any YAML-defined scenario sets.
  const flowSets = loadFlowScenarioSets(prototypePath);
  const setCount = Object.keys(flowSets).length;
  if (setCount > 0) {
    Object.assign(config.scenarioSets, flowSets);
    console.log(
      `   Loaded ${setCount} .set file(s): ${Object.keys(flowSets).join(", ")}`,
    );
  }

  // Load .flow scenario files from scenarios/ directory.
  // These merge with (and override) any YAML-defined scenarios.
  const flowScenarios = loadFlowScenarios(prototypePath);
  if (flowScenarios.length > 0) {
    const yamlNames = new Set(config.scenarios.map((s) => s.name));
    for (const flowScenario of flowScenarios) {
      if (yamlNames.has(flowScenario.name)) {
        config.scenarios = config.scenarios.filter(
          (s) => s.name !== flowScenario.name,
        );
      }
      config.scenarios.push(flowScenario);
    }
    console.log(
      `   Loaded ${flowScenarios.length} .flow scenario(s): ${flowScenarios.map((s) => s.name).join(", ")}`,
    );
  }

  return config;
}

function defaultConfig() {
  return {
    mode: "static",
    exclude: [],
    overrides: {},
    runtimeCrawl: false,
    runtimeCrawlOptions: {
      enabled: false,
    },
    runtimeMapping: {
      canonicalization: {
        collapseNumericSegments: true,
        collapseUuidSegments: true,
        collapseDateSegments: true,
        collapseTemplateExpressions: true,
        dropIgnoredQueryParams: true,
      },
      filters: {
        suppressGlobalNav: true,
        suppressUtilityLinks: true,
        suppressDebugRoutes: true,
      },
    },
    // Web jump-offs: when an iOS or Android prototype links to a hosted web
    // prototype (e.g. NHS Prototype Kit on Heroku), shallow-BFS that URL and
    // splice the resulting pages into the native flow map as a web subgraph.
    //
    // Opt-in: defaults to disabled so existing runs stay deterministic and
    // don't make unexpected network calls. Enable per-prototype via config or
    // via the --web-jumpoffs CLI flag.
    webJumpoffs: {
      enabled: false,
      maxDepth: 3,
      maxPages: 40,
      timeoutMs: 15000,
      sameOriginOnly: true,
      screenshots: true,
      // When true (default), inject the same CSS the production native
      // InAppBrowser injects (`.hide-on-native { display: none }` plus a
      // few NHS-prototype-kit wrapper paddings) so web screenshots match
      // what the user sees in the app, not what the URL serves to a plain
      // browser. Set to false to capture pages with their full chrome.
      hideNativeChrome: true,
      // Optional extra CSS appended to the chrome-stripping CSS — useful
      // when a prototype uses non-standard chrome selectors. Plain CSS
      // string; injected at document start before any page script runs.
      injectCss: null,
      allowlist: [],
      // Per-page disk cache for crawled web subgraphs. When iOS and
      // Android prototypes both link to the same Heroku origins, the
      // second platform's run hits the cache for any URL the first run
      // already captured — no network round-trip, no fresh screenshot.
      // Cache key includes a fingerprint of the fields that affect a
      // single page's output (viewport, hideNativeChrome, injectCss),
      // so changing those auto-invalidates without manual intervention.
      cache: {
        enabled: true,
        // 24 hours. Pages older than this re-crawl. Trade-off: longer
        // TTL saves more bandwidth but risks showing stale screenshots
        // when the hosted prototype changes. The hosted Heroku
        // prototypes change rarely enough that 24h is a sensible
        // default; tune via config if you're iterating on a hosted
        // prototype actively.
        ttlMs: 24 * 60 * 60 * 1000,
        // Optional override; defaults to
        // `$XDG_CACHE_HOME/quiver/web-pages/`.
        dir: null,
      },
    },
    fragments: {},
    scenarioSets: {},
    scenarios: [],
  };
}

function validateConfig(raw) {
  const config = defaultConfig();

  // Mode
  if (typeof raw.mode === "string" && VALID_MODES.includes(raw.mode)) {
    config.mode = raw.mode;
  }

  // Legacy iOS fields
  if (Array.isArray(raw.exclude)) {
    config.exclude = raw.exclude.filter((e) => typeof e === "string");
  }

  if (raw.overrides && typeof raw.overrides === "object") {
    for (const [viewName, override] of Object.entries(raw.overrides)) {
      if (override && Array.isArray(override.steps)) {
        config.overrides[viewName] = {
          steps: override.steps.filter((s) => typeof s === "string"),
        };
      }
    }
  }

  // Legacy web runtimeCrawl fields
  if (typeof raw.runtimeCrawl === "boolean") {
    config.runtimeCrawl = raw.runtimeCrawl;
    config.runtimeCrawlOptions.enabled = raw.runtimeCrawl;
  }

  if (
    raw.runtimeCrawlOptions &&
    typeof raw.runtimeCrawlOptions === "object" &&
    !Array.isArray(raw.runtimeCrawlOptions)
  ) {
    if (typeof raw.runtimeCrawlOptions.enabled === "boolean") {
      config.runtimeCrawlOptions.enabled = raw.runtimeCrawlOptions.enabled;
      config.runtimeCrawl = raw.runtimeCrawlOptions.enabled;
    }
  }

  // Runtime mapping options (scenario/audit modes)
  if (raw.runtimeMapping && typeof raw.runtimeMapping === "object") {
    const rm = raw.runtimeMapping;

    if (rm.canonicalization && typeof rm.canonicalization === "object") {
      for (const key of Object.keys(config.runtimeMapping.canonicalization)) {
        if (typeof rm.canonicalization[key] === "boolean") {
          config.runtimeMapping.canonicalization[key] =
            rm.canonicalization[key];
        }
      }
    }

    if (rm.filters && typeof rm.filters === "object") {
      for (const key of Object.keys(config.runtimeMapping.filters)) {
        if (typeof rm.filters[key] === "boolean") {
          config.runtimeMapping.filters[key] = rm.filters[key];
        }
      }
    }
  }

  // Web jump-offs
  if (raw.webJumpoffs && typeof raw.webJumpoffs === "object") {
    const wj = raw.webJumpoffs;
    if (typeof wj.enabled === "boolean") {
      config.webJumpoffs.enabled = wj.enabled;
    }
    if (typeof wj.maxDepth === "number" && wj.maxDepth >= 0) {
      config.webJumpoffs.maxDepth = Math.floor(wj.maxDepth);
    }
    if (typeof wj.maxPages === "number" && wj.maxPages > 0) {
      config.webJumpoffs.maxPages = Math.floor(wj.maxPages);
    }
    if (typeof wj.timeoutMs === "number" && wj.timeoutMs > 0) {
      config.webJumpoffs.timeoutMs = Math.floor(wj.timeoutMs);
    }
    if (typeof wj.sameOriginOnly === "boolean") {
      config.webJumpoffs.sameOriginOnly = wj.sameOriginOnly;
    }
    if (typeof wj.screenshots === "boolean") {
      config.webJumpoffs.screenshots = wj.screenshots;
    }
    if (typeof wj.hideNativeChrome === "boolean") {
      config.webJumpoffs.hideNativeChrome = wj.hideNativeChrome;
    }
    if (typeof wj.injectCss === "string") {
      config.webJumpoffs.injectCss = wj.injectCss;
    }
    if (Array.isArray(wj.allowlist)) {
      // Normalize each allowlist entry to its origin form (protocol + host)
      // so comparisons against runtime URLs are robust to trailing paths.
      config.webJumpoffs.allowlist = wj.allowlist
        .filter((o) => typeof o === "string")
        .map((o) => {
          try {
            return new URL(o).origin;
          } catch {
            return o; // leave malformed entries; they simply won't match anything
          }
        });
    }
    if (wj.cache && typeof wj.cache === "object") {
      if (typeof wj.cache.enabled === "boolean") {
        config.webJumpoffs.cache.enabled = wj.cache.enabled;
      }
      if (typeof wj.cache.ttlMs === "number" && wj.cache.ttlMs > 0) {
        config.webJumpoffs.cache.ttlMs = Math.floor(wj.cache.ttlMs);
      }
      if (typeof wj.cache.dir === "string" && wj.cache.dir.trim()) {
        config.webJumpoffs.cache.dir = wj.cache.dir;
      }
    }
  }

  // Fragments
  if (raw.fragments && typeof raw.fragments === "object") {
    for (const [name, steps] of Object.entries(raw.fragments)) {
      if (Array.isArray(steps)) {
        const validated = steps
          .map((s) => validateStep(s))
          .filter(Boolean);
        if (validated.length > 0) {
          config.fragments[name] = validated;
        }
      }
    }
  }

  // Scenario sets
  if (raw.scenarioSets && typeof raw.scenarioSets === "object") {
    for (const [name, list] of Object.entries(raw.scenarioSets)) {
      if (Array.isArray(list)) {
        config.scenarioSets[name] = list.filter(
          (s) => typeof s === "string",
        );
      }
    }
  }

  // Scenarios
  if (Array.isArray(raw.scenarios)) {
    config.scenarios = raw.scenarios
      .map((s) => validateScenario(s))
      .filter(Boolean);
  }

  return config;
}

function validateScenario(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name || typeof raw.name !== "string") return null;
  if (!raw.startUrl || typeof raw.startUrl !== "string") return null;

  const scenario = {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    startUrl: raw.startUrl,
    enabled: raw.enabled !== false,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === "string")
      : [],
    steps: [],
    scope: {
      includePrefixes: [],
      excludePrefixes: [],
    },
    limits: {
      maxPages: 120,
      maxDepth: 12,
    },
  };

  // Steps
  if (Array.isArray(raw.steps)) {
    scenario.steps = raw.steps.map((s) => validateStep(s)).filter(Boolean);
  }

  // Scope
  if (raw.scope && typeof raw.scope === "object") {
    if (Array.isArray(raw.scope.includePrefixes)) {
      scenario.scope.includePrefixes = raw.scope.includePrefixes.filter(
        (s) => typeof s === "string",
      );
    }
    if (Array.isArray(raw.scope.excludePrefixes)) {
      scenario.scope.excludePrefixes = raw.scope.excludePrefixes.filter(
        (s) => typeof s === "string",
      );
    }
  }

  // Limits
  if (raw.limits && typeof raw.limits === "object") {
    if (typeof raw.limits.maxPages === "number" && raw.limits.maxPages > 0) {
      scenario.limits.maxPages = raw.limits.maxPages;
    }
    if (typeof raw.limits.maxDepth === "number" && raw.limits.maxDepth > 0) {
      scenario.limits.maxDepth = raw.limits.maxDepth;
    }
  }

  return scenario;
}

function validateStep(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Handle 'use' shorthand: { use: "fragment.name" }
  if (typeof raw.use === "string") {
    return { type: "use", fragment: raw.use };
  }

  if (!raw.type || typeof raw.type !== "string") return null;
  if (!VALID_STEP_TYPES.includes(raw.type)) return null;

  const step = { type: raw.type };

  switch (raw.type) {
    case "goto":
      if (typeof raw.url !== "string") return null;
      step.url = raw.url;
      break;
    case "click":
      if (typeof raw.selector !== "string") return null;
      step.selector = raw.selector;
      break;
    case "fill":
      if (typeof raw.selector !== "string" || typeof raw.value !== "string")
        return null;
      step.selector = raw.selector;
      step.value = raw.value;
      break;
    case "select":
      if (typeof raw.selector !== "string" || typeof raw.value !== "string")
        return null;
      step.selector = raw.selector;
      step.value = raw.value;
      break;
    case "check":
      if (typeof raw.selector !== "string") return null;
      step.selector = raw.selector;
      break;
    case "submit":
      if (typeof raw.selector !== "string") return null;
      step.selector = raw.selector;
      break;
    case "waitForUrl":
      if (typeof raw.url !== "string") return null;
      step.url = raw.url;
      break;
    case "waitForSelector":
      if (typeof raw.selector !== "string") return null;
      step.selector = raw.selector;
      break;
    case "wait":
      if (typeof raw.ms !== "number") return null;
      step.ms = raw.ms;
      break;
    case "visit":
      if (typeof raw.url !== "string") return null;
      step.url = raw.url;
      break;
    case "snapshot":
    case "beginMap":
    case "endMap":
      break;
    case "use":
      if (typeof raw.fragment !== "string") return null;
      step.fragment = raw.fragment;
      break;
    case "clickLink":
    case "clickButton":
      if (typeof raw.text !== "string") return null;
      step.text = raw.text;
      break;
    case "fillIn":
    case "selectFrom":
      if (typeof raw.label !== "string" || typeof raw.value !== "string")
        return null;
      step.label = raw.label;
      step.value = raw.value;
      break;
    case "checkByLabel":
    case "choose":
      if (typeof raw.label !== "string") return null;
      step.label = raw.label;
      break;
  }

  return step;
}

/**
 * Resolve scenario steps, expanding fragment references.
 */
function resolveSteps(steps, fragments) {
  const resolved = [];
  for (const step of steps) {
    if (step.type === "use") {
      const fragmentSteps = fragments[step.fragment];
      if (!fragmentSteps) {
        console.warn(
          `   ⚠️  Unknown fragment "${step.fragment}" — skipping`,
        );
        continue;
      }
      // Recursively resolve (fragments can reference other fragments)
      resolved.push(...resolveSteps(fragmentSteps, fragments));
    } else {
      resolved.push(step);
    }
  }
  return resolved;
}

/**
 * Get scenarios matching a name, set, or all enabled scenarios.
 */
function getScenarios(config, { scenario: scenarioName, scenarioSet } = {}) {
  const enabledScenarios = config.scenarios.filter((s) => s.enabled);

  if (scenarioName) {
    const match = enabledScenarios.find((s) => s.name === scenarioName);
    if (!match) {
      throw new Error(
        `Scenario "${scenarioName}" not found. Available: ${enabledScenarios.map((s) => s.name).join(", ") || "(none)"}`,
      );
    }
    return [match];
  }

  if (scenarioSet) {
    const setNames = config.scenarioSets[scenarioSet];
    if (!setNames) {
      throw new Error(
        `Scenario set "${scenarioSet}" not found. Available: ${Object.keys(config.scenarioSets).join(", ") || "(none)"}`,
      );
    }
    const nameSet = new Set(setNames);
    // Preserve the order from the .set file, not the alphabetical load order
    const matched = setNames
      .map((name) => enabledScenarios.find((s) => s.name === name))
      .filter(Boolean);
    if (matched.length === 0) {
      throw new Error(
        `No enabled scenarios found in set "${scenarioSet}". Set contains: ${setNames.join(", ")}`,
      );
    }
    return matched;
  }

  return enabledScenarios;
}

/**
 * List all scenarios in a config for display.
 */
function listScenarios(config) {
  if (config.scenarios.length === 0) {
    return "No scenarios defined.";
  }

  const lines = [];
  for (const s of config.scenarios) {
    const status = s.enabled ? "✓" : "✗";
    const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
    lines.push(`  ${status} ${s.name}${tags}`);
    if (s.description) {
      lines.push(`    ${s.description}`);
    }
  }

  if (Object.keys(config.scenarioSets).length > 0) {
    lines.push("");
    lines.push("Scenario sets:");
    for (const [name, scenarios] of Object.entries(config.scenarioSets)) {
      lines.push(`  ${name}: ${scenarios.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Remove excluded nodes from the graph.
 */
function applyExclusions(graph, exclude) {
  if (!exclude || exclude.length === 0) return graph;
  const excludeSet = new Set(exclude);
  return {
    nodes: graph.nodes.filter((n) => !excludeSet.has(n.id)),
    edges: graph.edges.filter(
      (e) => !excludeSet.has(e.source) && !excludeSet.has(e.target),
    ),
  };
}

module.exports = {
  loadConfig,
  applyExclusions,
  resolveSteps,
  getScenarios,
  listScenarios,
  VALID_MODES,
};

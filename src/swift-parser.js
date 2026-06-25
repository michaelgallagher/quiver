const fs = require("fs");
const path = require("path");
const { delegatedHelperBody } = require("./swift-nav-utils");

// Standard SwiftUI container/wrapper views that are not navigation destinations
const SWIFTUI_CONTAINERS = new Set([
  "NavigationStack",
  "NavigationView",
  "NavigationSplitView",
  "TabView",
  "ScrollView",
  "VStack",
  "HStack",
  "ZStack",
  "List",
  "ForEach",
  "Group",
  "Section",
  "LazyVStack",
  "LazyHStack",
  "LazyVGrid",
  "LazyHGrid",
  "GeometryReader",
  "Form",
  "AsyncImage",
  "DisclosureGroup",
  "OutlineGroup",
]);

// Views that are web content, not native navigation destinations
const WEB_VIEW_NAMES = new Set(["WebView", "SafariView", "CustomWebView", "WKWebView"]);

/**
 * Parse a Swift file and extract all navigation information.
 *
 * Returns null if the file contains no SwiftUI View struct.
 * Otherwise returns:
 * {
 *   viewName,         // "HomeView"
 *   relativePath,     // relative to project root
 *   navigationTitle,  // from .navigationTitle("...")
 *   pushLinks:        [{ target, label }]
 *   sheets:           [{ target }]
 *   fullScreenCovers: [{ target }]
 *   webLinks:         [{ url, label, mode }]  mode = webview|safari|custom-webview
 *   tabChildren:      [{ target, label }]
 *   navigationDestinations: [{ target, label }]
 * }
 */
// Strip Swift line comments and block comments from source.
// Preserves string literals so URLs and labels inside strings are not removed.
// Handles nested block comments (Swift allows them).
function stripSwiftComments(src) {
  let out = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    // String literal — pass through verbatim (don't strip comments inside strings)
    if (src[i] === '"') {
      out += src[i++];
      while (i < len) {
        if (src[i] === "\\") { out += src[i++]; out += src[i++]; continue; }
        if (src[i] === '"') { out += src[i++]; break; }
        out += src[i++];
      }
      continue;
    }
    // Line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    // Block comment (Swift allows nesting)
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    out += src[i++];
  }
  return out;
}

function parseSwiftFile(filePath, projectPath, urlBindings = null) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const content = stripSwiftComments(raw);
  const relativePath = path.relative(projectPath, filePath);

  // Must contain a SwiftUI View struct
  const structMatch = content.match(/\bstruct\s+(\w+)\s*:\s*(?:some\s+)?View\b/);
  if (!structMatch) return null;

  const viewName = structMatch[1];

  const result = {
    viewName,
    filePath,
    relativePath,
    navigationTitle: extractNavigationTitle(content),
    pushLinks: [],
    sheets: [],
    fullScreenCovers: [],
    webLinks: [],
    tabChildren: [],
    navigationDestinations: [],
  };

  extractPushLinks(content, result);
  extractSheets(content, result);
  extractFullScreenCovers(content, result);
  extractWebLinks(content, result, urlBindings);
  extractTabChildren(content, result);
  extractNavigationDestinations(content, result);

  return result;
}

/**
 * Two-pass Swift parsing entry point. Pass 1 harvests project-wide URL
 * bindings (currently `enum X: ..., WebFlowConfig` declarations whose `var
 * url: URL { switch self { ... } }` body resolves each case to a literal
 * URL). Pass 2 runs the existing per-file parser but threads the bindings
 * through so call sites that say `activeCover = .caseName` in a different
 * file can be resolved.
 *
 * Returns `parsed[]` in the same shape as a series of `parseSwiftFile`
 * calls — `null`-returning files (no `struct ... : View`) are filtered out.
 */
function parseSwiftProject(swiftFiles, projectPath) {
  const urlBindings = new Map();

  // Pass 1 — harvest enum-based WebFlowConfig URL bindings across the project.
  for (const filePath of swiftFiles) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const content = stripSwiftComments(raw);
    extractEnumWebFlowBindings(content, urlBindings);
  }

  // Pass 2 — parse each file with bindings available for indirection lookup.
  const parsed = [];
  for (const filePath of swiftFiles) {
    const view = parseSwiftFile(filePath, projectPath, urlBindings);
    if (view) parsed.push(view);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Closure extraction helpers
// ---------------------------------------------------------------------------

/**
 * Find the next `{` at or after `from` and return the brace-matched closure.
 * Returns { content, end } or null.
 */
function findNextClosure(source, from) {
  const bracePos = source.indexOf("{", from);
  if (bracePos === -1) return null;
  return extractClosureAt(source, bracePos);
}

/**
 * Extract the content of a Swift closure starting at `pos` (the `{`).
 * Returns { content: string, end: number } where end is the index of `}`.
 */
function extractClosureAt(source, pos) {
  let depth = 0;
  for (let i = pos; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return { content: source.slice(pos + 1, i), end: i };
      }
    }
  }
  return null;
}

/**
 * Find the matching `)` for a `(` at `pos`, handling nested parens and braces.
 * Returns the index of the closing `)`, or -1 if not found.
 */
function findMatchingParen(source, pos) {
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = pos; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) return i;
    } else if (source[i] === "{") braceDepth++;
    else if (source[i] === "}") braceDepth--;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// View name extraction
// ---------------------------------------------------------------------------

/**
 * Find the first SwiftUI view instantiation in a string that is
 * not a container/wrapper and not a web view type.
 */
function findFirstDestinationView(content) {
  const regex = /\b([A-Z][A-Za-z0-9]*(?:View|Page|Screen|Controller|Sheet))\s*\(/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    if (!SWIFTUI_CONTAINERS.has(name) && !WEB_VIEW_NAMES.has(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Find all distinct non-container, non-web view instantiations in a string.
 */
function findAllDestinationViews(content) {
  const regex = /\b([A-Z][A-Za-z0-9]*(?:View|Page|Screen|Controller|Sheet))\s*\(/g;
  const seen = new Set();
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    if (!SWIFTUI_CONTAINERS.has(name) && !WEB_VIEW_NAMES.has(name)) {
      seen.add(name);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function extractNavigationTitle(content) {
  const match = content.match(/\.navigationTitle\s*\(\s*"([^"]+)"\s*\)/);
  return match ? match[1] : null;
}

/**
 * Extract push navigation links from:
 *   RowLink(title: "...") { ViewName() }
 *   RowLink { ... } destination: { ViewName() }
 *   HubRowLink(hubType: .case) { ViewName() }
 *   NavigationLink { ViewName() } label: { ... }
 */
function extractPushLinks(content, result) {
  // RowLink with title: RowLink(title: "...") { ViewName() }
  const rowLinkTitleRe = /\bRowLink\s*\(\s*title\s*:\s*"([^"]+)"[^)]*\)/g;
  let match;
  while ((match = rowLinkTitleRe.exec(content)) !== null) {
    const label = match[1];
    const closure = findNextClosure(content, match.index + match[0].length);
    if (!closure) continue;
    const target = findFirstDestinationView(closure.content);
    if (target) result.pushLinks.push({ target, label });
  }

  // RowLink with custom label: RowLink { label } destination: { ViewName() }
  // Must start with RowLink immediately followed by { (no parentheses args)
  const rowLinkCustomRe = /\bRowLink\s*(?=\{)/g;
  while ((match = rowLinkCustomRe.exec(content)) !== null) {
    const labelClosure = findNextClosure(content, match.index + match[0].length);
    if (!labelClosure) continue;

    // Look for destination: { ... } right after the label closure
    const afterLabel = content.slice(labelClosure.end + 1, labelClosure.end + 300);
    const destKeyword = afterLabel.match(/\bdestination\s*:\s*\{/);
    if (!destKeyword) continue;

    const destBracePos = labelClosure.end + 1 + destKeyword.index + destKeyword[0].lastIndexOf("{");
    const destClosure = extractClosureAt(content, destBracePos);
    if (!destClosure) continue;

    const target = findFirstDestinationView(destClosure.content);
    if (!target) continue;

    // Try to extract a label from the first Text("...") in the label closure
    const textMatch = labelClosure.content.match(/\bText\s*\(\s*"([^"]+)"\s*\)/);
    const label = textMatch ? textMatch[1] : null;

    result.pushLinks.push({ target, label });
  }

  // RowLink(label: { ... }, destination: { ViewName() }) — parenthesised form
  const rowLinkParenRe = /\bRowLink\s*\(\s*label\s*:/g;
  while ((match = rowLinkParenRe.exec(content)) !== null) {
    const colonPos = content.indexOf(":", match.index + match[0].length - 1);
    const labelClosure = findNextClosure(content, colonPos + 1);
    if (!labelClosure) continue;

    const afterLabel = content.slice(labelClosure.end + 1, labelClosure.end + 300);
    const destKeyword = afterLabel.match(/\bdestination\s*:\s*\{/);
    if (!destKeyword) continue;

    const destBracePos = labelClosure.end + 1 + destKeyword.index + destKeyword[0].lastIndexOf("{");
    const destClosure = extractClosureAt(content, destBracePos);
    if (!destClosure) continue;

    const target = findFirstDestinationView(destClosure.content);
    if (!target) continue;

    const textMatch = labelClosure.content.match(/\bText\s*\(\s*"([^"]+)"\s*\)/);
    const label = textMatch ? textMatch[1] : null;

    result.pushLinks.push({ target, label });
  }

  // HubRowLink(hubType: .caseName) { ViewName() }
  const hubRowLinkRe = /\bHubRowLink\s*\(\s*hubType\s*:\s*\.(\w+)[^)]*\)/g;
  while ((match = hubRowLinkRe.exec(content)) !== null) {
    const hubCase = match[1];
    const closure = findNextClosure(content, match.index + match[0].length);
    if (!closure) continue;
    const target = findFirstDestinationView(closure.content);
    if (target) {
      // Convert camelCase enum name to sentence case: "testResults" → "Test results"
      const label = hubCase
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .replace(/^./, (c) => c.toUpperCase());
      result.pushLinks.push({ target, label });
    }
  }

  // NHSNavigationButton(title: "...", ...) { DestView() }
  // The destination view is in the trailing closure after the closing paren.
  const nhsNavBtnRe = /\bNHSNavigationButton\s*\(/g;
  while ((match = nhsNavBtnRe.exec(content)) !== null) {
    // Extract title from the parameters
    const paramStart = match.index + match[0].length - 1; // the '('
    const titleMatch = content.slice(paramStart).match(/title\s*:\s*"([^"]+)"/);
    const label = titleMatch ? titleMatch[1] : null;

    // Find the balanced closing ')' (handles nested closures like onTap: { ... })
    const closeParenIdx = findMatchingParen(content, paramStart);
    if (closeParenIdx === -1) continue;

    // The trailing closure is the next '{...}' after ')'
    const trailingClosure = findNextClosure(content, closeParenIdx + 1);
    if (!trailingClosure) continue;

    const target = findFirstDestinationView(trailingClosure.content);
    if (target) result.pushLinks.push({ target, label });
  }

  // NavigationLink { ViewName() } label: { ... }
  const navLinkRe = /\bNavigationLink\s*\{/g;
  while ((match = navLinkRe.exec(content)) !== null) {
    const destClosure = findNextClosure(content, match.index + match[0].length - 1);
    if (!destClosure) continue;
    const target = findFirstDestinationView(destClosure.content);
    if (!target) continue;

    // Try to find label in the label: { ... } trailing closure
    const afterDest = content.slice(destClosure.end + 1, destClosure.end + 400);
    const labelKeyword = afterDest.match(/\blabel\s*:\s*\{/);
    let label = null;
    if (labelKeyword) {
      const labelBracePos = destClosure.end + 1 + labelKeyword.index + labelKeyword[0].lastIndexOf("{");
      const labelClosure = extractClosureAt(content, labelBracePos);
      if (labelClosure) {
        const textMatch = labelClosure.content.match(/\bText\s*\(\s*"([^"]+)"\s*\)/);
        label = textMatch ? textMatch[1] : null;
      }
    }
    result.pushLinks.push({ target, label });
  }
}

/**
 * Return the button label that triggers a boolean state var (isPresented binding).
 * Searches for various button patterns that set stateVar = true or stateVar.toggle().
 * Handles: Button("Label"), NHSButton(title: "Label"), ButtonLink(title: "Label"),
 * and ButtonLink(action:) with Text("Label") inside trailing closure.
 */
function findTriggerLabel(content, stateVarName) {
  if (!stateVarName) return null;
  const escaped = stateVarName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Pattern 1: Button("Label") { stateVar = true }
  for (const action of [`${escaped}\\s*=\\s*true`, `${escaped}\\.toggle\\(\\)`]) {
    const re = new RegExp(
      `Button\\s*\\(\\s*"([^"]+)"[^)]*\\)[^{]*\\{[^}]*?\\b${action}`
    );
    const m = content.match(re);
    if (m) return m[1];
  }

  // Pattern 2: NHSButton(title: "Label", ..., action: { stateVar = true })
  // Also handles trailing closure: NHSButton(title: "Label", style: .x) { stateVar = true }
  for (const action of [`${escaped}\\s*=\\s*true`, `${escaped}\\.toggle\\(\\)`]) {
    // Inline action: parameter
    const re1 = new RegExp(
      `NHSButton\\s*\\([^)]*?title\\s*:\\s*"([^"]+)"[^)]*\\baction\\s*:\\s*\\{[^}]*?\\b${action}`
    );
    const m1 = content.match(re1);
    if (m1) return m1[1];
    // Trailing closure
    const re2 = new RegExp(
      `NHSButton\\s*\\([^)]*?title\\s*:\\s*"([^"]+)"[^)]*\\)\\s*\\{[^}]*?\\b${action}`
    );
    const m2 = content.match(re2);
    if (m2) return m2[1];
  }

  // Pattern 3: ButtonLink(title: "Label") { stateVar = true }
  for (const action of [`${escaped}\\s*=\\s*true`, `${escaped}\\.toggle\\(\\)`]) {
    const re = new RegExp(
      `ButtonLink\\s*\\(\\s*title\\s*:\\s*"([^"]+)"[^)]*\\)[^{]*\\{[^}]*?\\b${action}`
    );
    const m = content.match(re);
    if (m) return m[1];
  }

  // Pattern 4: ButtonLink(action: { stateVar = true }) { ... Text("Label") ... }
  // The label is in the trailing closure's Text().
  for (const action of [`${escaped}\\s*=\\s*true`, `${escaped}\\.toggle\\(\\)`]) {
    const re = new RegExp(
      `ButtonLink\\s*\\(\\s*action\\s*:\\s*\\{[^}]*?\\b${action}[^}]*\\}\\s*\\)`
    );
    const m = content.match(re);
    if (m) {
      const trailingClosure = findNextClosure(content, m.index + m[0].length);
      if (trailingClosure) {
        const textMatch = trailingClosure.content.match(/\bText\s*\(\s*"([^"]+)"\s*\)/);
        if (textMatch) return textMatch[1];
      }
    }
  }

  return null;
}

/**
 * Return the button label that sets an item binding to a specific enum case.
 * Searches for Button("Label") { itemVar = .caseName } patterns.
 */
function findItemTriggerLabel(content, itemVar, caseName) {
  if (!itemVar || !caseName) return null;
  const re = new RegExp(
    `Button\\s*\\(\\s*"([^"]+)"[^)]*\\)[^{]*\\{[^}]*\\b${itemVar}\\s*=\\s*\\.${caseName}`
  );
  const m = content.match(re);
  return m ? m[1] : null;
}

/**
 * Extract modal sheet presentations:
 *   .sheet(isPresented: $var) { ... }
 *   .sheet(item: $var) { item in ... }
 */
function extractSheets(content, result) {
  const sheetRe = /\.sheet\s*\(\s*(isPresented|item)\s*:\s*\$(\w+)[^)]*\)/g;
  let match;
  while ((match = sheetRe.exec(content)) !== null) {
    const isItem = match[1] === "item";
    const stateVar = match[2];
    const closure = findNextClosure(content, match.index + match[0].length);
    if (!closure) continue;
    extractPresentedContent(closure.content, result, "sheet", content, stateVar, isItem);
  }
}

/**
 * Extract full-screen cover presentations:
 *   .fullScreenCover(isPresented: $var) { ... }
 *   .fullScreenCover(item: $var) { item in ... }
 */
function extractFullScreenCovers(content, result) {
  const fscRe = /\.fullScreenCover\s*\(\s*(isPresented|item)\s*:\s*\$(\w+)[^)]*\)/g;
  let match;
  while ((match = fscRe.exec(content)) !== null) {
    const isItem = match[1] === "item";
    const stateVar = match[2];
    const closure = findNextClosure(content, match.index + match[0].length);
    if (!closure) continue;
    extractPresentedContent(closure.content, result, "full-screen", content, stateVar, isItem);
  }
}

/**
 * Shared logic for sheet / fullScreenCover closure content.
 * Checks for web views first, then looks for native destinations.
 */
function extractPresentedContent(closureContent, result, edgeType, fullContent, stateVar, isItem) {
  // WebView with a literal URL string
  const webViewMatch = closureContent.match(
    /\bWebView\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/
  );
  if (webViewMatch) {
    result.webLinks.push({ url: webViewMatch[1], label: null, mode: "webview" });
    return;
  }

  // CustomWebView / WKWebView with a literal URL
  const customMatch = closureContent.match(
    /\b(?:Custom)?W?K?WebView\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/
  );
  if (customMatch) {
    result.webLinks.push({ url: customMatch[1], label: null, mode: "custom-webview" });
    return;
  }

  // For switch-based items, extract (caseName, target) pairs with per-case trigger labels
  const hasSwitchCases = /\bcase\s+\./.test(closureContent);
  if (hasSwitchCases) {
    const caseRe = /\bcase\s+\.(\w+)\s*:\s*\n?\s*([A-Z][A-Za-z0-9]*(?:View|Page|Screen|Controller|Sheet))\s*\(/g;
    let caseMatch;
    const seen = new Set();
    while ((caseMatch = caseRe.exec(closureContent)) !== null) {
      const caseName = caseMatch[1];
      const target = caseMatch[2];
      if (seen.has(target)) continue;
      seen.add(target);
      const triggerLabel = isItem && fullContent
        ? findItemTriggerLabel(fullContent, stateVar, caseName)
        : null;
      if (edgeType === "sheet") result.sheets.push({ target, triggerLabel });
      else result.fullScreenCovers.push({ target, triggerLabel });
    }
    // Fallback if case pattern didn't match (e.g. multi-line cases)
    if (seen.size === 0) {
      const targets = findAllDestinationViews(closureContent);
      for (const target of targets) {
        if (edgeType === "sheet") result.sheets.push({ target, triggerLabel: null });
        else result.fullScreenCovers.push({ target, triggerLabel: null });
      }
    }
    return;
  }

  // Otherwise find the first non-container destination view
  const target = findFirstDestinationView(closureContent);
  if (target) {
    const triggerLabel = fullContent && !isItem
      ? findTriggerLabel(fullContent, stateVar)
      : null;
    if (edgeType === "sheet") result.sheets.push({ target, triggerLabel });
    else result.fullScreenCovers.push({ target, triggerLabel });
  }
}

/**
 * Extract web view / external link URLs:
 *   WebView(url: URL(string: "..."))
 *   activeCover = .webView(URL(string: "..."), userData)
 *   WebLink(url: URL(string: "..."))  [with nearby Button label]
 *   UIApplication.shared.open(URL(string: "..."))
 *
 * Also resolves file-local URL constants like
 *   private static let startURL = URL(string: "https://...")!
 * when referenced via `Self.startURL` or bare `startURL` in a `.webView(...)`
 * enum cover — common pattern for web-flow start URLs.
 */
function extractWebLinks(content, result, urlBindings = null) {
  // Build a map of file-local URL constants for indirection resolution.
  //   let foo = URL(string: "https://...")!
  //   static let bar = URL(string: "...")
  //   private static let baz = URL(string: "...")
  const urlConstants = new Map();
  const urlConstRe =
    /\b(?:(?:public|private|internal|fileprivate)\s+)?(?:static\s+)?let\s+(\w+)\s*(?::\s*URL\s*)?=\s*URL\s*\(\s*string\s*:\s*"(https?:\/\/[^"]+)"\s*\)!?/g;
  let constMatch;
  while ((constMatch = urlConstRe.exec(content)) !== null) {
    urlConstants.set(constMatch[1], constMatch[2]);
  }

  // Standalone WebView(url: URL(string: "..."))
  const webViewRe = /\bWebView\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/g;
  let match;
  while ((match = webViewRe.exec(content)) !== null) {
    if (!result.webLinks.some((l) => l.url === match[1])) {
      result.webLinks.push({ url: match[1], label: null, mode: "webview" });
    }
  }

  // .webView(URL(string: "..."), ...) — enum-based webview cover (literal URL)
  const covWebViewRe = /\.webView\s*\(\s*URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/g;
  while ((match = covWebViewRe.exec(content)) !== null) {
    if (!result.webLinks.some((l) => l.url === match[1])) {
      result.webLinks.push({ url: match[1], label: null, mode: "custom-webview" });
    }
  }

  // .webView(Self.foo, ...) or .webView(foo, ...) — resolve via urlConstants map
  const covRefRe = /\.webView\s*\(\s*(?:Self\.)?(\w+)\b/g;
  while ((match = covRefRe.exec(content)) !== null) {
    const url = urlConstants.get(match[1]);
    if (!url) continue;
    if (!result.webLinks.some((l) => l.url === url)) {
      result.webLinks.push({ url, label: null, mode: "custom-webview" });
    }
  }

  // WebLink(url: URL(string: "...")) — look back for a Button("...") label
  const webLinkRe = /\bWebLink\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"([^"]+)"\s*\)/g;
  while ((match = webLinkRe.exec(content)) !== null) {
    const url = match[1];
    if (result.webLinks.some((l) => l.url === url)) continue;

    // Look backwards up to 500 chars for a Button("...") call
    const preceding = content.slice(Math.max(0, match.index - 500), match.index);
    const btnMatch = preceding.match(/Button\s*\(\s*"([^"]+)"\s*\)[^{]*\{[^}]*$/);
    const label = btnMatch ? btnMatch[1] : null;

    result.webLinks.push({ url, label, mode: "safari" });
  }

  // UIApplication.shared.open(URL(string: "...")) — full handoff to native Safari.
  // Skips non-http schemes (tel:, mailto:, etc.) and dynamically-built URLs.
  const sharedOpenRe =
    /UIApplication\.shared\.open\s*\(\s*(?:url\s*:\s*)?URL\s*\(\s*string\s*:\s*"(https?:\/\/[^"]+)"\s*\)/g;
  while ((match = sharedOpenRe.exec(content)) !== null) {
    if (!result.webLinks.some((l) => l.url === match[1])) {
      result.webLinks.push({ url: match[1], label: null, mode: "safari" });
    }
  }

  // Resolve `activeCover = .caseName` (or any state-var assignment to a bare
  // enum case) against the project-wide WebFlowConfig bindings harvested by
  // `extractEnumWebFlowBindings`. The enum body lives in a different file
  // (e.g. PrescriptionFlow.swift) from the call site (PrescriptionsView.swift),
  // so this is the iOS analogue of the Kotlin `activeWebFlow = X.Y` resolution.
  if (urlBindings && urlBindings.size > 0) {
    // First, build a state-var → enum-type map from declarations in this file:
    //   @State private var activeCover: PrescriptionFlow? = nil
    //   @State var foo: SomeEnum?
    //   private var bar: SomeEnum? = nil
    // Captures the optional enum type so we can prefer qualified lookups.
    const stateVarTypes = new Map();
    const stateVarRe =
      /(?:@State\s+)?(?:public\s+|private\s+|internal\s+|fileprivate\s+)?(?:var|let)\s+(\w+)\s*:\s*([A-Z]\w*)\?\s*(?:=|$)/gm;
    let svMatch;
    while ((svMatch = stateVarRe.exec(content)) !== null) {
      stateVarTypes.set(svMatch[1], svMatch[2]);
    }

    // Then find every `IDENT = .caseName` assignment. The LHS can be a state
    // var declared above or an arbitrary identifier (binding form) — we try
    // qualified lookup first when we know the type, otherwise fall back to
    // the bare case name.
    const assignRe = /\b(\w+)\s*=\s*\.(\w+)\b/g;
    const seenRefs = new Set();
    let amatch;
    while ((amatch = assignRe.exec(content)) !== null) {
      const lhs = amatch[1];
      const caseName = amatch[2];
      const refKey = `${lhs}.${caseName}`;
      if (seenRefs.has(refKey)) continue;
      seenRefs.add(refKey);

      const enumType = stateVarTypes.get(lhs);
      const binding =
        (enumType && urlBindings.get(`${enumType}.${caseName}`)) ||
        urlBindings.get(caseName);
      if (!binding) continue;

      if (result.webLinks.some((l) => l.url === binding.url)) continue;
      result.webLinks.push({
        url: binding.url,
        label: binding.label || null,
        mode: "custom-webview",
      });
    }
  }
}

/**
 * Harvest WebFlowConfig-style URL bindings from a single file.
 *
 * Detects the iOS pattern:
 *
 *   enum PrescriptionFlow: String, WebFlowConfig {
 *       case repeatPrescription
 *       case chosenPharmacy
 *
 *       var url: URL {
 *           switch self {
 *           case .repeatPrescription:
 *               URL(string: "https://...")!        // implicit return (Swift 5.9+)
 *           case .chosenPharmacy:
 *               URL(string: "https://...")!
 *           }
 *       }
 *
 *       var title: String {
 *           switch self {
 *           case .repeatPrescription: return "..."  // explicit return
 *           case .chosenPharmacy:     return "..."
 *           }
 *       }
 *   }
 *
 * Builds bindings keyed on both bare and enum-qualified case names so that
 * downstream lookup at call sites (`activeCover = .repeatPrescription`)
 * resolves to `{ url, label }`.
 *
 * Skips:
 *   - Enums that don't conform to `WebFlowConfig` (keeps noise low — this
 *     is the project-wide convention for declaring static web flows).
 *   - Enums whose `url:` body uses runtime-built URLs (e.g. `URL(string:
 *     someProperty)`) — cannot be statically resolved.
 *   - The `struct X: WebFlowConfig` form (e.g. `MessageWebFlow`) where the
 *     URL is a stored property bound at runtime from the constructor.
 *
 * Both the bare key (`repeatPrescription`) and the qualified key
 * (`PrescriptionFlow.repeatPrescription`) are written. When two enums share
 * a case name, the qualified key disambiguates and the bare-key writer
 * skips if the bare key is already claimed (matches the Kotlin policy).
 */
function extractEnumWebFlowBindings(content, bindings) {
  // Find every enum declared as conforming to WebFlowConfig. The `:` clause
  // can include other conformances (e.g. `String, Identifiable, WebFlowConfig`)
  // — match anywhere in the inheritance list.
  const enumRe = /\benum\s+(\w+)\s*:\s*([^{]+?)\{/g;
  let enumMatch;
  while ((enumMatch = enumRe.exec(content)) !== null) {
    const enumName = enumMatch[1];
    const inheritance = enumMatch[2];
    if (!/\bWebFlowConfig\b/.test(inheritance)) continue;

    const enumBraceIdx = content.indexOf("{", enumMatch.index);
    if (enumBraceIdx === -1) continue;
    const enumBody = extractClosureAt(content, enumBraceIdx);
    if (!enumBody) continue;

    // Find `var url: URL { ... }` inside the enum body. Allow `static`,
    // `nonisolated`, access modifiers, and an optional body type annotation.
    const urlVarRe =
      /\b(?:nonisolated\s+|static\s+|public\s+|private\s+|internal\s+|fileprivate\s+)*var\s+url\s*:\s*URL\s*\{/g;
    const urlVarMatch = urlVarRe.exec(enumBody.content);
    if (!urlVarMatch) continue;

    const urlBlockBrace =
      enumBody.content.indexOf("{", urlVarMatch.index + urlVarMatch[0].length - 1);
    if (urlBlockBrace === -1) continue;
    const urlBlock = extractClosureAt(enumBody.content, urlBlockBrace);
    if (!urlBlock) continue;

    // Optional `var title: String { ... }` for labels — same modifier prefix.
    const titleVarRe =
      /\b(?:nonisolated\s+|static\s+|public\s+|private\s+|internal\s+|fileprivate\s+)*var\s+title\s*:\s*String\s*\{/g;
    const titleVarMatch = titleVarRe.exec(enumBody.content);
    let titleByCase = new Map();
    if (titleVarMatch) {
      const titleBlockBrace =
        enumBody.content.indexOf("{", titleVarMatch.index + titleVarMatch[0].length - 1);
      if (titleBlockBrace !== -1) {
        const titleBlock = extractClosureAt(enumBody.content, titleBlockBrace);
        if (titleBlock) titleByCase = extractTitleCases(titleBlock.content);
      }
    }

    // Walk `case .NAME:` … URL extractors inside the url block. The body
    // between two case labels (or between the last case and the end of the
    // switch) holds the URL expression.
    const caseRe = /\bcase\s+\.(\w+)\s*:/g;
    const caseStarts = [];
    let cmatch;
    while ((cmatch = caseRe.exec(urlBlock.content)) !== null) {
      caseStarts.push({ name: cmatch[1], start: cmatch.index + cmatch[0].length });
    }
    for (let i = 0; i < caseStarts.length; i++) {
      const cs = caseStarts[i];
      const next = caseStarts[i + 1];
      const segment = urlBlock.content.slice(cs.start, next ? next.start - "case ".length : urlBlock.content.length);
      // Match the first URL(string: "...") in this case's segment. Tolerates
      // `return`, leading whitespace, a force-unwrap `!`, and parens around
      // the constructor.
      const urlMatch = /URL\s*\(\s*string\s*:\s*"(https?:\/\/[^"]+)"\s*\)/.exec(segment);
      if (!urlMatch) continue;
      const url = urlMatch[1];
      const label = titleByCase.get(cs.name) || null;
      const entry = { url, label };

      // Always write the qualified form; only write the bare form if not
      // already claimed (preserves disambiguation if a later enum has the
      // same case name).
      bindings.set(`${enumName}.${cs.name}`, entry);
      if (!bindings.has(cs.name)) bindings.set(cs.name, entry);
    }
  }
}

/**
 * Walk a `var title: String { switch self { case .X: return "..." } }` body
 * and return a `Map<caseName, label>`. Both implicit and explicit `return`
 * forms are accepted.
 */
function extractTitleCases(body) {
  const out = new Map();
  // Match `case .NAME: <maybe return> "literal"` — single-case-per-line.
  const re = /\bcase\s+\.(\w+)\s*:\s*(?:return\s+)?"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Extract TabView children:
 *   TabView { ViewName().tag(n).tabItem { Label("...") } }
 */
function extractTabChildren(content, result) {
  // Find TabView (with or without selection parameter)
  const tabViewMatch = content.match(/\bTabView\s*(?:\([^)]*\))?\s*\{/);
  if (!tabViewMatch) return;

  const closure = findNextClosure(content, tabViewMatch.index + tabViewMatch[0].length - 1);
  if (!closure) return;

  const tabContent = closure.content;

  // Find each .tabItem { ... Label("name", ...) } and the view preceding it
  const tabItemRe = /\.tabItem\s*\{/g;
  let tiMatch;
  while ((tiMatch = tabItemRe.exec(tabContent)) !== null) {
    const tiClosure = findNextClosure(tabContent, tiMatch.index + tiMatch[0].length - 1);
    if (!tiClosure) continue;

    // Find Label("...") or Text("...") inside the tabItem closure
    const labelMatch = tiClosure.content.match(/\b(?:Label|Text)\s*\(\s*"([^"]+)"/);
    if (!labelMatch) continue;
    const label = labelMatch[1];

    // Look backwards in the tabContent before this .tabItem for the most recent view
    const preceding = tabContent.slice(0, tiMatch.index);
    const viewRe = /\b([A-Z][A-Za-z0-9]*(?:View|Page|Screen))\s*\(/g;
    let lastView = null;
    let viewMatch;
    while ((viewMatch = viewRe.exec(preceding)) !== null) {
      if (!SWIFTUI_CONTAINERS.has(viewMatch[1]) && !WEB_VIEW_NAMES.has(viewMatch[1])) {
        lastView = viewMatch[1];
      }
    }

    if (lastView) result.tabChildren.push({ target: lastView, label });
  }
}

/**
 * Extract navigationDestination(for: Type.self) switch case → view mappings.
 * These represent typed programmatic navigation destinations.
 */
function extractNavigationDestinations(content, result) {
  const navDestRe = /\.navigationDestination\s*\(\s*for\s*:/g;
  let match;
  while ((match = navDestRe.exec(content)) !== null) {
    const closure = findNextClosure(content, match.index + match[0].length);
    if (!closure) continue;

    // Parse switch case .enumCase: ViewName() pairs from the closure itself.
    const found = collectNavDestCases(closure.content, result);

    // Indirection: the closure may delegate to a helper rather than switching
    // inline, e.g. `{ d in destinationView(for: d) }` with the switch living in
    // `func destinationView(for:) -> some View`. Follow it, otherwise the
    // destinations vanish — their views get no incoming edge and surface as
    // spurious zero-in-degree "start" columns in the map.
    if (found === 0) {
      const helperBody = delegatedHelperBody(closure.content, content);
      if (helperBody) collectNavDestCases(helperBody, result);
    }
  }
}

/**
 * Push `case .enumCase: ViewName()` pairs from a switch body into
 * result.navigationDestinations. Returns the number of pairs found.
 */
function collectNavDestCases(switchBody, result) {
  const caseRe = /\bcase\s+\.(\w+)\s*:\s*\n?\s*([A-Z][A-Za-z0-9]*(?:View|Page|Screen))\s*\(/g;
  let caseMatch;
  let count = 0;
  while ((caseMatch = caseRe.exec(switchBody)) !== null) {
    result.navigationDestinations.push({
      target: caseMatch[2],
      label: caseMatch[1], // enum case name as label
    });
    count++;
  }
  return count;
}

/**
 * Convert a PascalCase view name to a human-readable label.
 * "BookAppointmentView" → "Book Appointment"
 * "PatchsStartPage" → "Patchs Start"
 */
function toLabel(viewName) {
  return viewName
    .replace(/(?:View|Page|Screen|Controller)$/, "")
    .replace(/([A-Z])/g, " $1")
    .trim();
}

module.exports = { parseSwiftFile, parseSwiftProject, toLabel };

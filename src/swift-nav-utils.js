/**
 * Shared helpers for understanding SwiftUI navigationDestination dispatch.
 *
 * Used by both the static parser (swift-parser.js, which builds graph edges)
 * and the launch-args injector (swift-injector.js, which builds the capture
 * route plan). Keeping the indirection logic here keeps the two in sync: if a
 * prototype delegates its case→view switch out of the navigationDestination
 * closure, both the graph and the route plan must follow it the same way.
 */

/**
 * Return the substring between the first `{` at/after fromIndex and its matching
 * `}` (braces excluded), or null if no balanced pair is found.
 */
function braceMatchedBody(content, fromIndex) {
  let pos = fromIndex;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return null;
  let depth = 0;
  for (let end = pos; end < content.length; end++) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) return content.slice(pos + 1, end);
    }
  }
  return null;
}

/**
 * When a navigationDestination closure delegates to a helper function rather
 * than switching inline — e.g.
 *   .navigationDestination(for: Foo.self) { d in destinationView(for: d) }
 *   @ViewBuilder func destinationView(for d: Foo) -> some View { switch d { … } }
 * — return that helper's body so the caller can parse its case→view switch.
 *
 * @param {string} closureBody  - the navigationDestination closure's body text
 * @param {string} fullContent  - the full file content the helper lives in
 * @returns {string|null} the helper function body, or null if there is no such
 *   delegating call or the function can't be found.
 */
function delegatedHelperBody(closureBody, fullContent) {
  // First function-call identifier in the closure (the `param in` header has no `(`).
  const callMatch = closureBody.match(/\b([a-zA-Z_]\w*)\s*\(/);
  if (!callMatch) return null;
  const funcName = callMatch[1];

  const fnStart = fullContent.search(new RegExp(`\\bfunc\\s+${funcName}\\s*\\(`));
  if (fnStart === -1) return null;
  return braceMatchedBody(fullContent, fnStart);
}

module.exports = { braceMatchedBody, delegatedHelperBody };

# Recording scenarios

The recorder lets you create flow maps by clicking through your prototype in a real browser. It captures screenshots and links in real-time as you navigate, and builds the map immediately when you finish. It also saves a `.flow` script as a secondary output, which you can edit and replay later.

## Quick start

```bash
npx quiver --record /path/to/prototype
```

This opens a browser with your prototype and a coloured toolbar at the top. Click through your prototype naturally -- every interaction is captured.

## How it works

1. The prototype server starts and a browser window opens
2. You click through your prototype while the recorder tracks your actions
3. Steps are printed to the terminal in real-time
4. During the Map phase, screenshots and page links are captured automatically on each navigation
5. When you finish, the tool builds the flow map viewer directly from the captured data
6. A `.flow` script is also saved to `scenarios/` for future replay or editing

## The toolbar

A coloured bar appears at the top of every page:

- **Phase indicator** -- shows "SETUP" (orange) or "MAP" (green)
- **Step counter** -- how many steps have been recorded so far
- **Begin mapping** -- transitions from Setup to Map phase (disappears after clicking)
- **Capture page** -- forces a `Snapshot` step and capture for the current page
- **Finish** -- ends recording, builds the map, and saves the `.flow` file

## Phases

### Setup phase (orange)

Everything you do before clicking "Begin mapping" becomes a Setup step. Use this for:
- Selecting a user (e.g. clicking a user link on `/choose-user`)
- Authenticating or setting session state
- Navigating to the starting point for your journey

Navigations in setup become `Goto` steps. Setup steps are not included in the map output.

### Map phase (green)

After clicking "Begin mapping", page navigations automatically trigger screenshot captures and `Visit` steps. The map is built from the pages you visit and the links between them.

- Each unique page is captured once (revisiting a page does not create a duplicate)
- Links on each page are extracted and used to build edges in the map
- Tab siblings (pages that link to each other) are arranged side-by-side in the layout

## What gets captured

| Interaction | Step type |
|---|---|
| Click a link | `ClickLink "text"` — also matches `<a role="button">` (or `Click` with selector if no accessible name) |
| Click a button | `ClickButton "text"` — also matches `<a role="button">` (or `Click` with selector) |
| Select a radio button | `Choose "label"` |
| Tick a checkbox | `Check "label"` |
| Fill in a text field | `FillIn "label" with "value"` (or `Fill` with selector) |
| Select from a dropdown | `Select "option" from "label"` (or `Select` with selector) |
| Click "Capture page" | `Snapshot` |
| Navigate to a new page | `Goto` (setup) or `Visit` (map) |

The recorder prefers label-based steps over CSS selectors. Labels make scenarios more readable and resilient to markup changes.

## Options

```bash
# Custom filename for the .flow script
npx quiver --record my-journey /path/to/prototype

# Desktop viewport
npx quiver --record --desktop /path/to/prototype

# Custom prototype-kit port
npx quiver --record --prototype-port 5000 /path/to/prototype

# Named map with title
npx quiver --record --name screening-clinics --title "Clinic workflow" /path/to/prototype

# Skip opening the viewer in a browser
npx quiver --record --no-open /path/to/prototype
```

The default script filename is `recorded.flow`. If the file already exists, a numeric suffix is added (`recorded-2.flow`, `recorded-3.flow`, etc.).

## Output

The recorder produces two things:

1. **Flow map viewer** -- an interactive HTML map at `quiver-output/maps/<name>/index.html`, identical to what you'd get from running a scenario. This is the primary output.
2. **`.flow` script** -- saved to `<prototype>/scenarios/<filename>.flow`. This is a secondary output that you can edit and replay.

## Tips

- **Plan your journey first.** Know which pages you want to map before you start recording. The map is built from exactly what you visit.
- **Use Setup for login.** Click through user selection or authentication before hitting "Begin mapping".
- **Don't revisit pages unnecessarily.** Each unique page is only captured once, but unnecessary navigation adds noise to the `.flow` script.
- **Close the browser to finish.** If you forget to click "Finish", closing the browser window also ends the recording and saves everything.
- **Edit the `.flow` file afterward.** The generated script is plain text. You can reorder steps, remove duplicates, add `Wait` steps, or insert `Use` fragments for shared setup sequences.

## Replaying recorded scripts

The `.flow` script can be replayed as a regular scenario:

```bash
npx quiver --scenario recorded /path/to/prototype
```

The recorder automatically converts `Visit` steps with session-specific URLs (containing dynamic IDs) into `Snapshot` steps in the saved script. This makes replay more robust -- instead of navigating to a URL that may not exist in a different session, the scenario runner captures whatever page the browser is currently on.

For best replay results, review the generated `.flow` file and:
- Replace any remaining hardcoded dynamic URLs with `Click` + `Snapshot` pairs
- Add `Wait` steps if your prototype has timed transitions
- Extract common setup steps into fragments (see [writing scenarios](scenarios.md#fragments))

## Recorder vs hand-written scenarios

| | Recorder | Hand-written `.flow` |
|---|---|---|
| **Speed** | Fast -- just click through your prototype | Slower -- requires knowing the `.flow` syntax |
| **Map quality** | Good -- captures exactly what you visit | Best -- full control over layout and structure |
| **Replay** | May need editing for dynamic URLs | Fully deterministic if written carefully |
| **Best for** | Quick maps, exploring, non-technical users | Repeatable CI maps, complex multi-scenario sets |

The recorder is a good starting point. Record a journey, review the `.flow` output, then refine it by hand for long-term use.

## Known limitations

- **No undo.** If you make a mistake during recording, finish and edit the `.flow` file afterward. There is no way to undo individual steps during a session.
- **No `Wait` steps.** The recorder does not detect pauses or auto-insert `Wait` steps. Add them manually to the `.flow` file if your prototype has timed transitions or animations.
- **Dynamic URLs in replay.** Pages with session-generated IDs (e.g. `/events/abc123/details`) are automatically converted to `Snapshot` steps in the saved script, but some may still need manual adjustment for reliable replay.
- **Back button navigations.** Pressing back generates a `Visit` to the previous page. This is correct for the map but may produce redundant entries in the `.flow` script.
- **Tab layout heuristics.** Tab siblings are detected by mutual cross-links between pages. If tabs don't link to each other in the DOM (e.g. tabs implemented via JavaScript), they may not be grouped side-by-side in the layout.
- **BrowserSync interference.** The tool disables BrowserSync by default (via the `PROXY` environment variable) and automatically removes BrowserSync's notification bar from screenshots. If your prototype kit doesn't respect the `PROXY` variable, BrowserSync may still run but its UI will be cleaned from captured images.
- **One browser context.** The recorder uses a single browser context, so session state carries across page navigations. This is usually what you want, but means you can't record isolated scenarios back-to-back without restarting.

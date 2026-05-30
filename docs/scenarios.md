# Writing scenarios

Scenarios define realistic user journeys through your prototype. Instead of visiting every technically reachable URL, scenario mode maps what users actually experience -- pages that are valid in context, with the right session state and seed data.

> **Tip:** You can generate `.flow` files automatically using the [recorder](recording.md) instead of writing them by hand. Run `npx quiver --record /path/to/prototype` to click through your prototype in a browser and produce a `.flow` script. You can then edit the generated file to refine it.

## Directory layout

Everything lives in a `scenarios/` directory in your prototype root, for instance:

```
my-prototype/
  scenarios/
    fragments/
      setup.clinician.flow     # reusable login/setup steps
      setup.admin.flow
    clinic-workflow.flow        # scenario definitions
    check-in-workflow.flow
    reading-workflow.flow
    core-user-journeys.set      # scenario set definitions
    clinic-full.set
```

Note: these scenario files live alongside your prototype code, so they can be version-controlled together and easily updated as your prototype evolves. They don't need to be included in the map output — the tool only extracts the relevant pages and connections.

## `.flow` file format

Each `.flow` file defines one scenario. The filename becomes the scenario name (e.g. `clinic-workflow.flow` → scenario `clinic-workflow`).

A `.flow` file has three sections:

1. **Header** — metadata directives (start URL, scope, tags, limits)
2. **Setup** — steps that establish context (login, select user). Not included in the map.
3. **Map** — steps that contribute to the mapped journey.

### Example

```
# Reception/clinic operational flow
# Appointments, events, check-in

Start /clinics
Scope /dashboard /clinics /events /reports
Exclude /prototype-admin /api /assets /settings /participants
Tags clinic appointment core
Limit pages 120
Limit depth 12

--- Setup ---

Use setup.clinician

--- Map ---

# Dashboard
Visit /dashboard

# Clinic tabs
Visit /clinics/today
Visit /clinics/upcoming
Visit /clinics/completed
Visit /clinics/all

# Navigate into an event dynamically
Goto /clinics/abcd1234/all
Click "a:has-text('View appointment')"
Snapshot

# Event detail tabs
Click "a[href*='/participant']"
Snapshot
Click "a[href*='/medical-information']"
Snapshot
```

For more detailed examples, you can check out the examples in `docs/example-scenarios/`.

### Header directives

| Directive | Example | Description |
|---|---|---|
| `Start` | `Start /clinics` | Start URL for the scenario |
| `Scope` | `Scope /dashboard /clinics` | Only follow links matching these path prefixes |
| `Exclude` | `Exclude /api /assets` | Never follow links matching these prefixes |
| `Tags` | `Tags clinic core` | Grouping labels |
| `Limit pages` | `Limit pages 120` | Maximum pages to visit |
| `Limit depth` | `Limit depth 12` | Maximum link depth |
| `Disabled` | `Disabled` | Skip this scenario when running all scenarios |

### Step types

**Label-based (preferred)** — find elements the way a user would, by visible text or label:

| Step | Example | Description |
|---|---|---|
| `ClickLink` | `ClickLink "View appointment"` | Click a link by its visible text (also matches `<a role="button">`) |
| `ClickButton` | `ClickButton "Continue"` | Click a button by its visible text (also matches `<a role="button">`) |
| `FillIn` | `FillIn "First name" with "Frankie"` | Fill a field by its label |
| `Select … from` | `Select "Email" from "Contact preference"` | Select a dropdown option by label |
| `Check` | `Check "Right shoulder"` | Check a checkbox by its label |
| `Choose` | `Choose "At an NHS hospital"` | Select a radio button by its label |

**CSS-selector (escape hatch)** — use when labels are ambiguous or elements lack accessible names:

| Step | Example | Description |
|---|---|---|
| `Click` | `Click "a:has-text('View')"` | Click an element by CSS selector |
| `Fill` | `Fill "#search" "HITCHIN"` | Fill an input by CSS selector |
| `Select` | `Select "#dropdown" "Option"` | Select an option by CSS selector (no `from` keyword) |
| `Check` | `Check "#myCheckbox"` | Check a checkbox by CSS selector (detected by `#`, `.`, `[`, etc.) |
| `Submit` | `Submit "form"` | Submit a form by selector |

**Navigation and control:**

| Step | Example | Description |
|---|---|---|
| `Goto` | `Goto /choose-user` | Navigate directly to a URL |
| `Visit` | `Visit /clinics/today` | Visit a page and add it to the map |
| `Snapshot` | `Snapshot` | Capture the current page as a map node |
| `WaitForUrl` | `WaitForUrl /dashboard` | Wait for navigation to a URL |
| `WaitForSelector` | `WaitForSelector "text=Done"` | Wait until a selector appears |
| `Wait` | `Wait 1000` | Wait a number of milliseconds |
| `Use` | `Use setup.clinician` | Include a reusable fragment |

Values containing spaces or special characters should be quoted: `Click "a:has-text('View')"`. Simple values don't need quotes: `Visit /dashboard`.

## Fragments

Fragments are reusable step sequences shared across scenarios. Place them in `scenarios/fragments/` — the filename becomes the fragment name:

```
# scenarios/fragments/setup.clinician.flow

# Log in as a clinician user

Goto /choose-user
Click "a[href*='ae7537b3']"
WaitForUrl /dashboard
```

Reference from any scenario with `Use`:

```
--- Setup ---

Use setup.clinician
```

## Scenario sets

Group scenarios together in `.set` files — one scenario name per line:

```
# scenarios/core-user-journeys.set

# All core user journey scenarios
login-and-dashboard
clinic-workflow
check-in-workflow
participant-management
reading-workflow
reporting
```

The order in the `.set` file determines the order in the merged map — the first scenario's flow appears directly below shared nodes.

## Visit-driven vs BFS crawl

Within a scenario, the mapping approach is chosen automatically:

- **Visit-driven** (steps include `visit` or `snapshot`): You specify exactly which pages to map. Edges are built from the actual DOM links between visited pages.
- **BFS crawl** (no `visit` or `snapshot` steps): The tool crawls from `startUrl`, following every in-scope link.

Visit-driven is recommended for prototypes with complex routing, tabs, or session-dependent pages.

## Snapshot steps

For pages that depend on session state (e.g. a batch reading page created by clicking "Start session"), use `Click` to trigger navigation, then `Snapshot` to capture whatever page the browser landed on:

```
Click "a[href*='/create-batch']"
Snapshot

Click "button:has-text('Normal')"
Wait 1000
Snapshot
```

Sequential navigation edges are automatically created between consecutive snapshot pages, even through server-side redirects.

## Combined scenario maps

When you run multiple scenarios together (via `--scenario-set`), the tool produces:
- Individual maps for each scenario
- A combined map with shared nodes (e.g. `/dashboard` appears once, connecting to both flows)

Shared nodes keep their position from the first scenario that contains them (preserving tab groups and other layout relationships). Each subsequent scenario's pages are stacked below in the order specified by the `.set` file.

## YAML config (optional)

A `quiver.config.yml` file is only needed to override runtime mapping defaults (canonicalization rules, filters) or define scenarios inline in YAML. The `.flow` and `.set` files are sufficient for most prototypes.

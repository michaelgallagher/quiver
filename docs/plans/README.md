# Plans

Forward-looking docs for quiver. Reference docs (how the tool works today, CLI flags, platform support) live one level up at [`docs/`](../).

## What's where

| File | What it is |
|---|---|
| [`roadmap.md`](roadmap.md) | Active workstreams with full implementation detail. Each workstream is self-contained — pick one up without reading the others. |
| [`future-ideas.md`](future-ideas.md) | Deferred items: things we'd like to do but haven't scheduled. Each entry has enough context to be promoted to the roadmap when the time comes. |
| [`design-decisions.md`](design-decisions.md) | The "why" behind major architectural choices. Useful when picking up the codebase cold or evaluating whether to revisit a decision. |
| [`experiments/`](experiments/) | Long-running investigations that don't yet have enough certainty to commit to. Each experiment is self-contained with a status banner, what's been validated, what's blocked, and concrete next steps for resumption. Graduates to `roadmap.md` once validated, or moves to `archive/` if formally rejected. |
| [`archive/`](archive/) | Completed plans, kept for historical context. Each archived doc has a status banner explaining what was delivered and pointing to current reference docs. |

## Working with these docs

**To start a new workstream**: read [`roadmap.md`](roadmap.md), pick a workstream, follow its "Files to change" and "Implementation details" sections. The verification steps tell you when it's done.

**To add a new idea**: drop it in [`future-ideas.md`](future-ideas.md) with enough context that it's actionable when promoted. If it's actively being worked on, it should be in `roadmap.md` instead.

**To make an architectural decision**: log it in [`design-decisions.md`](design-decisions.md) with what was considered and why we picked the chosen path. If a decision is later overturned, move the entry to `archive/` rather than deleting it.

**To complete a workstream**: move the implementation detail from `roadmap.md` to a new `archive/<workstream>.md` with a "delivered" status banner. Update `roadmap.md` to remove the section. Add any follow-up items to `future-ideas.md`.

**To start an experiment**: add a doc to `experiments/<name>.md` with a "Status: experiment in progress" banner, the hypothesis being tested, what's been validated, what's blocked, and concrete next steps for resumption. The doc should be self-contained — a fresh contributor (human or AI) should be able to pick it up without prior session context. Graduates to `roadmap.md` once validated; moves to `archive/` if rejected.

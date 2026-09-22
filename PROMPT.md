# Prompt: Build a "Shift Coverage Solver" web app

Paste everything below into OpenCode (or any coding agent) as the task prompt.

---

Build a single-page web app that solves a weekly shift-scheduling problem by
exhaustive search and runs **entirely client-side** in a browser, with no
build step and no server. The point of this app is trust: a team needs to be
able to open it themselves, see exactly what preferences went in, press a
button, and watch a real (not simulated) computation produce the schedule —
so the same inputs must always produce the same output, and nothing about the
result may be hardcoded or precomputed by me.

## Tech constraints

- Plain HTML + CSS + JS. No framework, no bundler, no npm build step. The app
  must work by just opening `index.html` in a browser (`file://` is fine).
- You may use **exactly one** third-party, dependency-free JS library if it
  earns its place. Vendor it as a local file (don't rely on a CDN at runtime)
  so the app works fully offline. Use it for drag-to-reorder preference
  ranking (e.g. SortableJS) — a good fit here.
- Split into `index.html`, `style.css`, `app.js` (UI/DOM), and `scheduler.js`
  (the algorithm, **zero DOM dependencies** — it must run unchanged under
  plain Node for testing as well as in the browser). Use a small
  `module.exports` guard so the same file works in both:
  ```js
  if (typeof module !== 'undefined' && module.exports) module.exports = Scheduler;
  else root.Scheduler = Scheduler;
  ```
- Also produce `verify.js`, a Node script with **no DOM dependency** that
  loads the default dataset (below), runs the solver, and asserts the hard
  coverage constraint actually holds across all 168 hours of the week —
  so someone can double-check the result outside the browser entirely.

## The scheduling problem

- 8 people, 8 shift "slots" that together cover 24 hours a day, 7 days a
  week.
- Every shift is exactly **9 hours long**. The 8 shifts are evenly
  **staggered 3 hours apart** across the 24-hour clock (24 / 8 = 3), so with
  nobody resting, every single hour of the day is covered by exactly 3
  overlapping people. This even spacing is what makes a hard minimum-coverage
  guarantee achievable at all — don't break it without a very good reason.
- Each person works 5 days and rests 2 days per week (45 hrs/week each,
  uniformly).
- **Hard constraint, never relaxed:** at least 2 people must be on duty every
  single one of the 168 hours in the week.
- A person's 2 rest days are normally a **consecutive pair** (7 possible
  pairs on a weekly cycle: Mon–Tue, Tue–Wed, Wed–Thu, Thu–Fri, Fri–Sat,
  Sat–Sun, Sun–Mon).
- Special case: a person may instead have a **"no-work window"** requirement
  — e.g. a Sabbath: they may never be on shift between Friday 18:00 and
  Saturday 18:00 — which is checked directly against their actual shift
  hours (accounting for overnight-spanning shifts) rather than assumed to
  require any particular pair of days off. Depending on their shift's start
  time, satisfying this might only require **one** specific day off, not
  necessarily a weekend.
- Special case: a person may request an **exact shift start hour** (e.g.
  "must start at 19:00"). When this happens, the whole 8-slot grid must be
  rotated (offset) so that person's slot lands exactly there, while every
  other slot stays evenly spaced 3 hours apart from it. (Offset = requested
  hour mod 3; if two different people request exact times that aren't
  reachable on the same 3-hour-spaced grid, that's a contradiction — report
  it as an error rather than silently picking one.)
- Each person supplies, in ranked order (most preferred first):
  - a list of acceptable rest-day pairs,
  - a list of acceptable shift slots (shown to the user as both a letter
    A–H and the actual computed clock time for that slot),
  - a **priority**: "rest days matter more" or "work hours matter more."

## Preference-resolution rule (exact semantics)

Whichever dimension a person marked as their priority is the one their list
is drawn from as a **requirement** (not just a preference) — the other
dimension is a soft, best-effort preference that can be freely overridden if
needed. If it's genuinely impossible to satisfy every hour-priority person's
list at once (this can happen — prove it by exhaustive search, don't guess),
the algorithm must fall back gracefully, satisfying as many people's priority
dimension as mathematically possible, and clearly attribute which specific
person had to compromise and why, in the results.

## Algorithm (be precise — this needs to be a real exhaustive search, not a heuristic)

1. Compute the 8 slot start times from the grid offset (see above).
2. Split people into: **locked** (gave an exact start time), then among the
   rest, **rest-priority** and **hour-priority** groups.
3. For locked people, resolve their rest-day pair from their own mandatory
   list, filtered to whichever pairs also satisfy their no-work window (if
   any) at their fixed slot.
4. Exhaustively search, for the remaining people:
   - every permutation of rest-priority people into the remaining slots,
     combined with every combination of their (small, mandatory) rest-day
     pair options,
   - for each such choice, every permutation of hour-priority people into
     whatever slots are left — **but generate these permutations sorted by
     how many people land on one of their preferred slots (descending,
     weighted by rank)**, and try them in that order so a fully-satisfying
     assignment is found (and confirmed as such) before ever trying a
     worse one,
   - for each such slot assignment, search the hour-priority people's
     rest-day pair choices (7 options per person, so 7^k combinations) —
     but **walk that space in descending order of "bonus" score** (how well
     a combination matches each person's own ranked rest-day preference).
     Because bonus is non-increasing along that order, the *first*
     combination that satisfies the hard coverage constraint is *also* the
     best-bonus one — so you only need to exhaust the full 7^k space when
     **no** combination is feasible at all for that particular slot
     assignment (this is what makes a large search tractable, and it's also
     just correct — verify it doesn't skip a better feasible option).
   - Coverage check for a full candidate assignment: build a 7×24 grid,
     add each person's 1/0 "on duty this hour" contribution (get overnight
     wraparound exactly right — a shift starting at 22:00 for 9 hours spans
     into the next calendar day), and require every cell ≥ the minimum
     (2).
   - Track the best-scoring fully feasible assignment found. Score = every
     person's priority-dimension rank (weighted heavily) plus their
     non-priority-dimension rank (weighted lightly), summed.
5. Add branch-and-bound pruning: sort the outer (rest-priority)
   arrangements by their own local score descending; compute the most
   optimistic possible remaining (hour-priority) score up front; once a
   feasible complete solution is found, skip any remaining outer
   arrangement whose own score plus that optimistic bound can no longer
   beat it. This must be a **safe, provably-correct** cut, not a heuristic
   that might miss the true best answer.
6. This computation is genuinely expensive for a fully-booked, tightly
   constrained team of 8 (real-world testing showed 1.5–3+ minutes). That's
   fine — treat the wait as a legitimate feature (visible proof of real,
   exhaustive computation) rather than something to fake around. What is
   **not** fine is freezing the browser tab for that whole time.

## Responsiveness requirement (read this carefully — a real bug happened here)

Implement the search as a JS **generator function** that `yield`s
periodically (e.g. every ~40,000 inner coverage-checks, and once per outer
arrangement) so it can be driven in small time-sliced chunks instead of
running as one giant synchronous block.

- Provide a synchronous `solve(people, config, opts)` that just drains the
  generator fully — used by tests/Node/`verify.js`.
- Provide an async `solveAsync(people, config, opts)` that drives the
  generator in ~16ms chunks via `setTimeout(0)`, calling
  `opts.onProgress(snapshot)` between chunks, and resolving a Promise with
  the final result.
- **Bug to avoid:** every single `yield` in every generator (including
  nested ones reached via `yield*` delegation from an inner search
  function) must yield the *same shape* of progress snapshot object (e.g.
  `{outerChecked, totalOuter, innerChecked, hasBest}`), never a bare
  `yield;` (which yields `undefined`). If some yields carry data and others
  don't, the progress handler will eventually receive `undefined`, throw
  when it reads a field off it, and — because that throw happens inside an
  uncaught `setTimeout` callback — silently kill the whole async loop with
  no visible error. Symptom: the user clicks "Run," the progress bar ticks
  once or not at all, and then nothing ever happens again. Test this
  specifically: force a scenario where the inner search must run long
  enough to cross the yield threshold (e.g. an impossible-to-satisfy
  minimum coverage, so it can't exit early) and assert every value handed
  to `onProgress` is well-formed.

## UI

Sections, top to bottom:

1. A short explanation of what the page proves and exactly how someone can
   verify it themselves (edit a preference, re-run, confirm the output
   changes accordingly; read the plainly-visible source).
2. A **constraints** panel: fixed, non-editable stat cards for shift length,
   stagger, number of slots, work days/week, rest days per week, and the
   hard minimum-coverage number.
3. An editable card per person: name field; a set of toggle chips for
   acceptable rest-day pairs and for acceptable shift slots (slot chips show
   the real computed clock time, live-updated if the grid offset changes);
   a small drag-to-reorder list (using the vendored library) for ranking
   whichever chips are currently selected; a two-way priority toggle
   ("rest days" vs "work hours"); and a collapsed "advanced" section for the
   optional exact-start-time and no-work-window inputs.
4. A **Run** button, a live progress bar, and a scrolling monospace log
   panel that prints real search milestones (shift grid computed, groups
   sized, final combination counts) — not a fake/animated spinner.
5. Results: a schedule table (person, slot letter, actual hours, rest days,
   which of their preferences were met and at what rank); a 7×24 hour-by-hour
   coverage heatmap (color by count, legend included); summary stat tiles;
   and a **programmatically generated** plain-language explanation of every
   trade-off the algorithm made (e.g. who didn't get their preferred slot
   and why) — derived from the actual result object, never hardcoded text.

Re-running after editing any preference must fully recompute from scratch —
that reproducibility is the entire point of the tool.

## Default dataset (ship the app pre-loaded with this so it works out of the box)

8 people, rest-day pairs as `[dayIndex1, dayIndex2]` with Mon=0..Sun=6, shift
slots as letter index A=0..H=7:

| Name | Rest-day options (ranked) | Shift options (ranked) | Priority | Other |
|---|---|---|---|---|
| Cindy | Mon–Tue | E, F | Work hours | |
| Inah | Fri–Sat | E, B | Work hours | |
| Daphine | Thu–Fri | G, F | Rest days | Exact start 19:00; no-work window Fri 18:00 → Sat 18:00 |
| Bing | Fri–Sat | A, B, C | Work hours | |
| Phoebe | Sat–Sun, Sun–Mon | C, D, E | Rest days | |
| Joan | Fri–Sat | C, B | Work hours | |
| LA | Fri–Sat | C, B | Work hours | |
| Sherie | Sat–Sun | C, D | Rest days | |

Config: `{ shiftLen: 9, stagger: 3, minCoverage: 2, numSlots: 8 }`.

With this exact dataset, a correct solver should find: minimum coverage of
2 (hard constraint met) and maximum of 3, with Daphine getting slot G at
19:00 with Thu–Fri off (satisfying her no-work window because she never
works Friday, and her Saturday shift starts at 19:00 — after the window
already ends). Not everyone can get their #1 choice on both dimensions
simultaneously — that's expected and should be visible in the result's
explanation, not hidden.

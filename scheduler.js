/* scheduler.js
 *
 * Pure scheduling logic for the Shift Coverage Solver.
 *
 * Zero DOM dependencies. This file runs unchanged under plain Node
 * (via require) and in the browser (as a global `Scheduler`).
 *
 * Stage 1 scope: data model, slot math, coverage grid, window checks and
 * scoring. The exhaustive search is added in a later stage.
 */

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var SLOT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  var HOURS_PER_DAY = 24;
  var DAYS_PER_WEEK = 7;
  var HOURS_PER_WEEK = HOURS_PER_DAY * DAYS_PER_WEEK; // 168

  // Relative weights for the scoring rule. A person's priority dimension is
  // weighted heavily, their non-priority dimension lightly. Ranks count up
  // from 0 (best), so LOWER total scores are BETTER.
  var PRIORITY_WEIGHT = 100;
  var SOFT_WEIGHT = 1;

  // Ties: when several person-to-slot assignments reach the same top score, the
  // solver collects them all, sorts them by a name-based key (so the result does
  // not depend on the order people happen to appear in), and picks one with a
  // seeded random draw. The seed is part of the result and can be re-run.
  var DEFAULT_TIE_SEED = 1;
  var MAX_TIES = 200000; // distinct slot assignments are at most 8! = 40320

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------
  // Config and default dataset (copied exactly from PROMPT.md)
  // ---------------------------------------------------------------------

  var config = {
    shiftLen: 9,
    stagger: 3,
    minCoverage: 2,
    numSlots: 8
  };

  // Day indices: Mon = 0 ... Sun = 6.
  // Shift slot indices: A = 0 ... H = 7.
  //
  // priority: 'hours' means "work hours matter more",
  //           'rest'  means "rest days matter more".
  //
  // noWorkWindow: optional { startDay, startHour, endDay, endHour }; the
  //   person may never be on duty inside that window (checked against their
  //   actual shift hours, overnight spans included).
  // Full personal rankings supplied by the team (rankings.txt), highest
  // preference first. Slot letters: A=0 ... H=7. Rest pairs are the seven
  // consecutive day pairs, Mon-Tue=[0,1] ... Sun-Mon=[6,0].
  var defaultPeople = [
    {
      name: 'Cindy',
      // Sun-Mon, Mon-Tue, Fri-Sat, Sat-Sun, Tue-Wed, Wed-Thu
      restOptions: [[6, 0], [0, 1], [4, 5], [5, 6], [1, 2], [2, 3]],
      shiftOptions: [5, 4, 3, 2, 1, 6, 0, 7], // F, E, D, C, B, G, A, H
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Inah',
      // Fri-Sat, Sun-Mon, Sat-Sun, Thu-Fri, Tue-Wed
      restOptions: [[4, 5], [6, 0], [5, 6], [3, 4], [1, 2]],
      shiftOptions: [4, 3, 5, 2, 6, 1, 7, 0], // E, D, F, C, G, B, H, A
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Daphine',
      // Fri-Sat, Sat-Sun, Sun-Mon, Thu-Fri, Tue-Wed
      restOptions: [[4, 5], [5, 6], [6, 0], [3, 4], [1, 2]],
      shiftOptions: [6, 5, 4, 3, 2, 7, 0, 1], // G, F, E, D, C, H, A, B
      priority: 'rest',
      noWorkWindow: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 }
    },
    {
      name: 'Bing',
      // Sat-Sun, Fri-Sat, Sun-Mon, Tue-Wed, Thu-Fri
      restOptions: [[5, 6], [4, 5], [6, 0], [1, 2], [3, 4]],
      shiftOptions: [0, 3, 1, 2, 4, 7, 5, 6], // A, D, B, C, E, H, F, G
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Phoebe',
      // Sat-Sun, Sun-Mon, Fri-Sat, Thu-Fri, Tue-Wed
      restOptions: [[5, 6], [6, 0], [4, 5], [3, 4], [1, 2]],
      shiftOptions: [2, 3, 1, 4, 5, 0, 6, 7], // C, D, B, E, F, A, G, H
      priority: 'rest',
      noWorkWindow: null
    },
    {
      name: 'Joan',
      // Sat-Sun, Sun-Mon, Fri-Sat, Thu-Fri, Tue-Wed
      restOptions: [[5, 6], [6, 0], [4, 5], [3, 4], [1, 2]],
      shiftOptions: [2, 1, 3, 4, 0, 5, 6, 7], // C, B, D, E, A, F, G, H
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'LA',
      // Sat-Sun, Fri-Sat, Thu-Fri, Sun-Mon, Tue-Wed
      restOptions: [[5, 6], [4, 5], [3, 4], [6, 0], [1, 2]],
      shiftOptions: [1, 2, 3, 4, 0, 5, 6, 7], // B, C, D, E, A, F, G, H
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Sherie',
      // Sun-Mon, Sat-Sun, Fri-Sat, Thu-Fri, Tue-Wed
      restOptions: [[6, 0], [5, 6], [4, 5], [3, 4], [1, 2]],
      shiftOptions: [3, 2, 4, 5, 6, 7, 0, 1], // D, C, E, F, G, H, A, B
      priority: 'rest',
      noWorkWindow: null
    }
  ];

  // ---------------------------------------------------------------------
  // Small numeric helpers
  // ---------------------------------------------------------------------

  function mod(n, m) {
    return ((n % m) + m) % m;
  }

  function pairKey(pair) {
    // A rest-day pair is unordered and may wrap the week (Sun-Mon = [6,0]).
    // Sorting the two day indices gives a stable key for every one of the
    // seven adjacent pairs, with no collisions.
    var a = pair[0];
    var b = pair[1];
    return a <= b ? a + ',' + b : b + ',' + a;
  }

  // ---------------------------------------------------------------------
  // Slot math
  // ---------------------------------------------------------------------

  // Returns the start hour (0-23) of each of the numSlots shifts, letter
  // order A..H. With offset 0 the shifts start at 0,3,6,...,21. Increasing
  // offset rotates the whole evenly-spaced grid by that many hours.
  function computeSlots(cfg, offset) {
    cfg = cfg || config;
    offset = offset || 0;
    var slots = [];
    for (var i = 0; i < cfg.numSlots; i++) {
      slots.push(mod(offset + i * cfg.stagger, HOURS_PER_DAY));
    }
    return slots;
  }

  // ---------------------------------------------------------------------
  // Duty hours
  // ---------------------------------------------------------------------

  // Absolute week-hour indices (0..167, Mon 00:00 = 0) that a person is on
  // duty, given their shift start hour and rest-day indices. A shift that
  // crosses midnight advances into the next day; a shift that runs past
  // Sunday midnight wraps to Monday of this same (cyclic) week.
  function personDutyHours(slotStart, restDays, cfg) {
    cfg = cfg || config;
    var resting = {};
    (restDays || []).forEach(function (d) { resting[mod(d, DAYS_PER_WEEK)] = true; });

    var hours = [];
    for (var day = 0; day < DAYS_PER_WEEK; day++) {
      if (resting[day]) continue;
      var start = day * HOURS_PER_DAY + slotStart;
      for (var k = 0; k < cfg.shiftLen; k++) {
        hours.push(mod(start + k, HOURS_PER_WEEK));
      }
    }
    return hours;
  }

  // ---------------------------------------------------------------------
  // Coverage grid
  // ---------------------------------------------------------------------

  // Resolve an assignment entry's shift start hour. Entries normally carry
  // `slotStart` directly; as a fallback we look up assignment.slots[slotIndex].
  function entrySlotStart(entry, assignment, cfg) {
    if (entry && typeof entry.slotStart === 'number') return entry.slotStart;
    var slots = assignment && assignment.slots;
    if (slots && typeof entry.slotIndex === 'number') return slots[entry.slotIndex];
    throw new Error('Assignment entry has neither slotStart nor a resolvable slotIndex');
  }

  // Builds a 7x24 grid of headcounts. `assignment` is an array of entries
  //   { person?, name?, slotIndex?, slotStart, restDays }
  // (or an object with an `entries` array and optional `slots`). Every hour
  // of the week is counted, overnight wraparound included, so the sum of the
  // grid equals (people * working days * shiftLen).
  function buildCoverageGrid(assignment, cfg) {
    cfg = cfg || config;
    var entries = Array.isArray(assignment) ? assignment : (assignment.entries || []);

    var grid = [];
    for (var d = 0; d < DAYS_PER_WEEK; d++) {
      grid.push(new Array(HOURS_PER_DAY).fill(0));
    }

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var slotStart = entrySlotStart(entry, assignment, cfg);
      var duty = personDutyHours(slotStart, entry.restDays, cfg);
      for (var j = 0; j < duty.length; j++) {
        var a = duty[j];
        grid[Math.floor(a / HOURS_PER_DAY)][a % HOURS_PER_DAY] += 1;
      }
    }
    return grid;
  }

  function meetsCoverage(grid, minCoverage) {
    for (var d = 0; d < grid.length; d++) {
      for (var h = 0; h < grid[d].length; h++) {
        if (grid[d][h] < minCoverage) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // No-work window
  // ---------------------------------------------------------------------

  // True if the person is never on duty inside their no-work window. The
  // window is given as { startDay, startHour, endDay, endHour } in weekly
  // terms (Mon=0). Checked against actual duty hours, so an overnight shift
  // that dips into the window is caught. Returns true when no window is set.
  function satisfiesNoWorkWindow(person, slotStart, restDays, cfg) {
    var win = person && person.noWorkWindow;
    if (!win) return true;
    cfg = cfg || config;

    var start = win.startDay * HOURS_PER_DAY + win.startHour;
    var end = win.endDay * HOURS_PER_DAY + win.endHour;
    if (end <= start) end += HOURS_PER_WEEK; // window wraps the week

    var duty = personDutyHours(slotStart, restDays, cfg);
    for (var i = 0; i < duty.length; i++) {
      var a = duty[i];
      if ((a >= start && a < end) ||
          (a + HOURS_PER_WEEK >= start && a + HOURS_PER_WEEK < end)) {
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------

  // Rank of a value within a person's own ranked option list: 0 is their
  // top choice. A value not in the list gets rank = list.length (one worse
  // than the last listed option), so unsatisfiable lists still compare.
  function rankOf(options, value, kind) {
    options = options || [];
    if (kind === 'rest') {
      var key = pairKey(value);
      for (var i = 0; i < options.length; i++) {
        if (pairKey(options[i]) === key) return i;
      }
      return options.length;
    }
    var idx = options.indexOf(value);
    return idx >= 0 ? idx : options.length;
  }

  // Score = sum over people of PRIORITY_WEIGHT * priorityRank
  //                                  + SOFT_WEIGHT * nonPriorityRank.
  // Lower is better. `assignment` is the same shape as buildCoverageGrid,
  // and each entry must carry its `person`.
  function scoreAssignment(assignment, cfg, opts) {
    cfg = cfg || config;
    opts = opts || {};
    var pw = typeof opts.priorityWeight === 'number' ? opts.priorityWeight : PRIORITY_WEIGHT;
    var sw = typeof opts.softWeight === 'number' ? opts.softWeight : SOFT_WEIGHT;
    var entries = Array.isArray(assignment) ? assignment : (assignment.entries || []);

    var total = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var p = entry.person;
      if (!p) throw new Error('scoreAssignment needs entry.person for each entry');
      var slotStart = entrySlotStart(entry, assignment, cfg);
      var restRank = rankOf(p.restOptions, entry.restDays, 'rest');
      var hourRank = rankOf(p.shiftOptions, entry.slotIndex, 'hours');

      if (p.priority === 'rest') {
        total += pw * restRank + sw * hourRank;
      } else {
        total += pw * hourRank + sw * restRank;
      }
    }
    return total;
  }

  // ---------------------------------------------------------------------
  // Exhaustive search
  // ---------------------------------------------------------------------
  //
  // The candidate domain is OPEN: every person may be assigned any of the 8
  // slots and any of the 7 consecutive rest-day pairs. Their ranked lists only
  // say how much they want each option (rank 0 = most wanted; anything they
  // did not rank is a tied-for-last tier). The two dimensions are independent,
  // linked only by feasibility.
  //
  // Hard rules: coverage minimum on all 168 hours; each person's no-work
  // window; any owed "guarantee" carried over from the previous run (rotation
  // fairness).
  //
  // Soft objective: weighted rank penalty (lower is better). A person's
  // priority dimension counts heavily, the other lightly.

  var ADJACENT_PAIRS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0]];

  function hourRankFor(person, slotIndex, cfg) {
    return rankOf(person.shiftOptions, slotIndex, 'hours');
  }

  function restRankFor(person, pair) {
    return rankOf(person.restOptions, pair, 'rest');
  }

  function listLengthFor(person, kind) {
    var list = kind === 'rest' ? person.restOptions : person.shiftOptions;
    return (list || []).length;
  }

  // The dimension a person marked as their priority is weighted heavily.
  function slotWeightFor(person, pw, sw) {
    return person.priority === 'hours' ? pw : sw;
  }
  function restWeightFor(person, pw, sw) {
    return person.priority === 'rest' ? pw : sw;
  }

  // Is there at least one rest pair that keeps this person's no-work window
  // safe at the given slot? (Reading A of the window fairness rule.)
  function slotWindowAllowed(person, slotStart, cfg) {
    if (!person.noWorkWindow) return true;
    for (var i = 0; i < ADJACENT_PAIRS.length; i++) {
      if (satisfiesNoWorkWindow(person, slotStart, ADJACENT_PAIRS[i], cfg)) return true;
    }
    return false;
  }

  // Rest pairs a person may take at a slot: window-safe, and (if a guarantee
  // is owed) exactly the guaranteed pair. Sorted most-wanted first.
  function restOptionsFor(person, slotStart, cfg, forcedPair) {
    var list = [];
    for (var i = 0; i < ADJACENT_PAIRS.length; i++) {
      var pair = ADJACENT_PAIRS[i];
      if (forcedPair && pairKey(pair) !== pairKey(forcedPair)) continue;
      if (!satisfiesNoWorkWindow(person, slotStart, pair, cfg)) continue;
      list.push({
        pair: pair,
        rank: restRankFor(person, pair),
        hours: shiftedHoursOnDays(slotStart, pair, cfg)
      });
    }
    list.sort(function (a, b) { return a.rank - b.rank; });
    return list;
  }

  // Flat Int16 counts over the 168 hour-slots of the week.
  function newCounts() {
    return new Int16Array(HOURS_PER_WEEK);
  }

  function addEntryCounts(counts, slotStart, restDays, cfg) {
    var hours = personDutyHours(slotStart, restDays, cfg);
    for (var i = 0; i < hours.length; i++) {
      counts[hours[i]] += 1;
    }
  }

  function coverageOk(counts, minCoverage) {
    for (var i = 0; i < HOURS_PER_WEEK; i++) {
      if (counts[i] < minCoverage) return false;
    }
    return true;
  }

  function countsToGrid(counts) {
    var grid = [];
    for (var d = 0; d < DAYS_PER_WEEK; d++) {
      var row = [];
      for (var h = 0; h < HOURS_PER_DAY; h++) row.push(counts[d * HOURS_PER_DAY + h]);
      grid.push(row);
    }
    return grid;
  }

  // Slot assignment is enumerated directly inside the search (see attemptGen).

  // --- ordered walk of the hour-priority rest-day space -------------------
  // Each person's 7 pairs are visited in ascending rest rank ("bonus" order),
  // and the space is searched depth-first with branch-and-bound on that bonus,
  // so the best-bonus feasible combination is found first and the full 7^k
  // space is only exhausted when nothing is feasible. Feasibility is checked
  // against a per-hour "capacity" (how many rest shifts that hour can absorb
  // before coverage drops below the minimum), which prunes whole subtrees the
  // instant a rest shift would over-fill an hour. Exact: the B&B bound is the
  // sum of the cheapest remaining ranks, so no better combination is skipped.

  // The hours removed from an "everyone works all week" baseline when the
  // listed days are taken as rest: exactly the shifts that start on those days
  // (overnight hours included, wrapping the week).
  function shiftedHoursOnDays(slotStart, days, cfg) {
    var out = [];
    for (var i = 0; i < days.length; i++) {
      var start = mod(days[i], DAYS_PER_WEEK) * HOURS_PER_DAY + slotStart;
      for (var k = 0; k < cfg.shiftLen; k++) out.push(mod(start + k, HOURS_PER_WEEK));
    }
    return out;
  }



  // --- progress reporting -------------------------------------------------
  // IMPORTANT: every generator in this file yields the SAME shape of progress
  // object, including the nested ones reached through `yield*`. A bare
  // `yield;` would hand `undefined` to the async driver and silently kill it,
  // so it never appears here.

  var YIELD_EVERY = 40000; // inner coverage-checks between progress yields

  function makeSnapshot(prog) {
    return {
      outerChecked: prog.outerChecked,
      totalOuter: prog.totalOuter,
      innerChecked: prog.innerChecked,
      hasBest: prog.hasBest,
      phase: prog.phase
    };
  }

  // Increments the work counter and yields a snapshot once every yieldEvery
  // units (default YIELD_EVERY). Reached via `yield*`, so its snapshot flows
  // straight to the driver.
  function* yieldTick(prog) {
    prog.work++;
    if (prog.work - prog.lastYield >= prog.yieldEvery) {
      prog.lastYield = prog.work;
      yield makeSnapshot(prog);
    }
  }

  // Assigns a rest pair to every person for a fixed slot assignment, choosing
  // the combination that minimises the weighted rest-rank penalty while keeping
  // coverage and every no-work window. Exact depth-first search with a per-hour
  // capacity prune and a branch-and-bound bound, so it is fast and never skips
  // a better feasible combination.
  function* restAssign(slotOf, people, slots, cfg, pw, sw, prog, owed) {
    var k = people.length;
    prog.restCombos++;
    prog.innerChecked++;

    var base = newCounts();
    for (var i = 0; i < k; i++) {
      var all = personDutyHours(slots[slotOf[i]], [], cfg);
      for (var a = 0; a < all.length; a++) base[all[a]] += 1;
    }
    var capacity = new Int16Array(HOURS_PER_WEEK);
    for (var h = 0; h < HOURS_PER_WEEK; h++) {
      var c = base[h] - cfg.minCoverage;
      if (c < 0) return null;
      capacity[h] = c;
    }

    var options = new Array(k);
    var weights = new Array(k);
    for (var j = 0; j < k; j++) {
      var person = people[j];
      var forced = (owed && owed[j] && owed[j].pair) ? owed[j].pair : null;
      options[j] = restOptionsFor(person, slots[slotOf[j]], cfg, forced);
      if (options[j].length === 0) return null;
      weights[j] = restWeightFor(person, pw, sw);
    }

    var lb = new Array(k + 1);
    lb[k] = 0;
    for (var b = k - 1; b >= 0; b--) lb[b] = lb[b + 1] + weights[b] * options[b][0].rank;

    var removals = new Int16Array(HOURS_PER_WEEK);
    var bestCost = Infinity;
    var bestPairs = null;
    var cur = new Array(k);

    function* dfs(idx, cost) {
      if (idx === k) { bestCost = cost; bestPairs = cur.slice(); return; }
      if (cost + lb[idx] >= bestCost) return;
      var list = options[idx];
      for (var x = 0; x < list.length; x++) {
        var opt = list[x];
        var nc = cost + weights[idx] * opt.rank;
        if (nc + lb[idx + 1] >= bestCost) break; // ranks ascend
        var hrs = opt.hours;
        var ok = true;
        for (var m = 0; m < hrs.length; m++) {
          if (removals[hrs[m]] + 1 > capacity[hrs[m]]) { ok = false; break; }
        }
        if (!ok) continue;
        for (var n = 0; n < hrs.length; n++) removals[hrs[n]]++;
        cur[idx] = opt.pair;
        yield* dfs(idx + 1, nc);
        for (var q = 0; q < hrs.length; q++) removals[hrs[q]]--;
        yield* yieldTick(prog);
      }
    }

    yield* dfs(0, 0);

    if (!bestPairs) return null;
    return { cost: bestCost, pairs: bestPairs };
  }

  // One full search pass, as a generator so it can be time-sliced. Returns
  // either "no feasible schedule" or the collected top-scoring assignments.
  //
  // Slot selection:
  //   - anyone with a no-work window is given the WORKABLE slot the REST of
  //     the team least wants (highest sum of the other people's rankOf, i.e.
  //     most disliked by everyone else), most-disliked first, later letter
  //     first as a tie-break; the first arrangement that yields any feasible
  //     schedule wins;
  //   - anyone owed a slot guarantee (rotation fairness) is pinned there;
  //   - everyone else is permuted over the remaining slots.
  // Rest selection is then an exact per-assignment search (restAssign).
  function* attemptGen(people, cfg, pw, sw, owed, prog) {
    var counters = prog;
    var slots = computeSlots(cfg, 0);
    var n = people.length;

    var fixedBase = {};   // person index -> slot, from rotation guarantees
    var windowIdx = [];
    for (var i0 = 0; i0 < n; i0++) {
      var p0 = people[i0];
      if (p0.noWorkWindow) windowIdx.push(i0);
      else if (owed && owed[i0] && owed[i0].slot != null) fixedBase[i0] = owed[i0].slot;
    }

    // Most-disliked-by-others-first list of workable slots for a window
    // person. dislike(s) is the sum of every OTHER person's rank of slot s
    // (higher = the rest of the team wants it less).
    function windowCandidates(idx) {
      var person = people[idx], arr = [];
      for (var s = 0; s < cfg.numSlots; s++) {
        if (slotWindowAllowed(person, slots[s], cfg)) arr.push(s);
      }
      arr.sort(function (a, b) {
        var da = 0, db = 0;
        for (var p = 0; p < n; p++) {
          if (p === idx) continue;
          da += rankOf(people[p].shiftOptions, a, 'hours');
          db += rankOf(people[p].shiftOptions, b, 'hours');
        }
        if (db !== da) return db - da;  // higher dislike = less wanted by others, tried first
        return b - a;                    // tie-break: later letter first
      });
      return arr;
    }
    var winCands = windowIdx.map(windowCandidates);
    for (var w0 = 0; w0 < winCands.length; w0++) {
      if (winCands[w0].length === 0) return { best: Infinity, counters: counters };
    }

    var best = Infinity;
    var ties = new Map();

    function recordTie(slotOf, pairs) {
      if (ties.size >= MAX_TIES) return;
      var parts = [], entries = [];
      for (var t = 0; t < n; t++) {
        parts.push(people[t].name + ':' + slotOf[t]);
        entries.push({
          person: people[t], name: people[t].name, slotIndex: slotOf[t],
          slotStart: slots[slotOf[t]], restDays: pairs[t].slice()
        });
      }
      parts.sort();
      var key = parts.join('|');
      if (ties.has(key)) return;
      entries.sort(function (a, b) { return a.slotIndex - b.slotIndex; });
      ties.set(key, { key: key, entries: entries });
    }

    function factorial(m) { var f = 1; for (var z = 2; z <= m; z++) f *= z; return f; }

    // Search all arrangements that pin the given slots (person index -> slot).
    function* searchFixed(fixedSlots) {
      var used = new Array(cfg.numSlots).fill(false);
      var freeIdx = [], freeSlots = [];
      var clash = false;
      for (var k = 0; k < n; k++) {
        if (fixedSlots[k] != null) {
          if (used[fixedSlots[k]]) clash = true;
          else used[fixedSlots[k]] = true;
        } else {
          freeIdx.push(k);
        }
      }
      if (clash) return false;
      for (var s = 0; s < cfg.numSlots; s++) if (!used[s]) freeSlots.push(s);
      if (freeIdx.length !== freeSlots.length) return false;

      prog.totalOuter = factorial(freeSlots.length);
      var slotOf = new Array(n);
      for (var k2 = 0; k2 < n; k2++) if (fixedSlots[k2] != null) slotOf[k2] = fixedSlots[k2];

      var localFeasible = false;

      function* perm(ci, usedSlots) {
        if (ci === freeIdx.length) {
          counters.innerPerms++;
          counters.outers++;
          prog.outerChecked = counters.outers;
          prog.hasBest = best < Infinity;
          yield makeSnapshot(prog);

          var slotCost = 0;
          for (var a = 0; a < n; a++) {
            slotCost += slotWeightFor(people[a], pw, sw) *
              rankOf(people[a].shiftOptions, slotOf[a], 'hours');
          }
          if (slotCost > best) return;
          var res = yield* restAssign(slotOf, people, slots, cfg, pw, sw, prog, owed);
          if (!res) return;
          var total = slotCost + res.cost;
          if (total < best) {
            best = total;
            ties.clear();
            recordTie(slotOf, res.pairs);
            localFeasible = true;
          } else if (total === best) {
            recordTie(slotOf, res.pairs);
            localFeasible = true;
          }
          return;
        }
        var idx = freeIdx[ci];
        for (var s2 = 0; s2 < freeSlots.length; s2++) {
          if (usedSlots[s2]) continue;
          usedSlots[s2] = true;
          slotOf[idx] = freeSlots[s2];
          yield* perm(ci + 1, usedSlots);
          usedSlots[s2] = false;
        }
      }
      yield* perm(0, new Array(freeSlots.length).fill(false));
      return localFeasible;
    }

    // Enumerate window-slot combinations least-preferred-first; the first that
    // yields a feasible schedule is the one the window rule selects.
    var stopped = false;
    function* winCombo(wi, chosen) {
      if (stopped) return;
      if (wi === windowIdx.length) {
        var fixed = {};
        for (var kk in fixedBase) fixed[kk] = fixedBase[kk];
        for (var c = 0; c < windowIdx.length; c++) fixed[windowIdx[c]] = chosen[c];
        var feasible = yield* searchFixed(fixed);
        if (feasible) stopped = true;
        return;
      }
      var cands = winCands[wi];
      for (var ci = 0; ci < cands.length; ci++) {
        if (stopped) return;
        var slot = cands[ci];
        var taken = false;
        for (var kk2 in fixedBase) if (fixedBase[kk2] === slot) taken = true;
        if (taken) continue;
        chosen.push(slot);
        yield* winCombo(wi + 1, chosen);
        chosen.pop();
      }
    }
    yield* winCombo(0, []);

    if (ties.size === 0) return { best: Infinity, counters: counters };
    return {
      best: best,
      ties: Array.from(ties.values()),
      counters: counters,
      offset: 0,
      slots: slots,
      people: people
    };
  }

  function restDayNames(restDays) {
    return restDays.map(function (d) { return DAYS[mod(d, DAYS_PER_WEEK)]; });
  }

  function makeProgress(phase) {
    return {
      // progress-snapshot fields (same keys on every yield)
      outerChecked: 0,
      totalOuter: 0,
      innerChecked: 0,
      hasBest: false,
      phase: phase,
      // run statistics / internal counters
      outers: 0,
      innerPerms: 0,
      restCombos: 0,
      work: 0,
      lastYield: 0,
      yieldEvery: YIELD_EVERY
    };
  }

  // The whole solve as a generator (a single open-domain pass). Its yielded
  // values are the progress snapshots; its return value is the final result.
  function* solveGen(people, cfg, opts) {
    cfg = cfg || config;
    opts = opts || {};
    var pw = typeof opts.priorityWeight === 'number' ? opts.priorityWeight : PRIORITY_WEIGHT;
    var sw = typeof opts.softWeight === 'number' ? opts.softWeight : SOFT_WEIGHT;
    var t0 = Date.now();

    var prog = makeProgress('strict');
    prog.yieldEvery = (typeof opts.yieldEvery === 'number' && opts.yieldEvery > 0)
      ? opts.yieldEvery : YIELD_EVERY;
    var owed = opts.owed || null;

    // Rotation guarantees (§5). When any are owed we first try to honour all
    // of them; if that is infeasible we fall back to the largest feasible
    // subset (see solveWithFallback). `owed` absent/null => the old path,
    // unchanged.
    var guarantees = buildGuarantees(people, owed);
    var fallback = null;
    var result;
    if (guarantees.length > 0) {
      fallback = yield* solveWithFallback(people, cfg, pw, sw, owed, guarantees, prog);
      result = fallback.attempt;
    } else {
      result = yield* attemptGen(people, cfg, pw, sw, owed, prog);
    }

    if (result.best === Infinity) return { ok: false, error: 'infeasible', elapsedMs: Date.now() - t0 };

    // Attribute every owed guarantee as satisfied or dropped. Only produced
    // when the caller actually supplied `opts.owed`, so a run without rotation
    // history keeps exactly its previous result shape.
    var guaranteeReport = null;
    if (owed) {
      guaranteeReport = buildGuaranteeReport(guarantees, fallback);
    }

    // Tie-break. All top-scoring assignments were collected during the search.
    // Sort them by a name-based key so the outcome does not depend on the order
    // people appear in the app, then pick one with a seeded random draw.
    var tied = result.ties.slice().sort(function (a, b) {
      return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });
    var seed = (typeof opts.tieSeed === 'number' && isFinite(opts.tieSeed))
      ? (opts.tieSeed >>> 0) : DEFAULT_TIE_SEED;
    var rand = mulberry32(seed);
    var chosenIndex = Math.floor(rand() * tied.length);
    if (chosenIndex >= tied.length) chosenIndex = tied.length - 1;
    var entries = tied[chosenIndex].entries;

    // Which people changed slot between the tied schedules, and which of those
    // have identical preferences (so they are genuinely interchangeable).
    var slotByName = {};
    tied.forEach(function (t) {
      t.entries.forEach(function (e) {
        (slotByName[e.name] = slotByName[e.name] || {})[e.slotIndex] = true;
      });
    });
    var swingNames = Object.keys(slotByName).filter(function (n) {
      return Object.keys(slotByName[n]).length > 1;
    });
    var sig = function (p) {
      return p.priority + '|' +
        p.restOptions.map(pairKey).sort().join(',') + '|' +
        p.shiftOptions.slice().sort().join(',');
    };
    var groups = {};
    people.forEach(function (p) { (groups[sig(p)] = groups[sig(p)] || []).push(p.name); });
    var interchangeable = Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.length > 1; });

    var tieInfo = {
      count: tied.length,
      seed: seed,
      rule: 'seeded-random-draw',
      ruleLabel: 'Seeded random draw (mulberry32)',
      chosenIndex: chosenIndex,
      swingNames: swingNames,
      interchangeableGroups: interchangeable,
      definition: 'A schedule is the person-to-slot assignment; different rest-day choices within the same slot assignment are not counted separately.'
    };

    var grid = buildCoverageGrid(entries, cfg);
    var min = Infinity, max = 0, totalHours = 0;
    grid.forEach(function (row) {
      row.forEach(function (v) {
        if (v < min) min = v;
        if (v > max) max = v;
        totalHours += v;
      });
    });

    var assignment = entries.map(function (e) {
      var p = e.person;
      var priorityRank = p.priority === 'rest'
        ? rankOf(p.restOptions, e.restDays, 'rest')
        : hourRankFor(p, e.slotIndex);
      var softRank = p.priority === 'rest'
        ? hourRankFor(p, e.slotIndex)
        : rankOf(p.restOptions, e.restDays, 'rest');
      var priorityListLen = listLengthFor(p, p.priority === 'rest' ? 'rest' : 'hours');
      return {
        name: e.name,
        slotIndex: e.slotIndex,
        slotLetter: SLOT_LETTERS[e.slotIndex],
        slotStart: e.slotStart,
        restDays: e.restDays.slice(),
        restDayNames: restDayNames(e.restDays),
        priority: p.priority,
        priorityRank: priorityRank,
        softRank: softRank,
        priorityMet: priorityRank < priorityListLen
      };
    });

    var out = {
      ok: true,
      offset: result.offset,
      slots: result.slots,
      assignment: assignment,
      grid: grid,
      score: result.best,
      minCoverage: min,
      maxCoverage: max,
      totalPersonHours: totalHours,
      exactlyBalanced: min === max,
      phase: 'open-domain',
      tie: tieInfo,
      stats: {
        outers: prog.outers,
        innerPerms: prog.innerPerms,
        restCombos: prog.restCombos,
        innerChecked: prog.innerChecked
      },
      elapsedMs: Date.now() - t0
    };
    if (guaranteeReport) out.guarantees = guaranteeReport;
    return out;
  }

  // Synchronous solver: drain the generator fully (tests, Node, verify.js).
  function solve(people, cfg, opts) {
    var gen = solveGen(people, cfg, opts);
    var step = gen.next();
    while (!step.done) step = gen.next();
    return step.value;
  }

  // Async solver: drive the generator in ~16ms slices, reporting progress
  // snapshots between slices. Always resolves the Promise with the final
  // result; a bad snapshot or any error rejects instead of dying silently.
  function solveAsync(people, cfg, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var gen = solveGen(people, cfg, opts);

      function step() {
        var deadline = Date.now() + 16;
        try {
          for (;;) {
            var r = gen.next();
            if (r.done) { resolve(r.value); return; }
            if (typeof opts.onProgress === 'function') opts.onProgress(r.value);
            if (Date.now() >= deadline) break;
          }
        } catch (err) {
          reject(err);
          return;
        }
        setTimeout(step, 0);
      }

      step();
    });
  }

  // ---------------------------------------------------------------------
  // Cross-run fairness ("rotation", §5)
  // ---------------------------------------------------------------------
  //
  // History shape (JSON-serialisable, versioned):
  //
  //   {
  //     version: 1,
  //     runs: [ runRecord, ... ],   // most recent last, capped at MAX_HISTORY_RUNS
  //     streaks: {
  //       "<person name>": { slot: <n>, rest: <n> }   // consecutive misses
  //     }
  //   }
  //
  //   runRecord = {
  //     at: <ISO 8601 string>,
  //     entries: [ {
  //       name:        <string>,
  //       slotHit:     <bool>,  // assigned slot === their #1 slot
  //       restHit:     <bool>,  // assigned rest pair === their #1 rest pair
  //       slotTracked: <bool>,  // false => slot dimension exempt from rotation
  //                             //          (no #1 slot, or a no-work window)
  //       restTracked: <bool>   // false => person has no #1 rest pair
  //     } ]
  //   }
  //
  // Untracked dimensions are recorded as hits and never increment a streak, so
  // they can never create rotation debt. Window people are exempt from SLOT
  // debt (their §4 rule already assigns the slot the rest of the team least
  // wants, which is their fairness mechanism); their REST dimension
  // participates normally.

  var HISTORY_VERSION = 1;
  var MAX_HISTORY_RUNS = 50;

  // Exact subset enumeration is used up to and including this many guarantees;
  // beyond it we switch to a documented greedy drop (see solveWithFallback).
  var SUBSET_ENUM_MAX = 12;

  // Does this person have a #1 for the dimension, and is the dimension tracked
  // for rotation at all?
  function slotTrackedFor(person) {
    return !!(person && person.shiftOptions && person.shiftOptions.length > 0) &&
      !(person && person.noWorkWindow);
  }
  function restTrackedFor(person) {
    return !!(person && person.restOptions && person.restOptions.length > 0);
  }

  // Snapshot one run's hit/miss per person per dimension.
  function buildRunRecord(assignment, people) {
    var byName = {};
    (people || []).forEach(function (p) { byName[p.name] = p; });
    var list = Array.isArray(assignment)
      ? assignment
      : (assignment && assignment.assignment) || [];

    var entries = list.map(function (a) {
      var p = byName[a.name];
      var slotFirst = (p && p.shiftOptions) ? p.shiftOptions[0] : undefined;
      var restFirst = (p && p.restOptions) ? p.restOptions[0] : undefined;
      var slotTracked = slotTrackedFor(p);
      var restTracked = restTrackedFor(p);
      var slotHit = slotTracked ? (a.slotIndex === slotFirst) : true;
      var restHit = restTracked ? (pairKey(a.restDays) === pairKey(restFirst)) : true;
      return {
        name: a.name,
        slotHit: slotHit,
        restHit: restHit,
        slotTracked: slotTracked,
        restTracked: restTracked
      };
    });

    return { at: new Date().toISOString(), entries: entries };
  }

  // Who is owed a guarantee going into the next run, derived from the last
  // recorded run plus the carried-forward streaks.
  //   - slot debt only for non-window people who missed their #1 slot;
  //   - rest debt for anyone (window people included) who missed their #1 pair;
  //   - streaks are the current consecutive-miss counts (0 if none/hit).
  function computeOwed(history, people) {
    var streaks = (history && history.streaks) || {};
    var runs = (history && history.runs) || [];
    var last = runs.length ? runs[runs.length - 1] : null;
    var lastByName = {};
    if (last) (last.entries || []).forEach(function (e) { lastByName[e.name] = e; });

    var owed = [];
    var list = [];

    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      var name = p.name;
      var st = streaks[name] || { slot: 0, rest: 0 };
      var slotStreak = st.slot || 0;
      var pairStreak = st.rest || 0;
      var slotDebt = null;
      var pairDebt = null;
      var e = lastByName[name];

      if (p.noWorkWindow) {
        // §4 already gives window people the workable slot the rest of the
        // team least wants every run; never owe them a slot and never track
        // their slot streak.
        slotStreak = 0;
      } else {
        var slotFirst = (p.shiftOptions || [])[0];
        if (e && e.slotTracked !== false && slotFirst != null && !e.slotHit) {
          slotDebt = slotFirst;
        }
      }

      var restFirst = (p.restOptions || [])[0];
      if (e && e.restTracked !== false && restFirst != null && !e.restHit) {
        pairDebt = restFirst;
      }

      owed.push({
        slot: slotDebt,
        pair: pairDebt,
        slotStreak: slotStreak,
        pairStreak: pairStreak
      });

      if (slotDebt != null) {
        list.push(name + ' missed their #1 slot ' + SLOT_LETTERS[slotDebt] + ' for ' +
          slotStreak + ' run' + (slotStreak === 1 ? '' : 's') +
          ' in a row; it is guaranteed this run.');
      }
      if (pairDebt != null) {
        list.push(name + ' missed their #1 rest pair ' +
          restDayNames(pairDebt).join('-') + ' for ' + pairStreak +
          ' run' + (pairStreak === 1 ? '' : 's') +
          ' in a row; it is guaranteed this run.');
      }
    }

    return { owed: owed, list: list };
  }

  // Immutably fold one run record into the history: advance each person's
  // consecutive-miss streaks and keep a bounded list of recent runs.
  function appendHistory(history, runRecord) {
    history = history || {};
    var oldStreaks = history.streaks || {};
    var oldRuns = history.runs || [];

    var streaks = {};
    Object.keys(oldStreaks).forEach(function (n) {
      streaks[n] = { slot: oldStreaks[n].slot || 0, rest: oldStreaks[n].rest || 0 };
    });

    (runRecord.entries || []).forEach(function (e) {
      var cur = streaks[e.name] || { slot: 0, rest: 0 };
      var slotTracked = e.slotTracked !== false;
      var restTracked = e.restTracked !== false;
      cur.slot = slotTracked ? (e.slotHit ? 0 : (cur.slot || 0) + 1) : 0;
      cur.rest = restTracked ? (e.restHit ? 0 : (cur.rest || 0) + 1) : 0;
      streaks[e.name] = cur;
    });

    var runs = oldRuns.concat([runRecord]);
    if (runs.length > MAX_HISTORY_RUNS) runs = runs.slice(runs.length - MAX_HISTORY_RUNS);

    return { version: HISTORY_VERSION, runs: runs, streaks: streaks };
  }

  // Flatten `opts.owed` into an explicit guarantee list, skipping slot
  // guarantees for window people (the solver never honours those anyway).
  function buildGuarantees(people, owed) {
    var g = [];
    if (!owed) return g;
    for (var i = 0; i < people.length; i++) {
      var o = owed[i];
      if (!o) continue;
      var p = people[i];
      if (!p.noWorkWindow && o.slot != null) {
        g.push({ index: i, name: p.name, dimension: 'slot', value: o.slot, streak: o.slotStreak || 0 });
      }
      if (o.pair != null) {
        g.push({ index: i, name: p.name, dimension: 'rest', value: o.pair, streak: o.pairStreak || 0 });
      }
    }
    return g;
  }

  // A copy of `owed` carrying only the guarantees whose bit is set in `mask`.
  function owedForMask(owed, guarantees, mask) {
    var out = new Array(owed.length);
    for (var i = 0; i < owed.length; i++) {
      var o = owed[i] || {};
      out[i] = {
        slot: null, pair: null,
        slotStreak: o.slotStreak || 0, pairStreak: o.pairStreak || 0
      };
    }
    for (var g = 0; g < guarantees.length; g++) {
      if (!(mask & (1 << g))) continue;
      var gu = guarantees[g];
      if (gu.dimension === 'slot') out[gu.index].slot = gu.value;
      else out[gu.index].pair = gu.value;
    }
    return out;
  }

  function popcount(mask) {
    var c = 0;
    while (mask) { c += mask & 1; mask >>>= 1; }
    return c;
  }
  function totalStreak(guarantees, mask) {
    var t = 0;
    for (var g = 0; g < guarantees.length; g++) if (mask & (1 << g)) t += guarantees[g].streak;
    return t;
  }

  // Subset order: most guarantees kept first, then longest total miss-streak,
  // then the numeric mask as a deterministic final tie-break.
  function compareMasks(guarantees) {
    return function (a, b) {
      var pa = popcount(a), pb = popcount(b);
      if (pa !== pb) return pb - pa;
      var sa = totalStreak(guarantees, a), sb = totalStreak(guarantees, b);
      if (sa !== sb) return sb - sa;
      return a - b;
    };
  }

  // Given all owed guarantees, find the feasible run that keeps the most of
  // them (exact subset search for <= SUBSET_ENUM_MAX guarantees, otherwise a
  // bounded greedy drop). The windows and the open domain are untouched; only
  // which guarantees are pinned changes.
  //
  // Returns { attempt, mask, attempts } where `attempt` is an attemptGen
  // result and `mask` marks the kept guarantees (-1 when nothing was feasible,
  // including the no-guarantee base problem).
  function* solveWithFallback(people, cfg, pw, sw, owed, guarantees, prog) {
    var G = guarantees.length;
    var attempts = 0;

    function* runMask(mask) {
      var subset = owedForMask(owed, guarantees, mask);
      return yield* attemptGen(people, cfg, pw, sw, subset, prog);
    }

    if (G <= SUBSET_ENUM_MAX) {
      var masks = [];
      for (var m = 1; m < (1 << G); m++) masks.push(m);
      masks.push(0); // last resort: drop everything (the plain base problem)
      masks.sort(compareMasks(guarantees));
      for (var mi = 0; mi < masks.length; mi++) {
        attempts++;
        var res = yield* runMask(masks[mi]);
        yield makeSnapshot(prog);
        if (res && res.best !== Infinity) {
          return { attempt: res, mask: masks[mi], attempts: attempts };
        }
      }
      return { attempt: { best: Infinity }, mask: -1, attempts: attempts };
    }

    // Greedy fallback (> SUBSET_ENUM_MAX guarantees): keep trying the current
    // set, and whenever it is infeasible drop the guarantee with the shortest
    // streak (ties: the later-listed guarantee), until a feasible set is found
    // or only the base problem remains.
    var kept = [];
    for (var k = 0; k < G; k++) kept.push(true);
    while (true) {
      var mask = 0;
      for (var k2 = 0; k2 < G; k2++) if (kept[k2]) mask |= (1 << k2);
      attempts++;
      var fres = yield* runMask(mask);
      yield makeSnapshot(prog);
      if (fres && fres.best !== Infinity) {
        return { attempt: fres, mask: mask, attempts: attempts };
      }
      var anyKept = false;
      for (var kk = 0; kk < G; kk++) if (kept[kk]) anyKept = true;
      if (!anyKept) break;
      var dropIdx = -1, dropStreak = Infinity;
      for (var d = 0; d < G; d++) {
        if (!kept[d]) continue;
        var s = guarantees[d].streak;
        if (s < dropStreak || (s === dropStreak && d > dropIdx)) { dropStreak = s; dropIdx = d; }
      }
      if (dropIdx < 0) break;
      kept[dropIdx] = false;
    }
    return { attempt: { best: Infinity }, mask: -1, attempts: attempts };
  }

  // Build the report attached to a successful result.
  function buildGuaranteeReport(guarantees, fallback) {
    var keptMask = fallback ? fallback.mask : 0;
    var satisfied = [];
    var dropped = [];
    for (var g = 0; g < guarantees.length; g++) {
      var gu = guarantees[g];
      var base = { name: gu.name, dimension: gu.dimension, value: gu.value, streak: gu.streak };
      if (fallback && keptMask >= 0 && (keptMask & (1 << g))) {
        satisfied.push(base);
      } else {
        base.reason = 'could not be satisfied alongside the other guarantees, hard coverage, and no-work windows';
        dropped.push(base);
      }
    }
    return {
      owed: guarantees.map(function (g) {
        return { name: g.name, dimension: g.dimension, value: g.value, streak: g.streak };
      }),
      satisfied: satisfied,
      dropped: dropped,
      method: (guarantees.length > SUBSET_ENUM_MAX) ? 'greedy' : 'exact-subset',
      attempts: fallback ? fallback.attempts : 0
    };
  }

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  var Scheduler = {
    // constants / names
    DAYS: DAYS,
    SLOT_LETTERS: SLOT_LETTERS,
    HOURS_PER_DAY: HOURS_PER_DAY,
    DAYS_PER_WEEK: DAYS_PER_WEEK,
    HOURS_PER_WEEK: HOURS_PER_WEEK,
    PRIORITY_WEIGHT: PRIORITY_WEIGHT,
    SOFT_WEIGHT: SOFT_WEIGHT,
    DEFAULT_TIE_SEED: DEFAULT_TIE_SEED,
    ADJACENT_PAIRS: ADJACENT_PAIRS,

    // data
    config: config,
    defaultPeople: defaultPeople,

    // helpers
    mod: mod,
    pairKey: pairKey,
    rankOf: rankOf,
    personDutyHours: personDutyHours,

    // api
    computeSlots: computeSlots,
    buildCoverageGrid: buildCoverageGrid,
    meetsCoverage: meetsCoverage,
    satisfiesNoWorkWindow: satisfiesNoWorkWindow,
    scoreAssignment: scoreAssignment,
    solve: solve,
    solveAsync: solveAsync,

    // cross-run fairness (rotation)
    HISTORY_VERSION: HISTORY_VERSION,
    MAX_HISTORY_RUNS: MAX_HISTORY_RUNS,
    SUBSET_ENUM_MAX: SUBSET_ENUM_MAX,
    buildRunRecord: buildRunRecord,
    computeOwed: computeOwed,
    appendHistory: appendHistory
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Scheduler;
  else root.Scheduler = Scheduler;

})(typeof globalThis !== 'undefined' ? globalThis : this);

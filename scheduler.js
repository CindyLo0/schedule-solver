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
  var defaultPeople = [
    {
      name: 'Cindy',
      restOptions: [[0, 1]],
      shiftOptions: [4, 5], // E, F
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Inah',
      restOptions: [[4, 5]],
      shiftOptions: [4, 1], // E, B
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Daphine',
      restOptions: [[4, 5]],
      shiftOptions: [6, 5], // G, F
      priority: 'rest',
      noWorkWindow: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 }
    },
    {
      name: 'Bing',
      restOptions: [[4, 5]],
      shiftOptions: [0, 1, 2], // A, B, C
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Phoebe',
      restOptions: [[5, 6], [6, 0]], // Sat-Sun, Sun-Mon
      shiftOptions: [2, 3, 4], // C, D, E
      priority: 'rest',
      noWorkWindow: null
    },
    {
      name: 'Joan',
      restOptions: [[4, 5]],
      shiftOptions: [2, 1], // C, B
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'LA',
      restOptions: [[4, 5]],
      shiftOptions: [2, 1], // C, B
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Sherie',
      restOptions: [[6, 0]], // Sun-Mon
      shiftOptions: [2, 3], // C, D
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
  // Objective: minimise the weighted rank penalty (lower is better), subject
  // to (a) the hard coverage minimum on all 168 hours and (b) every person's
  // no-work window. Priority groups follow PROMPT.md:
  //   - locked: gave an exact start hour (slot fixed by the grid offset)
  //   - rest-priority: their rest-day pair comes from their ranked list
  //   - hour-priority: their slot must be one they listed; rest days are free
  //
  // Two phases: first enforce every rest-priority person's list. If that is
  // genuinely infeasible (proven by exhausting the space), relax rest-priority
  // people to any of the 7 pairs and let scoring attribute the compromise.

  var ADJACENT_PAIRS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0]];

  function hourRankFor(person, slotIndex, cfg) {
    return rankOf(person.shiftOptions, slotIndex, 'hours');
  }

  function listLengthFor(person, kind) {
    var list = kind === 'rest' ? person.restOptions : person.shiftOptions;
    return (list || []).length;
  }

  function personPenalty(person, slotIndex, restPair, pw, sw) {
    var priorityRank, softRank;
    if (person.priority === 'rest') {
      priorityRank = rankOf(person.restOptions, restPair, 'rest');
      softRank = hourRankFor(person, slotIndex);
    } else {
      priorityRank = hourRankFor(person, slotIndex);
      softRank = rankOf(person.restOptions, restPair, 'rest');
    }
    return pw * priorityRank + sw * softRank;
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

  // Cartesian product over a list of option arrays; cb receives one combined
  // array. Used for locked + rest-priority rest-day choices.
  function productOptions(optionLists, cb) {
    var n = optionLists.length;
    if (n === 0) { cb([]); return; }
    var cur = new Array(n);
    (function rec(i) {
      if (i === n) { cb(cur.slice()); return; }
      var list = optionLists[i];
      for (var j = 0; j < list.length; j++) {
        cur[i] = list[j];
        rec(i + 1);
      }
    })(0);
  }

  // All injective assignments of `people` (in order) into distinct `slots`.
  // Each result carries the priority-dimension penalty sum (pw * hour rank).
  function permutationsIntoSlots(people, slots, pw) {
    var n = people.length;
    var results = [];
    if (n > slots.length) return results;
    var used = new Array(slots.length).fill(false);
    var cur = new Array(n);
    (function rec(i, sum) {
      if (i === n) { results.push({ slots: cur.slice(), sum: sum }); return; }
      for (var s = 0; s < slots.length; s++) {
        if (used[s]) continue;
        used[s] = true;
        cur[i] = slots[s];
        rec(i + 1, sum + pw * hourRankFor(people[i], slots[s]));
        used[s] = false;
      }
    })(0, 0);
    return results;
  }

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

  // Builds, for one hour-priority person, their window-valid pairs at every
  // slot, each with its rest-day shift hours (the removed hours) and rest rank,
  // sorted by rank ascending.
  function buildHourOptions(person, cfg, slots) {
    var bySlot = [];
    for (var s = 0; s < cfg.numSlots; s++) {
      var slotStart = slots[s];
      var list = [];
      for (var i = 0; i < ADJACENT_PAIRS.length; i++) {
        var pair = ADJACENT_PAIRS[i];
        if (!satisfiesNoWorkWindow(person, slotStart, pair, cfg)) continue;
        list.push({
          pair: pair,
          rank: rankOf(person.restOptions, pair, 'rest'),
          hours: shiftedHoursOnDays(slotStart, pair, cfg)
        });
      }
      list.sort(function (a, b) { return a.rank - b.rank; });
      bySlot.push(list);
    }
    return bySlot;
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

  // Generator version of the rest-day walk. Every `yield` inside (including
  // the recursive DFS reached via `yield*`) carries a snapshot.
  function* bestRestComboGen(baseCounts, hourOptions, slots, cfg, sw, prog) {
    var k = slots.length;
    prog.restCombos++;
    prog.innerChecked++;
    if (k === 0) {
      return coverageOk(baseCounts, cfg.minCoverage) ? { soft: 0, pairs: [] } : null;
    }

    // Capacity: how many overlapping rest shifts each hour tolerates. A
    // negative capacity means already below the minimum before any rest.
    var capacity = new Int16Array(HOURS_PER_WEEK);
    for (var h = 0; h < HOURS_PER_WEEK; h++) {
      var c = baseCounts[h] - cfg.minCoverage;
      if (c < 0) return null;
      capacity[h] = c;
    }

    var options = new Array(k);
    for (var i = 0; i < k; i++) {
      options[i] = hourOptions[i][slots[i]];
      if (!options[i] || options[i].length === 0) return null;
    }

    // Admissible lower bound on the remaining bonus.
    var lb = new Array(k + 1);
    lb[k] = 0;
    for (var j = k - 1; j >= 0; j--) lb[j] = lb[j + 1] + options[j][0].rank;

    var removals = new Int16Array(HOURS_PER_WEEK);
    var bestBonus = Infinity;
    var bestPairs = null;
    var cur = new Array(k);

    function* dfs(idx, bonus) {
      if (idx === k) { bestBonus = bonus; bestPairs = cur.slice(); return; }
      if (bonus + sw * lb[idx] >= bestBonus) return;
      var list = options[idx];
      for (var x = 0; x < list.length; x++) {
        var opt = list[x];
        var newBonus = bonus + sw * opt.rank;
        if (newBonus + sw * lb[idx + 1] >= bestBonus) break; // ranks ascend
        var hrs = opt.hours;
        var ok = true;
        for (var m = 0; m < hrs.length; m++) {
          if (removals[hrs[m]] + 1 > capacity[hrs[m]]) { ok = false; break; }
        }
        if (!ok) continue;
        for (var n = 0; n < hrs.length; n++) removals[hrs[n]]++;
        cur[idx] = opt.pair;
        yield* dfs(idx + 1, newBonus);
        for (var q = 0; q < hrs.length; q++) removals[hrs[q]]--;
        yield* yieldTick(prog);
      }
    }

    yield* dfs(0, 0);

    if (!bestPairs) return null;
    return { soft: bestBonus, pairs: bestPairs };
  }

  // One full search pass, as a generator so it can be time-sliced. Returns
  // either a failure marker or the best result. `prog` carries both progress
  // counters and the run statistics.
  function* attemptGen(people, cfg, pw, sw, allowAllRestPriorityPairs, prog) {
    var counters = prog;
    var restPriority = [], hourPriority = [];
    people.forEach(function (p) {
      if (p.priority === 'rest') restPriority.push(p);
      else hourPriority.push(p);
    });

    // The grid is fixed: the eight slots always start at 0, 3, 6, ... 21.
    var offset = 0;
    var slots = computeSlots(cfg, 0);

    var available = [];
    for (var s = 0; s < cfg.numSlots; s++) available.push(s);

    var rpOptions = restPriority.map(function (p) {
      if (allowAllRestPriorityPairs) return ADJACENT_PAIRS;
      return (p.restOptions && p.restOptions.length) ? p.restOptions : ADJACENT_PAIRS;
    });

    // Optimistic lower bound on the hour-priority priority-dimension penalty,
    // used by branch-and-bound. Every hour-priority person could at best reach
    // their lowest-ranked reachable slot.
    var globalInnerLB = 0;
    hourPriority.forEach(function (p) {
      var best = Infinity;
      for (var si2 = 0; si2 < cfg.numSlots; si2++) {
        var r = hourRankFor(p, si2);
        if (r < best) best = r;
      }
      globalInnerLB += pw * best;
    });

    // 2. Enumerate outer arrangements: rest-priority slots + their rest-day
    //    choices. The rest-priority dimensions are requirements.
    var outers = [];
    (function recRestPriority(i, chosenSlots, chosenIdx) {
      if (i === restPriority.length) {
        productOptions(rpOptions, function (pairs) {
          var fixed = [];
          var penalty = 0;
          var windowsOk = true;
          for (var b = 0; b < restPriority.length; b++) {
            var p = restPriority[b], pair2 = pairs[b], slot = chosenSlots[b];
            fixed.push({ person: p, slotIndex: slot, slotStart: slots[slot], restDays: pair2 });
            penalty += personPenalty(p, slot, pair2, pw, sw);
            if (!satisfiesNoWorkWindow(p, slots[slot], pair2, cfg)) windowsOk = false;
          }
          var remaining = available.filter(function (sl) { return chosenSlots.indexOf(sl) < 0; });
          outers.push({ fixed: fixed, remaining: remaining, penalty: penalty, windowsOk: windowsOk });
        });
        return;
      }
      for (var sIdx = 0; sIdx < available.length; sIdx++) {
        if (chosenIdx.indexOf(sIdx) >= 0) continue;
        chosenIdx.push(sIdx);
        chosenSlots.push(available[sIdx]);
        recRestPriority(i + 1, chosenSlots, chosenIdx);
        chosenSlots.pop();
        chosenIdx.pop();
      }
    })(0, [], []);

    // Window-valid rest options for each hour-priority person at every slot,
    // computed once (used by the ordered rest-day walk).
    var hourOptions = hourPriority.map(function (p) { return buildHourOptions(p, cfg, slots); });

    // 5. Branch-and-bound: best outer arrangements first.
    outers.sort(function (a, b) { return a.penalty - b.penalty; });

    var best = Infinity;
    // All distinct top-scoring assignments seen so far, keyed by person->slot.
    var ties = new Map();

    // Build one canonical assignment (in slot order) for a candidate.
    function buildEntries(fixedList, permSlots, pairs) {
      var entries = [];
      fixedList.forEach(function (e) {
        entries.push({
          person: e.person, name: e.person.name, slotIndex: e.slotIndex,
          slotStart: e.slotStart, restDays: e.restDays.slice()
        });
      });
      for (var hi = 0; hi < hourPriority.length; hi++) {
        var hp = hourPriority[hi];
        entries.push({
          person: hp, name: hp.name, slotIndex: permSlots[hi],
          slotStart: slots[permSlots[hi]], restDays: pairs[hi].slice()
        });
      }
      entries.sort(function (a, b) { return a.slotIndex - b.slotIndex; });
      return entries;
    }

    // A key that depends only on who holds which slot (not on array order).
    function mapKey(fixedList, permSlots) {
      var pairs = [];
      fixedList.forEach(function (e) { pairs.push(e.person.name + ':' + e.slotIndex); });
      for (var hi = 0; hi < hourPriority.length; hi++) {
        pairs.push(hourPriority[hi].name + ':' + permSlots[hi]);
      }
      pairs.sort();
      return pairs.join('|');
    }

    function recordTie(fixedList, permSlots, pairs) {
      if (ties.size >= MAX_TIES) return;
      var key = mapKey(fixedList, permSlots);
      if (ties.has(key)) return;
      ties.set(key, { key: key, entries: buildEntries(fixedList, permSlots, pairs) });
    }

    prog.totalOuter = outers.length;

    for (var oi = 0; oi < outers.length; oi++) {
      var outer = outers[oi];
      counters.outers++;
      prog.outerChecked = counters.outers;
      prog.hasBest = best < Infinity;
      // Once per outer arrangement, always the same snapshot shape.
      yield makeSnapshot(prog);
      // Safe cut: outer penalty is non-decreasing along this sorted order and
      // globalInnerLB <= any actual inner penalty, so nothing later can beat or
      // tie the current best (strict > keeps equal-scoring arrangements).
      if (outer.penalty + globalInnerLB > best) break;
      if (!outer.windowsOk) continue;

      var outerBase = newCounts();
      outer.fixed.forEach(function (e) { addEntryCounts(outerBase, e.slotStart, e.restDays, cfg); });

      // 4. Hour-priority slot permutations, best satisfaction first.
      var perms = permutationsIntoSlots(hourPriority, outer.remaining, pw);
      perms.sort(function (a, b) { return a.sum - b.sum; });

      for (var pi = 0; pi < perms.length; pi++) {
        var perm = perms[pi];
        counters.innerPerms++;
        // Safe cut: perms are sorted, and rest-soft penalty is never negative.
        // Strict > so that equal-scoring permutations are still examined.
        if (outer.penalty + perm.sum > best) break;

        // Base counts assume every hour-priority person works all 7 days; the
        // rest-day walk then subtracts each chosen pair's 9-hour shifts.
        var base = outerBase.slice();
        for (var bi = 0; bi < hourPriority.length; bi++) {
          var allDays = personDutyHours(slots[perm.slots[bi]], [], cfg);
          for (var bh = 0; bh < allDays.length; bh++) base[allDays[bh]] += 1;
        }

        var combo = yield* bestRestComboGen(base, hourOptions, perm.slots, cfg, sw, prog);
        if (!combo) continue;
        var total = outer.penalty + perm.sum + combo.soft;
        if (total < best) {
          best = total;
          ties.clear();
          recordTie(outer.fixed, perm.slots, combo.pairs);
        } else if (total === best) {
          recordTie(outer.fixed, perm.slots, combo.pairs);
        }
      }
    }

    if (ties.size === 0) return { best: Infinity, counters: counters };

    return {
      best: best,
      ties: Array.from(ties.values()),
      counters: counters,
      offset: offset,
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

  // The whole solve (both phases) as a generator. Its yielded values are the
  // progress snapshots; its return value is the final result.
  function* solveGen(people, cfg, opts) {
    cfg = cfg || config;
    opts = opts || {};
    var pw = typeof opts.priorityWeight === 'number' ? opts.priorityWeight : PRIORITY_WEIGHT;
    var sw = typeof opts.softWeight === 'number' ? opts.softWeight : SOFT_WEIGHT;
    var t0 = Date.now();

    var prog = makeProgress('strict');
    prog.yieldEvery = (typeof opts.yieldEvery === 'number' && opts.yieldEvery > 0)
      ? opts.yieldEvery : YIELD_EVERY;
    var result = yield* attemptGen(people, cfg, pw, sw, false, prog);

    var phase = 'strict';
    if (result.best === Infinity) {
      // Fallback: relax rest-priority people to any of the 7 pairs.
      prog.phase = 'relaxed';
      prog.hasBest = false;
      result = yield* attemptGen(people, cfg, pw, sw, true, prog);
      phase = 'relaxed';
    }
    if (result.best === Infinity) return { ok: false, error: 'infeasible', elapsedMs: Date.now() - t0 };

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

    return {
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
      phase: phase,
      tie: tieInfo,
      stats: {
        outers: prog.outers,
        innerPerms: prog.innerPerms,
        restCombos: prog.restCombos,
        innerChecked: prog.innerChecked
      },
      elapsedMs: Date.now() - t0
    };
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
    solveAsync: solveAsync
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Scheduler;
  else root.Scheduler = Scheduler;

})(typeof globalThis !== 'undefined' ? globalThis : this);

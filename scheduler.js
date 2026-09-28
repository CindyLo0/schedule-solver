/* scheduler.js
 *
 * Pure scheduling logic for the Shift Coverage Solver.
 *
 * Zero DOM dependencies. This file runs unchanged under plain Node
 * (via require) and in the browser (as a global `Scheduler`).
 *
 * This is the "v3" engine:
 *   - 80/20 category-percentage scoring: each person's round score is
 *     0.8 * (priority points / their top priority weight) +
 *     0.2 * (soft points / their top soft weight), so every person's ideal
 *     round is exactly 1.0 and the total is 0..nPeople.
 *   - rotation debt: satisfaction is the recency-weighted average of past
 *     round scores; a person's weight is 1 + MU * (1 - satisfaction).
 *   - bounded fairness: pass 1 finds the exact maximum raw total under hard
 *     constraints; pass 2 maximises the weighted total subject to staying
 *     within a band of that maximum.
 *   - a rare circuit-breaker floor for a persistently unique worst-off
 *     person, outside the band.
 *
 * Everything is solved by an exhaustive generator search so it can be
 * time-sliced in the browser.
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

  // The seven consecutive rest-day pairs, in week order. restWeights is
  // aligned to this order (Mon-Tue ... Sun-Mon).
  var ADJACENT_PAIRS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0]];

  // 80/20 category split. A person's priority dimension counts this share of
  // their round score, the other dimension the rest. They sum to 1.
  var SPLIT_PRIORITY = 0.8;
  var SPLIT_SOFT = 0.2;

  var DEFAULT_TIE_SEED = 1;

  // ---------------------------------------------------------------------
  // Fairness tunables (exposed for tests/tools; calibrated in test-stage4)
  // ---------------------------------------------------------------------

  var FAIRNESS_MU = 50;           // how hard to pull a low-satisfaction person up
  var FAIRNESS_BAND = 0.10;       // allowed raw-total loss, as a fraction of max
  var DECAY_HALF_LIFE = 3;        // rounds after which a past run's weight halves

  var BREAKER_STREAK = 3;         // consecutive unique-dramatic-worst rounds
  var BREAKER_GAP = 0.20;         // shortfall lead over the next-worst person
  var BREAKER_RATIO = 3;          // OR at least 3x the next-worst shortfall
  var BREAKER_MIN_SHORTFALL = 0.20; // floor so trivial gaps never trip

  var HISTORY_VERSION = 3;
  var MAX_HISTORY_RUNS = 50;

  // Exact subset enumeration of simultaneous breaker guarantees is used up to
  // this many; beyond it a documented greedy drop kicks in.
  var SUBSET_ENUM_MAX = 12;

  // Small epsilon for float comparisons.
  var EPS = 1e-9;

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
  // Config and default dataset (transcribed from weighted.txt)
  // ---------------------------------------------------------------------

  var config = {
    shiftLen: 9,
    stagger: 3,
    minCoverage: 2,
    numSlots: 8
  };

  var defaultPeople = [
    {
      name: 'Cindy',
      shiftWeights: [9, 5, 12, 15, 20, 32, 7, 0],
      restWeights: [30, 7, 4, 22, 9, 12, 16],
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Inah',
      shiftWeights: [0, 3, 7, 35, 40, 10, 4, 1],
      restWeights: [5, 5, 5, 5, 30, 20, 30],
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Daphine',
      shiftWeights: [3, 0, 5, 10, 25, 20, 30, 7],
      restWeights: [7, 5, 3, 25, 35, 15, 10],
      priority: 'rest',
      noWorkWindow: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 }
    },
    {
      name: 'Bing',
      shiftWeights: [40, 15, 25, 10, 2, 1, 0, 7],
      restWeights: [1, 3, 2, 4, 30, 40, 20],
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Phoebe',
      shiftWeights: [5, 10, 40, 30, 10, 3, 2, 0],
      restWeights: [5, 5, 5, 5, 20, 40, 20],
      priority: 'rest',
      noWorkWindow: null
    },
    {
      name: 'Joan',
      shiftWeights: [10, 25, 40, 15, 4, 3, 2, 1],
      restWeights: [1, 3, 2, 4, 20, 40, 30],
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'LA',
      shiftWeights: [5, 35, 25, 20, 10, 3, 2, 0],
      restWeights: [10, 5, 5, 10, 20, 30, 20],
      priority: 'hours',
      noWorkWindow: null
    },
    {
      name: 'Sherie',
      shiftWeights: [3, 0, 35, 30, 15, 7, 6, 4],
      restWeights: [0, 5, 3, 8, 9, 35, 40],
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
    var a = pair[0];
    var b = pair[1];
    return a <= b ? a + ',' + b : b + ',' + a;
  }

  function maxOf(arr) {
    var m = -Infinity;
    for (var i = 0; i < (arr || []).length; i++) {
      if (arr[i] > m) m = arr[i];
    }
    return m;
  }

  function topOf(arr) {
    var m = maxOf(arr);
    return (m === -Infinity || m < 0) ? 0 : m;
  }

  // Index of the largest value in a weights array, or -1 when nothing is
  // strictly positive.
  function topOptionIndex(weights) {
    weights = weights || [];
    var wi = -1, best = 0;
    for (var i = 0; i < weights.length; i++) {
      if (weights[i] > best) { best = weights[i]; wi = i; }
    }
    return wi;
  }

  // ---------------------------------------------------------------------
  // Slot math and duty hours
  // ---------------------------------------------------------------------

  function computeSlots(cfg, offset) {
    cfg = cfg || config;
    offset = offset || 0;
    var slots = [];
    for (var i = 0; i < cfg.numSlots; i++) {
      slots.push(mod(offset + i * cfg.stagger, HOURS_PER_DAY));
    }
    return slots;
  }

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

  function entrySlotStart(entry, assignment, cfg) {
    if (entry && typeof entry.slotStart === 'number') return entry.slotStart;
    var slots = assignment && assignment.slots;
    if (slots && typeof entry.slotIndex === 'number') return slots[entry.slotIndex];
    throw new Error('Assignment entry has neither slotStart nor a resolvable slotIndex');
  }

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

  function satisfiesNoWorkWindow(person, slotStart, restDays, cfg) {
    var win = person && person.noWorkWindow;
    if (!win) return true;
    cfg = cfg || config;

    var start = win.startDay * HOURS_PER_DAY + win.startHour;
    var end = win.endDay * HOURS_PER_DAY + win.endHour;
    if (end <= start) end += HOURS_PER_WEEK;

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
  // Effective weights
  // ---------------------------------------------------------------------
  //
  // Anyone with a truthy no-work window has BOTH of their dimensions
  // flattened to equal weights: every slot is worth 100/numSlots and every
  // rest pair 100/numRestPairs. Flattening is enforced here so no other part
  // of the engine can bypass it, and all solving/scoring/history uses it.
  // The window itself remains a hard feasibility filter.

  function effectiveWeights(person, cfg) {
    cfg = cfg || config;
    if (!person) return person;
    if (!person.noWorkWindow) {
      return {
        name: person.name,
        shiftWeights: person.shiftWeights,
        restWeights: person.restWeights,
        priority: person.priority,
        noWorkWindow: null,
        windowed: false
      };
    }
    var nSlots = cfg.numSlots;
    var nPairs = ADJACENT_PAIRS.length;
    var sw = [];
    for (var i = 0; i < nSlots; i++) sw.push(100 / nSlots);
    var rw = [];
    for (var j = 0; j < nPairs; j++) rw.push(100 / nPairs);
    return {
      name: person.name,
      shiftWeights: sw,
      restWeights: rw,
      priority: person.priority,
      noWorkWindow: person.noWorkWindow,
      windowed: true
    };
  }

  function effectivePeople(people, cfg) {
    cfg = cfg || config;
    return (people || []).map(function (p) { return effectiveWeights(p, cfg); });
  }

  // ---------------------------------------------------------------------
  // Scoring: the 80/20 category-percentage model
  // ---------------------------------------------------------------------
  //
  // For a person:
  //   topP = the largest weight on their priority dimension
  //   topS = the largest weight on the other dimension
  //   priorityPct = topP > 0 ? priorityPoints / topP : 1
  //   softPct     = topS > 0 ? softPoints     / topS : 1
  //   roundScore  = 0.8 * priorityPct + 0.2 * softPct
  // which is exactly 1.0 when they get their own top pick on both dimensions
  // (and always 1.0 for a flattened window-holder). HIGHER is BETTER.
  //
  // Because topP/topS are fixed per person per round, roundScore is a linear
  // function of the slot points and rest points, so the whole objective is
  // additive (separable) across people.

  function weightOf(weightsArray, value, kind) {
    weightsArray = weightsArray || [];
    if (kind === 'rest') {
      var key = pairKey(value);
      for (var i = 0; i < ADJACENT_PAIRS.length; i++) {
        if (pairKey(ADJACENT_PAIRS[i]) === key) {
          var rv = weightsArray[i];
          return typeof rv === 'number' ? rv : 0;
        }
      }
      return 0;
    }
    var v = weightsArray[value];
    return typeof v === 'number' ? v : 0;
  }

  // Per-person scoring coefficients derived from the effective weights.
  // roundScore = baseConst + slotCoef * slotPoints + restCoef * restPoints.
  function personCoeffs(person, cfg) {
    var e = effectiveWeights(person, cfg);
    var topShift = topOf(e.shiftWeights);
    var topRest = topOf(e.restWeights);
    var priTop = (person.priority === 'rest') ? topRest : topShift;
    var softTop = (person.priority === 'rest') ? topShift : topRest;

    var priCoef = priTop > 0 ? SPLIT_PRIORITY / priTop : 0;
    var priConst = priTop > 0 ? 0 : SPLIT_PRIORITY;
    var softCoef = softTop > 0 ? SPLIT_SOFT / softTop : 0;
    var softConst = softTop > 0 ? 0 : SPLIT_SOFT;

    var slotCoef, restCoef;
    if (person.priority === 'rest') {
      slotCoef = softCoef;
      restCoef = priCoef;
    } else {
      slotCoef = priCoef;
      restCoef = softCoef;
    }

    return {
      baseConst: priConst + softConst,
      slotCoef: slotCoef,
      restCoef: restCoef,
      priTop: priTop,
      softTop: softTop,
      topShift: topShift,
      topRest: topRest,
      windowed: !!person.noWorkWindow
    };
  }

  function scoreFromCoeffs(co, slotPoints, restPoints) {
    return co.baseConst + co.slotCoef * slotPoints + co.restCoef * restPoints;
  }

  // Category percentages for one assignment detail.
  function percentOf(person, co, slotPoints, restPoints) {
    var priorityPoints = (person.priority === 'rest') ? restPoints : slotPoints;
    var softPoints = (person.priority === 'rest') ? slotPoints : restPoints;
    var priorityPct = co.priTop > 0 ? priorityPoints / co.priTop : 1;
    var softPct = co.softTop > 0 ? softPoints / co.softTop : 1;
    return {
      priorityPoints: priorityPoints,
      softPoints: softPoints,
      priorityPct: priorityPct,
      softPct: softPct
    };
  }

  // Sum of roundScore over the people in `assignment` (0..nPeople).
  // Each entry must carry `person`.
  function scoreAssignment(assignment, cfg, opts) {
    cfg = cfg || config;
    var entries = Array.isArray(assignment) ? assignment : (assignment.entries || []);
    var total = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var p = entry.person;
      if (!p) throw new Error('scoreAssignment needs entry.person for each entry');
      var e = effectiveWeights(p, cfg);
      var slotPoints = weightOf(e.shiftWeights, entry.slotIndex, 'hours');
      var restPoints = weightOf(e.restWeights, entry.restDays, 'rest');
      total += scoreFromCoeffs(personCoeffs(p, cfg), slotPoints, restPoints);
    }
    return total;
  }

  // Recency weight of a run that is `age` rounds old (current round = 0).
  function recencyWeight(age) {
    return Math.pow(0.5, age / DECAY_HALF_LIFE);
  }

  // ---------------------------------------------------------------------
  // Rest options and coverage helpers
  // ---------------------------------------------------------------------

  // Hours removed from the "everyone works all week" baseline when the listed
  // days are taken as rest (the shifts that start on those days).
  function shiftedHoursOnDays(slotStart, days, cfg) {
    var out = [];
    for (var i = 0; i < days.length; i++) {
      var start = mod(days[i], DAYS_PER_WEEK) * HOURS_PER_DAY + slotStart;
      for (var k = 0; k < cfg.shiftLen; k++) out.push(mod(start + k, HOURS_PER_WEEK));
    }
    return out;
  }

  // Window-safe rest pairs at a slot, most-wanted first. A forced pair (from
  // a breaker guarantee) restricts the list to that single pair.
  function restOptionsAt(person, slotStart, cfg, forcedPair) {
    var list = [];
    for (var i = 0; i < ADJACENT_PAIRS.length; i++) {
      var pair = ADJACENT_PAIRS[i];
      if (forcedPair && pairKey(pair) !== pairKey(forcedPair)) continue;
      if (!satisfiesNoWorkWindow(person, slotStart, pair, cfg)) continue;
      list.push({
        pair: pair,
        points: weightOf(person.restWeights, pair, 'rest'),
        hours: shiftedHoursOnDays(slotStart, pair, cfg)
      });
    }
    list.sort(function (a, b) { return b.points - a.points; });
    return list;
  }

  function factorial(m) { var f = 1; for (var z = 2; z <= m; z++) f *= z; return f; }

  // ---------------------------------------------------------------------
  // Progress reporting
  // ---------------------------------------------------------------------
  // IMPORTANT: every generator yields the SAME shape of progress object,
  // including nested ones reached via `yield*`. A bare `yield;` would hand
  // `undefined` to the async driver, so it never appears here.

  var YIELD_EVERY = 40000;

  function makeSnapshot(prog) {
    return {
      outerChecked: prog.outerChecked,
      totalOuter: prog.totalOuter,
      innerChecked: prog.innerChecked,
      hasBest: prog.hasBest,
      phase: prog.phase
    };
  }

  function* yieldTick(prog) {
    prog.work++;
    if (prog.work - prog.lastYield >= prog.yieldEvery) {
      prog.lastYield = prog.work;
      yield makeSnapshot(prog);
    }
  }

  function makeProgress(phase) {
    return {
      outerChecked: 0,
      totalOuter: 0,
      innerChecked: 0,
      hasBest: false,
      phase: phase,
      outers: 0,
      innerPerms: 0,
      restCombos: 0,
      work: 0,
      lastYield: 0,
      yieldEvery: YIELD_EVERY
    };
  }

  // ---------------------------------------------------------------------
  // The exhaustive search
  // ---------------------------------------------------------------------
  //
  // The objective is additive per person, so for a fixed slot permutation the
  // best rest pairs form a small separable search. `ctx` carries:
  //   weighted=false, bandFloor=-Infinity  -> pass 1, maximise raw total.
  //   weighted=true,  bandFloor=<floor>    -> pass 2, maximise
  //        SUM personWeight * roundScore subject to raw >= floor.
  //
  // Bounds are admissible upper bounds on the remaining rest contributions,
  // so the separable search stays exact. Options are sorted by rest points
  // descending, and every coefficient is positive, so once a bound fails for
  // one option every later option fails too and we can `break`.

  // Compare two satisfaction vectors "lift the lowest first". Returns >0 when
  // `a` is strictly better.
  function compareSatVectors(a, b) {
    var sa = a.slice().sort(function (x, y) { return x - y; });
    var sb = b.slice().sort(function (x, y) { return x - y; });
    for (var i = 0; i < sa.length; i++) {
      if (sa[i] > sb[i] + EPS) return 1;
      if (sa[i] < sb[i] - EPS) return -1;
    }
    return 0;
  }

  function satisfactionVec(ctx, scores) {
    var n = scores.length;
    var vec = new Array(n);
    for (var i = 0; i < n; i++) {
      vec[i] = (ctx.satNum[i] + scores[i]) / (ctx.satDen[i] + 1);
    }
    return vec;
  }

  // Offer one complete assignment to the running champion.
  function considerChampion(ctx, slotOf, pairs, raw, objective, satVec) {
    var champ = ctx.champion;
    if (!champ) {
      ctx.champion = {
        slotOf: slotOf.slice(),
        pairs: pairs.slice(),
        raw: raw,
        objective: objective,
        sat: satVec,
        count: 1
      };
      if (ctx.tieSample.length < ctx.tieSampleMax) {
        ctx.tieSample.push(slotOf.slice());
      }
      return;
    }
    if (objective > champ.objective + EPS) {
      ctx.champion = {
        slotOf: slotOf.slice(),
        pairs: pairs.slice(),
        raw: raw,
        objective: objective,
        sat: satVec,
        count: 1
      };
      ctx.tieSample = [slotOf.slice()];
      return;
    }
    if (objective < champ.objective - EPS) return;

    // Equal objective: prefer the vector that lifts the lowest satisfaction.
    var cmp = compareSatVectors(satVec, champ.sat);
    if (cmp > 0) {
      ctx.champion = {
        slotOf: slotOf.slice(),
        pairs: pairs.slice(),
        raw: raw,
        objective: objective,
        sat: satVec,
        count: 1
      };
      ctx.tieSample = [slotOf.slice()];
      return;
    }
    if (cmp < 0) return;

    // Exactly equal: reservoir sampling among the true top set, O(1) memory.
    champ.count++;
    if (ctx.tieSample.length < ctx.tieSampleMax) ctx.tieSample.push(slotOf.slice());
    if (ctx.rand() < 1 / champ.count) {
      champ.slotOf = slotOf.slice();
      champ.pairs = pairs.slice();
      champ.raw = raw;
      champ.sat = satVec;
    }
  }

  // Evaluate one full slot assignment: choose rest pairs with the objective.
  // Generator so progress flows through.
  function* evaluateSlots(ctx, people, slotOf, slots, cfg, prog) {
    var n = people.length;
    var coeffs = ctx.coeffs;
    var personWeight = ctx.personWeight;
    var weighted = ctx.weighted;
    var bandFloor = ctx.bandFloor;

    var opts = new Array(n);
    var slotConst = new Array(n);   // includes base constant + slot contribution
    var slotWConst = new Array(n);  // personWeight * slotConst
    var bestScore = new Array(n);

    for (var i = 0; i < n; i++) {
      var p = people[i];
      var forced = (ctx.owed && ctx.owed[i] && ctx.owed[i].pair) ? ctx.owed[i].pair : null;
      var list = restOptionsAt(p, slots[slotOf[i]], cfg, forced);
      if (list.length === 0) return; // window makes this slot unusable
      opts[i] = list;

      var sp = weightOf(p.shiftWeights, slotOf[i], 'hours');
      slotConst[i] = coeffs[i].baseConst + coeffs[i].slotCoef * sp;
      slotWConst[i] = personWeight[i] * slotConst[i];
      bestScore[i] = slotConst[i] + coeffs[i].restCoef * list[0].points;
    }

    // Coverage capacity: how many rest-shifts each hour can absorb.
    var base = new Int16Array(HOURS_PER_WEEK);
    for (var i2 = 0; i2 < n; i2++) {
      var all = personDutyHours(slots[slotOf[i2]], [], cfg);
      for (var a = 0; a < all.length; a++) base[all[a]] += 1;
    }
    var capacity = new Int16Array(HOURS_PER_WEEK);
    for (var h = 0; h < HOURS_PER_WEEK; h++) {
      var c = base[h] - cfg.minCoverage;
      if (c < 0) return; // even with nobody resting, coverage is impossible
      capacity[h] = c;
    }

    var constSum = 0, wConstSum = 0, constSumScore = 0;
    for (var s = 0; s < n; s++) {
      constSum += slotConst[s];
      wConstSum += slotWConst[s];
      constSumScore += bestScore[s];
    }

    // Optimistic bound for this whole slot assignment.
    var optRaw = constSumScore;
    var optObj = weighted ? wConstSum : optRaw;
    if (weighted) {
      optObj = 0;
      for (var o = 0; o < n; o++) optObj += personWeight[o] * bestScore[o];
    }
    if (bandFloor > -Infinity && optRaw < bandFloor - EPS) return;
    if (ctx.champion && optObj < ctx.champion.objective - EPS) return;

    // Branch-and-bound tables for the rest DFS.
    var ubScore = new Array(n + 1);
    var ubObj = new Array(n + 1);
    ubScore[n] = 0;
    ubObj[n] = 0;
    for (var b = n - 1; b >= 0; b--) {
      var restMax = coeffs[b].restCoef * opts[b][0].points;
      ubScore[b] = ubScore[b + 1] + restMax;
      ubObj[b] = ubObj[b + 1] + (weighted ? personWeight[b] : 1) * restMax;
    }

    prog.restCombos++;

    var removals = new Int16Array(HOURS_PER_WEEK);
    var curPoints = new Array(n);
    var curPairs = new Array(n);

    function* dfs(idx, raw, obj) {
      if (idx === n) {
        prog.innerChecked++;
        if (bandFloor > -Infinity && raw < bandFloor - EPS) return;
        var scores = new Array(n);
        for (var r = 0; r < n; r++) {
          scores[r] = slotConst[r] + coeffs[r].restCoef * curPoints[r];
        }
        var satVec = satisfactionVec(ctx, scores);
        considerChampion(ctx, slotOf, curPairs, raw, obj, satVec);
        return;
      }

      if (bandFloor > -Infinity && raw + ubScore[idx] < bandFloor - EPS) return;
      if (ctx.champion && obj + ubObj[idx] < ctx.champion.objective - EPS) return;

      var list = opts[idx];
      for (var x = 0; x < list.length; x++) {
        prog.innerChecked++;
        var opt = list[x];

        var nraw = raw + coeffs[idx].restCoef * opt.points;
        var nobj = obj + (weighted ? personWeight[idx] : 1) * coeffs[idx].restCoef * opt.points;

        if (bandFloor > -Infinity && nraw + ubScore[idx + 1] < bandFloor - EPS) break;
        if (ctx.champion && nobj + ubObj[idx + 1] < ctx.champion.objective - EPS) break;

        var hrs = opt.hours;
        var ok = true;
        for (var m = 0; m < hrs.length; m++) {
          if (removals[hrs[m]] + 1 > capacity[hrs[m]]) { ok = false; break; }
        }
        if (!ok) continue;

        for (var a2 = 0; a2 < hrs.length; a2++) removals[hrs[a2]]++;
        curPoints[idx] = opt.points;
        curPairs[idx] = opt.pair;
        yield* dfs(idx + 1, nraw, nobj);
        for (var u = 0; u < hrs.length; u++) removals[hrs[u]]--;
        yield* yieldTick(prog);
      }
    }

    yield* dfs(0, constSum, wConstSum);
  }

  // One search pass over the whole open domain.
  function* searchGen(people, cfg, ctx) {
    var prog = ctx.prog;
    var n = people.length;
    var slots = computeSlots(cfg, 0);

    var fixed = new Array(n);
    var usedInit = new Array(cfg.numSlots).fill(false);
    var clash = false;
    for (var i = 0; i < n; i++) {
      fixed[i] = null;
      if (ctx.owed && ctx.owed[i] && ctx.owed[i].slot != null) {
        if (usedInit[ctx.owed[i].slot]) clash = true;
        else usedInit[ctx.owed[i].slot] = true;
        fixed[i] = ctx.owed[i].slot;
      }
    }
    if (clash) return;

    var freeIdx = [], freeSlots = [];
    for (var k = 0; k < n; k++) if (fixed[k] == null) freeIdx.push(k);
    for (var s = 0; s < cfg.numSlots; s++) if (!usedInit[s]) freeSlots.push(s);
    if (freeIdx.length !== freeSlots.length) return;

    prog.totalOuter = factorial(freeSlots.length);

    var slotOf = new Array(n);
    for (var f = 0; f < n; f++) if (fixed[f] != null) slotOf[f] = fixed[f];

    function* perm(ci, usedMask) {
      if (ci === freeIdx.length) {
        prog.innerPerms++;
        prog.outers++;
        prog.outerChecked = prog.outers;
        prog.hasBest = !!ctx.champion;
        yield makeSnapshot(prog);
        yield* evaluateSlots(ctx, people, slotOf, slots, cfg, prog);
        return;
      }
      var idx = freeIdx[ci];
      for (var si = 0; si < freeSlots.length; si++) {
        if (usedMask & (1 << si)) continue;
        slotOf[idx] = freeSlots[si];
        yield* perm(ci + 1, usedMask | (1 << si));
      }
    }

    yield* perm(0, 0);
  }

  // ---------------------------------------------------------------------
  // History / rotation debt (version 3)
  // ---------------------------------------------------------------------
  //
  //   history = {
  //     version: 3,
  //     runs: [ runRecord, ... ],
  //     fingerprints: { "<name>": "<pref fingerprint>" },
  //     breaker: { "<name>": { worstStreak: <n> } }
  //   }
  //
  //   runRecord = {
  //     at: <ISO string>,
  //     entries: [ { name, priorityPct, softPct, score, slotPoints,
  //                  restPoints, priorityPoints, softPoints, windowed } ]
  //   }
  //
  // satisfaction_i  = recency-weighted average of past roundScore_i
  // debt_i          = 1 - satisfaction_i
  // personWeight_i  = 1 + MU * debt_i

  function emptyHistory() {
    return { version: HISTORY_VERSION, runs: [], fingerprints: {}, breaker: {} };
  }

  function fingerprintOf(person, cfg) {
    var e = effectiveWeights(person, cfg);
    return (e.priority || '') + '|' + e.shiftWeights.join(',') + '|' +
      e.restWeights.join(',') + '|' + (person.noWorkWindow ? 'W' : 'N');
  }

  function removeNameFromRuns(history, name) {
    for (var i = 0; i < history.runs.length; i++) {
      var run = history.runs[i];
      run.entries = (run.entries || []).filter(function (e) { return e.name !== name; });
    }
  }

  // Pre-run fairness state. Applies fingerprint resets (mutating history) and
  // returns per-person derived debt plus any tripped breaker guarantees.
  function computeFairness(history, people, cfg, mu) {
    cfg = cfg || config;
    if (typeof mu !== 'number') mu = FAIRNESS_MU;
    if (!history || history.version !== HISTORY_VERSION) history = emptyHistory();
    if (!history.runs) history.runs = [];
    if (!history.fingerprints) history.fingerprints = {};
    if (!history.breaker) history.breaker = {};

    var present = {};
    people.forEach(function (p) { present[p.name] = true; });

    // Removed people: drop their history entirely.
    Object.keys(history.fingerprints).forEach(function (n) {
      if (!present[n]) {
        delete history.fingerprints[n];
        delete history.breaker[n];
        removeNameFromRuns(history, n);
      }
    });

    // Changed fingerprints: reset that person's history only. A missing
    // fingerprint means a brand-new person, who simply has no history yet.
    people.forEach(function (p) {
      var fp = fingerprintOf(p, cfg);
      var stored = history.fingerprints[p.name];
      if (stored != null && stored !== fp) {
        delete history.breaker[p.name];
        removeNameFromRuns(history, p.name);
      }
      history.fingerprints[p.name] = fp;
    });

    var runs = history.runs;
    var L = runs.length;

    var entries = [];
    var satNum = [];
    var satDen = [];
    var personWeight = [];
    var worstName = null;
    var worstShortfall = -Infinity;
    var hasDebt = false;

    people.forEach(function (p) {
      var num = 0, den = 0;
      for (var r = 0; r < L; r++) {
        var age = L - r; // the current (not-yet-recorded) round is age 0
        var w = recencyWeight(age);
        var run = runs[r];
        var found = null;
        for (var e = 0; e < (run.entries || []).length; e++) {
          if (run.entries[e].name === p.name) { found = run.entries[e]; break; }
        }
        if (found && typeof found.score === 'number') { num += w * found.score; den += w; }
      }
      var satisfaction = den === 0 ? 1 : num / den;
      var shortfall = 1 - satisfaction;
      var debt = 1 - satisfaction;
      var weight = 1 + mu * debt;
      if (debt > EPS) hasDebt = true;
      if (shortfall > worstShortfall) { worstShortfall = shortfall; worstName = p.name; }

      satNum.push(num);
      satDen.push(den);
      personWeight.push(weight);

      entries.push({
        name: p.name,
        satisfaction: satisfaction,
        shortfall: shortfall,
        debt: debt,
        personWeight: weight,
        rounds: den,
        windowed: !!p.noWorkWindow
      });
    });

    // Tripped breakers. Window people never trip (their satisfaction is ~1).
    var breaker = [];
    people.forEach(function (p) {
      if (p.noWorkWindow) return;
      var rec = history.breaker[p.name];
      var ws = (rec && typeof rec.worstStreak === 'number') ? rec.worstStreak : 0;
      if (ws >= BREAKER_STREAK) {
        var dimension = (p.priority === 'hours') ? 'slot' : 'rest';
        var value;
        if (dimension === 'slot') value = topOptionIndex(effectiveWeights(p, cfg).shiftWeights);
        else value = ADJACENT_PAIRS[topOptionIndex(effectiveWeights(p, cfg).restWeights)];
        breaker.push({
          name: p.name,
          dimension: dimension,
          value: value,
          streak: ws,
          reason: ws + ' consecutive rounds as the unique worst-off person, far behind everyone else'
        });
      }
    });

    return {
      entries: entries,
      worstName: worstName,
      worstShortfall: worstShortfall === -Infinity ? 0 : worstShortfall,
      breaker: breaker,
      hasDebt: hasDebt,
      satNum: satNum,
      satDen: satDen,
      personWeight: personWeight
    };
  }

  // Snapshot one run's scores per person.
  function buildRunRecord(assignment, people, cfg) {
    cfg = cfg || config;
    var byName = {};
    (people || []).forEach(function (p) { byName[p.name] = p; });
    var list = Array.isArray(assignment)
      ? assignment
      : (assignment && assignment.assignment) || [];

    var entries = list.map(function (a) {
      var p = byName[a.name];
      var e = effectiveWeights(p, cfg);
      var sp = weightOf(e.shiftWeights, a.slotIndex, 'hours');
      var rp = weightOf(e.restWeights, a.restDays, 'rest');
      var co = personCoeffs(p, cfg);
      var pcts = percentOf(p, co, sp, rp);
      return {
        name: a.name,
        priorityPct: pcts.priorityPct,
        softPct: pcts.softPct,
        score: scoreFromCoeffs(co, sp, rp),
        slotPoints: sp,
        restPoints: rp,
        priorityPoints: pcts.priorityPoints,
        softPoints: pcts.softPoints,
        windowed: !!p.noWorkWindow
      };
    });

    return { at: new Date().toISOString(), entries: entries };
  }

  // Per-run worstness. A person's one-round satisfaction is their recorded
  // roundScore (already 0..1). With the worst shortfall `w` and the next-worst
  // shortfall `n`, the gap is dramatic when it clears the floor and is either
  // BREAKER_GAP ahead of `n`, or at least BREAKER_RATIO times `n`.
  function runWorstness(run) {
    var entries = (run && run.entries) || [];
    var worstVal = -Infinity, secondVal = -Infinity, worstName = null, worstTies = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var score = (typeof e.score === 'number') ? e.score : 1;
      var sh = 1 - score;
      if (sh > worstVal + EPS) { secondVal = worstVal; worstVal = sh; worstName = e.name; worstTies = 1; }
      else if (Math.abs(sh - worstVal) <= EPS) { worstTies++; }
      else if (sh > secondVal) { secondVal = sh; }
    }
    var unique = (worstTies === 1) && (worstName !== null);
    var w = (worstVal === -Infinity) ? 0 : worstVal;
    var n = (secondVal === -Infinity) ? Infinity : secondVal;
    var dramatic = unique &&
      (w >= BREAKER_MIN_SHORTFALL - EPS) &&
      ((w - n) >= BREAKER_GAP - EPS || w >= BREAKER_RATIO * n - EPS);
    return { worstName: worstName, worstShortfall: w, unique: unique, dramatic: dramatic };
  }

  // Fold one run into the history, recomputing breaker streaks and capping the
  // run list. Immutable: returns a new history object.
  //
  // A person's streak is recomputed deterministically from the recorded runs:
  // the number of consecutive trailing runs (ending at the most recent) in
  // which they were the unique dramatic worst. This self-heals and means
  // existing recorded runs count immediately. A manually-seeded streak (used
  // when an infeasible guarantee is dropped and has to carry) is preserved and
  // extended by one only while that person remains the newest unique dramatic
  // worst.
  function appendHistory(history, runRecord) {
    if (!history || history.version !== HISTORY_VERSION) history = emptyHistory();
    var runs = (history.runs || []).concat([runRecord]);
    if (runs.length > MAX_HISTORY_RUNS) runs = runs.slice(runs.length - MAX_HISTORY_RUNS);

    var out = {
      version: HISTORY_VERSION,
      runs: runs,
      fingerprints: {},
      breaker: {}
    };
    var fpKeys = Object.keys(history.fingerprints || {});
    for (var f = 0; f < fpKeys.length; f++) out.fingerprints[fpKeys[f]] = history.fingerprints[fpKeys[f]];

    var L = runs.length;
    var worstPerRun = [];
    for (var r = 0; r < L; r++) worstPerRun.push(runWorstness(runs[r]));

    var newestDramaticWorst = (L > 0) ? worstPerRun[L - 1].worstName : null;
    var newestIsDramatic = (L > 0) && worstPerRun[L - 1].dramatic;

    var names = [];
    var seen = {};
    for (var n = 0; n < L; n++) {
      var ents = runs[n].entries || [];
      for (var q = 0; q < ents.length; q++) {
        if (!seen[ents[q].name]) { seen[ents[q].name] = true; names.push(ents[q].name); }
      }
    }

    var oldBreaker = history.breaker || {};
    for (var ni = 0; ni < names.length; ni++) {
      var name = names[ni];
      var trailing = 0;
      for (var ri = L - 1; ri >= 0; ri--) {
        if (worstPerRun[ri].dramatic && worstPerRun[ri].worstName === name) trailing++;
        else break;
      }
      var prior = (oldBreaker[name] && typeof oldBreaker[name].worstStreak === 'number')
        ? oldBreaker[name].worstStreak : 0;
      var streak = trailing;
      if (newestIsDramatic && name === newestDramaticWorst && prior + 1 > streak) {
        streak = prior + 1;
      }
      if (streak > 0 || (name in oldBreaker)) out.breaker[name] = { worstStreak: streak };
    }
    // Keep explicit zeros for people who had a breaker record before.
    Object.keys(oldBreaker).forEach(function (nm) {
      if (!(nm in out.breaker)) out.breaker[nm] = { worstStreak: 0 };
    });

    return out;
  }

  // ---------------------------------------------------------------------
  // History file import/export helpers
  // ---------------------------------------------------------------------
  // Purely additive. Pure and DOM-free: none of these mutate their arguments.

  var HISTORY_KIND = 'shift-solver-fairness';

  // Validate a parsed JSON value as a history file. Accepts a raw history
  // object, or a wrapper (from exportHistory) that carries it under `.history`.
  // Returns { ok: true, history } or { ok: false, error }.
  function validateHistoryFile(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'The file is not a JSON object.' };
    }

    var h = (obj.history && typeof obj.history === 'object' && !Array.isArray(obj.history))
      ? obj.history : obj;

    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      return { ok: false, error: 'No history object was found in the file.' };
    }
    if (h.version !== HISTORY_VERSION) {
      return {
        ok: false,
        error: 'Unsupported history version: the file says ' + String(h.version) +
          ', but this tool expects version ' + String(HISTORY_VERSION) + '.'
      };
    }
    if (!Array.isArray(h.runs)) {
      return { ok: false, error: 'The history "runs" value is not an array.' };
    }
    for (var r = 0; r < h.runs.length; r++) {
      var run = h.runs[r];
      if (!run || typeof run !== 'object' || Array.isArray(run)) {
        return { ok: false, error: 'Run ' + (r + 1) + ' is not an object.' };
      }
      if (!Array.isArray(run.entries)) {
        return { ok: false, error: 'Run ' + (r + 1) + ' is missing an "entries" array.' };
      }
      for (var e = 0; e < run.entries.length; e++) {
        var entry = run.entries[e];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return { ok: false, error: 'Run ' + (r + 1) + ' entry ' + (e + 1) + ' is not an object.' };
        }
        if (typeof entry.name !== 'string') {
          return { ok: false, error: 'Run ' + (r + 1) + ' entry ' + (e + 1) + ' has a non-string name.' };
        }
        if (typeof entry.score !== 'number' || !isFinite(entry.score)) {
          return { ok: false, error: 'Run ' + (r + 1) + ' entry ' + (e + 1) + ' has a non-numeric score.' };
        }
        if (entry.score < 0 || entry.score > 1) {
          return {
            ok: false,
            error: 'Run ' + (r + 1) + ' entry ' + (e + 1) + ' has a score of ' + entry.score +
              ', which is outside the allowed 0..1 range.'
          };
        }
      }
    }
    if (h.fingerprints != null &&
        (typeof h.fingerprints !== 'object' || Array.isArray(h.fingerprints))) {
      return { ok: false, error: 'The history "fingerprints" value must be an object.' };
    }
    if (h.breaker != null &&
        (typeof h.breaker !== 'object' || Array.isArray(h.breaker))) {
      return { ok: false, error: 'The history "breaker" value must be an object.' };
    }

    return { ok: true, history: h };
  }

  // Build a plain, display-ready summary of a history file against the current
  // team. Satisfaction/debt are computed on a deep clone, so the live history
  // is never mutated. `exportedAt` is optional and echoed back when supplied.
  function historySummary(history, people, cfg, exportedAt) {
    people = people || [];
    var clone = history ? JSON.parse(JSON.stringify(history)) : emptyHistory();

    var srcRuns = (history && Array.isArray(history.runs)) ? history.runs : [];

    // Every distinct name mentioned in the file, in first-seen order.
    var fileNames = [];
    var seenFile = {};
    function addFile(n) {
      if (typeof n === 'string' && !seenFile[n]) { seenFile[n] = true; fileNames.push(n); }
    }
    srcRuns.forEach(function (run) {
      ((run && run.entries) || []).forEach(function (e) { addFile(e && e.name); });
    });
    Object.keys((history && history.fingerprints) || {}).forEach(addFile);
    Object.keys((history && history.breaker) || {}).forEach(addFile);

    var teamNames = {};
    people.forEach(function (p) { teamNames[p.name] = true; });

    var unknown = fileNames.filter(function (n) { return !teamNames[n]; });
    var missing = people.filter(function (p) { return !seenFile[p.name]; })
      .map(function (p) { return p.name; });
    var mismatches = people.filter(function (p) {
      var stored = history && history.fingerprints ? history.fingerprints[p.name] : undefined;
      return stored != null && stored !== fingerprintOf(p, cfg);
    }).map(function (p) { return p.name; });

    var fairness = computeFairness(clone, people, cfg);
    var byName = {};
    fairness.entries.forEach(function (e) { byName[e.name] = e; });

    var latestByName = {};
    if (srcRuns.length) {
      var last = srcRuns[srcRuns.length - 1];
      ((last && last.entries) || []).forEach(function (e) {
        if (e && typeof e.name === 'string') {
          latestByName[e.name] = (typeof e.score === 'number') ? e.score : null;
        }
      });
    }

    var rows = [];
    people.forEach(function (p) {
      var e = byName[p.name];
      var status;
      if (!seenFile[p.name]) status = 'fresh';
      else if (mismatches.indexOf(p.name) >= 0) status = 'fingerprint-changed';
      else status = 'matched';
      rows.push({
        name: p.name,
        satisfaction: e ? e.satisfaction : null,
        debt: e ? e.debt : null,
        latest: Object.prototype.hasOwnProperty.call(latestByName, p.name) ? latestByName[p.name] : null,
        windowed: !!p.noWorkWindow,
        status: status
      });
    });
    unknown.forEach(function (n) {
      rows.push({
        name: n,
        satisfaction: null,
        debt: null,
        latest: Object.prototype.hasOwnProperty.call(latestByName, n) ? latestByName[n] : null,
        windowed: false,
        status: 'unknown'
      });
    });

    var out = {
      rounds: srcRuns.length,
      rows: rows,
      found: fileNames.slice(),
      unknown: unknown,
      missing: missing,
      mismatches: mismatches
    };
    if (exportedAt != null) out.exportedAt = exportedAt;
    return out;
  }

  // ---------------------------------------------------------------------
  // Breaker guarantee subset resolution
  // ---------------------------------------------------------------------

  function buildGuarantees(people, breakerList) {
    var g = [];
    (breakerList || []).forEach(function (b) {
      var idx = -1;
      for (var i = 0; i < people.length; i++) if (people[i].name === b.name) { idx = i; break; }
      if (idx < 0) return;
      g.push({
        index: idx,
        name: b.name,
        dimension: b.dimension,
        value: b.value,
        streak: b.streak || 0,
        reason: b.reason
      });
    });
    return g;
  }

  function baseOwedFor(people) {
    var out = [];
    for (var i = 0; i < people.length; i++) {
      out.push({ slot: null, pair: null, slotStreak: 0, pairStreak: 0 });
    }
    return out;
  }

  function owedForMask(baseOwed, guarantees, mask) {
    var out = new Array(baseOwed.length);
    for (var i = 0; i < baseOwed.length; i++) {
      out[i] = { slot: null, pair: null, slotStreak: 0, pairStreak: 0 };
    }
    for (var g = 0; g < guarantees.length; g++) {
      if (!(mask & (1 << g))) continue;
      var gu = guarantees[g];
      if (gu.dimension === 'slot') out[gu.index].slot = gu.value;
      else out[gu.index].pair = gu.value;
    }
    return out;
  }

  function popcount(mask) { var c = 0; while (mask) { c += mask & 1; mask >>>= 1; } return c; }

  function totalStreak(guarantees, mask) {
    var t = 0;
    for (var g = 0; g < guarantees.length; g++) if (mask & (1 << g)) t += guarantees[g].streak;
    return t;
  }

  // Most guarantees kept first, then longest total streak, then mask order.
  function compareMasks(guarantees) {
    return function (a, b) {
      var pa = popcount(a), pb = popcount(b);
      if (pa !== pb) return pb - pa;
      var sa = totalStreak(guarantees, a), sb = totalStreak(guarantees, b);
      if (sa !== sb) return sb - sa;
      return a - b;
    };
  }

  // Run the raw pass under one guarantee subset, returning the champion (or
  // null when infeasible).
  function* passUnderMask(people, cfg, ctxBase, owed) {
    var ctx = {
      prog: ctxBase.prog,
      coeffs: ctxBase.coeffs,
      personWeight: ctxBase.unitWeights,
      weighted: false,
      bandFloor: -Infinity,
      owed: owed,
      satNum: ctxBase.satNum,
      satDen: ctxBase.satDen,
      rand: ctxBase.rand,
      champion: null,
      tieSample: [],
      tieSampleMax: ctxBase.tieSampleMax
    };
    yield* searchGen(people, cfg, ctx);
    return ctx.champion ? { champion: ctx.champion, tieSample: ctx.tieSample } : null;
  }

  function* resolveGuarantees(people, cfg, ctxBase, guarantees) {
    var G = guarantees.length;
    var baseOwed = baseOwedFor(people);

    if (G === 0) {
      var res0 = yield* passUnderMask(people, cfg, ctxBase, null);
      return { champion: res0 ? res0.champion : null, tieSample: res0 ? res0.tieSample : [], mask: 0, owed: null, attemptCount: 1 };
    }

    if (G <= SUBSET_ENUM_MAX) {
      var masks = [];
      for (var m = 1; m < (1 << G); m++) masks.push(m);
      masks.push(0); // the plain base problem as a last resort
      masks.sort(compareMasks(guarantees));
      var attempts = 0;
      for (var mi = 0; mi < masks.length; mi++) {
        attempts++;
        var owed = owedForMask(baseOwed, guarantees, masks[mi]);
        var res = yield* passUnderMask(people, cfg, ctxBase, owed);
        if (res) {
          return { champion: res.champion, tieSample: res.tieSample, mask: masks[mi], owed: owed, attemptCount: attempts };
        }
      }
      return { champion: null, tieSample: [], mask: -1, owed: null, attemptCount: attempts };
    }

    // Greedy drop for very many simultaneous guarantees.
    var kept = [];
    for (var k = 0; k < G; k++) kept.push(true);
    var attempts2 = 0;
    while (true) {
      var mask = 0;
      for (var k2 = 0; k2 < G; k2++) if (kept[k2]) mask |= (1 << k2);
      attempts2++;
      var owed2 = owedForMask(baseOwed, guarantees, mask);
      var res2 = yield* passUnderMask(people, cfg, ctxBase, owed2);
      if (res2) {
        return { champion: res2.champion, tieSample: res2.tieSample, mask: mask, owed: owed2, attemptCount: attempts2 };
      }
      var anyKept = false;
      for (var kk = 0; kk < G; kk++) if (kept[kk]) anyKept = true;
      if (!anyKept) break;
      var dropIdx = -1, dropStreak = Infinity;
      for (var d = 0; d < G; d++) {
        if (!kept[d]) continue;
        var s2 = guarantees[d].streak;
        if (s2 < dropStreak || (s2 === dropStreak && d > dropIdx)) { dropStreak = s2; dropIdx = d; }
      }
      if (dropIdx < 0) break;
      kept[dropIdx] = false;
    }
    return { champion: null, tieSample: [], mask: -1, owed: null, attemptCount: attempts2 };
  }

  function buildBreakerReport(guarantees, resolved) {
    var keptMask = resolved ? resolved.mask : 0;
    var fired = [], dropped = [];
    for (var g = 0; g < guarantees.length; g++) {
      var gu = guarantees[g];
      var base = {
        name: gu.name,
        dimension: gu.dimension,
        value: gu.value,
        streak: gu.streak
      };
      if (resolved && keptMask >= 0 && (keptMask & (1 << g))) {
        base.reason = gu.streak + ' consecutive rounds as the unique worst-off person, far behind everyone else';
        fired.push(base);
      } else {
        base.reason = 'could not be satisfied alongside the other guarantees, hard coverage, and no-work windows';
        dropped.push(base);
      }
    }
    return { fired: fired, dropped: dropped };
  }

  // ---------------------------------------------------------------------
  // The whole solve, as a generator
  // ---------------------------------------------------------------------

  function* solveGen(people, cfg, opts) {
    cfg = cfg || config;
    opts = opts || {};
    var t0 = Date.now();

    var prog = makeProgress('pass1');
    prog.yieldEvery = (typeof opts.yieldEvery === 'number' && opts.yieldEvery > 0)
      ? opts.yieldEvery : YIELD_EVERY;

    var mu = (typeof opts.fairnessMu === 'number') ? opts.fairnessMu : FAIRNESS_MU;
    var band = (typeof opts.fairnessBand === 'number') ? opts.fairnessBand : FAIRNESS_BAND;

    var seed = (typeof opts.tieSeed === 'number' && isFinite(opts.tieSeed))
      ? (opts.tieSeed >>> 0) : DEFAULT_TIE_SEED;

    var effPeople = effectivePeople(people, cfg);
    var fairness = computeFairness(opts.history, people, cfg, mu);

    var guarantees = buildGuarantees(people, fairness.breaker);

    var coeffs = effPeople.map(function (p) { return personCoeffs(p, cfg); });
    var unitWeights = new Array(people.length);
    for (var uw = 0; uw < unitWeights.length; uw++) unitWeights[uw] = 1;

    var ctxBase = {
      prog: prog,
      coeffs: coeffs,
      unitWeights: unitWeights,
      satNum: fairness.satNum,
      satDen: fairness.satDen,
      rand: mulberry32(seed),
      tieSampleMax: 512
    };

    // Pass 1: exact maximum raw total under hard constraints (coverage,
    // windows, and whichever breaker guarantees are feasible).
    var resolved = yield* resolveGuarantees(effPeople, cfg, ctxBase, guarantees);
    if (!resolved.champion) {
      return { ok: false, error: 'infeasible', elapsedMs: Date.now() - t0 };
    }
    var maxTotal = resolved.champion.raw;
    var pass1Ms = Date.now() - t0;

    // Pass 2: maximise the debt-weighted objective inside the band.
    var finalChampion = resolved.champion;
    var finalTieSample = resolved.tieSample;
    var usedFairness = false;
    if (mu > 0 && fairness.hasDebt) {
      usedFairness = true;
      prog.phase = 'pass2';
      var bandFloor = (1 - band) * maxTotal;
      var ctx2 = {
        prog: prog,
        coeffs: coeffs,
        personWeight: fairness.personWeight,
        weighted: true,
        bandFloor: bandFloor,
        owed: resolved.owed,
        satNum: fairness.satNum,
        satDen: fairness.satDen,
        rand: mulberry32(seed),
        champion: null,
        tieSample: [],
        tieSampleMax: 512
      };
      yield* searchGen(effPeople, cfg, ctx2);
      if (ctx2.champion) {
        finalChampion = ctx2.champion;
        finalTieSample = ctx2.tieSample;
      }
    }

    var pass2Ms = Date.now() - t0 - pass1Ms;
    var slots = computeSlots(cfg, 0);
    var slotOf = finalChampion.slotOf;
    var pairs = finalChampion.pairs;

    var rawEntries = [];
    var assignment = [];
    var currentScores = [];
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      var e = effectiveWeights(p, cfg);
      var slotIndex = slotOf[i];
      var restDays = pairs[i].slice();
      var slotPoints = weightOf(e.shiftWeights, slotIndex, 'hours');
      var restPoints = weightOf(e.restWeights, restDays, 'rest');
      var co = coeffs[i];
      var pcts = percentOf(p, co, slotPoints, restPoints);
      var roundScore = scoreFromCoeffs(co, slotPoints, restPoints);
      currentScores.push(roundScore);

      rawEntries.push({
        person: p,
        name: p.name,
        slotIndex: slotIndex,
        slotStart: slots[slotIndex],
        restDays: restDays
      });
      assignment.push({
        name: p.name,
        slotIndex: slotIndex,
        slotLetter: SLOT_LETTERS[slotIndex],
        slotStart: slots[slotIndex],
        restDays: restDays,
        restDayNames: restDays.map(function (d) { return DAYS[mod(d, DAYS_PER_WEEK)]; }),
        priority: p.priority,
        slotPoints: slotPoints,
        restPoints: restPoints,
        priorityPoints: pcts.priorityPoints,
        softPoints: pcts.softPoints,
        priorityPct: pcts.priorityPct,
        softPct: pcts.softPct,
        score: roundScore
      });
    }

    var grid = buildCoverageGrid(rawEntries, cfg);
    var min = Infinity, max = 0, totalHours = 0;
    grid.forEach(function (row) {
      row.forEach(function (v) {
        if (v < min) min = v;
        if (v > max) max = v;
        totalHours += v;
      });
    });

    // Post-run fairness entries (satisfaction now includes this round).
    var fairnessEntries = [];
    var postWorstName = null;
    var postWorstShortfall = -Infinity;
    for (var fi = 0; fi < people.length; fi++) {
      var fp = people[fi];
      var score = currentScores[fi];
      var num = fairness.satNum[fi] + score;
      var den = fairness.satDen[fi] + 1;
      var sat = num / den;
      var shortfall = 1 - sat;
      var debt = 1 - sat;
      var weight = 1 + mu * debt;
      if (shortfall > postWorstShortfall) { postWorstShortfall = shortfall; postWorstName = fp.name; }
      fairnessEntries.push({
        name: fp.name,
        priorityPct: assignment[fi].priorityPct,
        softPct: assignment[fi].softPct,
        score: score,
        satisfaction: sat,
        shortfall: shortfall,
        debt: debt,
        personWeight: weight,
        windowed: !!fp.noWorkWindow
      });
    }
    if (postWorstShortfall === -Infinity) postWorstShortfall = 0;

    // Tie narrative (sample based only; never used for selection).
    var tied = finalChampion.count;
    var slotByName = {};
    finalTieSample.forEach(function (so) {
      for (var n = 0; n < people.length; n++) {
        (slotByName[people[n].name] = slotByName[people[n].name] || {})[so[n]] = true;
      }
    });
    var swingNames = Object.keys(slotByName).filter(function (name) {
      return Object.keys(slotByName[name]).length > 1;
    });
    var groups = {};
    people.forEach(function (p) {
      var e = effectiveWeights(p, cfg);
      var sig = p.priority + '|' + e.shiftWeights.join(',') + '|' + e.restWeights.join(',') +
        '|' + (p.noWorkWindow ? 'W' : 'N');
      (groups[sig] = groups[sig] || []).push(p.name);
    });
    var interchangeable = Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.length > 1; });

    var breakerReport = buildBreakerReport(guarantees, resolved);

    var out = {
      ok: true,
      offset: 0,
      slots: slots,
      assignment: assignment,
      grid: grid,
      score: finalChampion.raw,
      minCoverage: min,
      maxCoverage: max,
      totalPersonHours: totalHours,
      exactlyBalanced: min === max,
      phase: 'open-domain',
      tie: {
        count: tied,
        seed: seed,
        rule: 'seeded-random-draw',
        ruleLabel: 'Seeded random draw (mulberry32)',
        chosenIndex: 0,
        swingNames: swingNames,
        interchangeableGroups: interchangeable,
        definition: 'A schedule is the person-to-slot assignment; different rest-day pairs within the same slot assignment are not counted separately.'
      },
      stats: {
        outers: prog.outers,
        innerPerms: prog.innerPerms,
        restCombos: prog.restCombos,
        innerChecked: prog.innerChecked
      },
      elapsedMs: Date.now() - t0,
      timing: { pass1Ms: pass1Ms, pass2Ms: pass2Ms, totalMs: Date.now() - t0 },
      maxTotal: maxTotal,
      band: band,
      fairness: {
        bandPercent: band * 100,
        maxTotal: maxTotal,
        achievedTotal: finalChampion.raw,
        objectiveValue: finalChampion.objective,
        worstName: postWorstName,
        worstShortfall: postWorstShortfall,
        entries: fairnessEntries,
        breakerFired: breakerReport.fired,
        breakerDropped: breakerReport.dropped
      }
    };
    return out;
  }

  function solve(people, cfg, opts) {
    var gen = solveGen(people, cfg, opts);
    var step = gen.next();
    while (!step.done) step = gen.next();
    return step.value;
  }

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
    SPLIT_PRIORITY: SPLIT_PRIORITY,
    SPLIT_SOFT: SPLIT_SOFT,
    DEFAULT_TIE_SEED: DEFAULT_TIE_SEED,
    ADJACENT_PAIRS: ADJACENT_PAIRS,

    // fairness tunables
    FAIRNESS_MU: FAIRNESS_MU,
    FAIRNESS_BAND: FAIRNESS_BAND,
    DECAY_HALF_LIFE: DECAY_HALF_LIFE,
    BREAKER_STREAK: BREAKER_STREAK,
    BREAKER_GAP: BREAKER_GAP,
    BREAKER_RATIO: BREAKER_RATIO,
    BREAKER_MIN_SHORTFALL: BREAKER_MIN_SHORTFALL,

    // data
    config: config,
    defaultPeople: defaultPeople,

    // helpers
    mod: mod,
    pairKey: pairKey,
    personDutyHours: personDutyHours,
    weightOf: weightOf,
    effectiveWeights: effectiveWeights,
    effectivePeople: effectivePeople,
    personCoeffs: personCoeffs,
    topOptionIndex: topOptionIndex,

    // api
    computeSlots: computeSlots,
    buildCoverageGrid: buildCoverageGrid,
    meetsCoverage: meetsCoverage,
    satisfiesNoWorkWindow: satisfiesNoWorkWindow,
    scoreAssignment: scoreAssignment,
    solve: solve,
    solveAsync: solveAsync,

    // fairness / history
    HISTORY_VERSION: HISTORY_VERSION,
    MAX_HISTORY_RUNS: MAX_HISTORY_RUNS,
    SUBSET_ENUM_MAX: SUBSET_ENUM_MAX,
    buildRunRecord: buildRunRecord,
    computeFairness: computeFairness,
    appendHistory: appendHistory,
    fingerprintOf: fingerprintOf,
    validateHistoryFile: validateHistoryFile,
    historySummary: historySummary,
    HISTORY_KIND: HISTORY_KIND
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Scheduler;
  else root.Scheduler = Scheduler;

})(typeof globalThis !== 'undefined' ? globalThis : this);

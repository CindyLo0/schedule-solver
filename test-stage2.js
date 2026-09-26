/* test-stage2.js
 *
 * Node-only checks for the exhaustive scheduler.solve().
 * Run with:  node test-stage2.js
 *
 * The important part is section 3: the real solver is compared against a
 * slow, dumb brute-force search (no pruning, no ordering) over small synthetic
 * cases. Both must return the same score, or the shortcuts are not safe.
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;
var HOURS_PER_WEEK = S.HOURS_PER_WEEK;

var passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label); }
}
function eq(label, actual, expected) {
  check(label + '  (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')',
        JSON.stringify(actual) === JSON.stringify(expected));
}
function fmtHour(h) {
  return (h < 10 ? '0' : '') + h + ':00';
}

// ---- independent helpers (re-implemented here on purpose) -------------
function pairKey(p) { var a = p[0], b = p[1]; return a <= b ? a + ',' + b : b + ',' + a; }

// Points for a value, straight from a weights array (no solver call).
function weightManual(weights, value, kind) {
  weights = weights || [];
  if (kind === 'rest') {
    var k = pairKey(value);
    for (var i = 0; i < S.ADJACENT_PAIRS.length; i++) {
      if (pairKey(S.ADJACENT_PAIRS[i]) === k) return weights[i] || 0;
    }
    return 0;
  }
  var v = weights[value];
  return typeof v === 'number' ? v : 0;
}

// A slot is "workable" for a window person when at least one rest pair keeps
// them out of the window at that slot (the solver's slotWindowAllowed).
function slotWorkableManual(person, slotStart, cfg) {
  if (!person.noWorkWindow) return true;
  for (var i = 0; i < S.ADJACENT_PAIRS.length; i++) {
    if (S.satisfiesNoWorkWindow(person, slotStart, S.ADJACENT_PAIRS[i], cfg)) return true;
  }
  return false;
}

// Sum of every OTHER person's points for a slot. LOWER = least wanted.
function summedOthersWeight(people, personName, slot) {
  var sum = 0;
  people.forEach(function (p) {
    if (p.name === personName) return;
    sum += weightManual(p.shiftWeights, slot, 'hours');
  });
  return sum;
}

// The §4 property, checked directly: window respected, assigned slot workable,
// no workable slot with a strictly lower summed-others'-weight, and no tied
// workable slot with a later letter. Returns null when satisfied.
function ruleProblemFor(person, entry, people, cfg) {
  if (!person.noWorkWindow) return null;
  if (!S.satisfiesNoWorkWindow(person, entry.slotStart, entry.restDays, cfg)) {
    return person.name + ': window violated';
  }
  var slots = S.computeSlots(cfg, 0);
  var workable = [];
  for (var s = 0; s < cfg.numSlots; s++) {
    if (slotWorkableManual(person, slots[s], cfg)) workable.push(s);
  }
  if (workable.indexOf(entry.slotIndex) < 0) return person.name + ': assigned slot not workable';
  var assigned = summedOthersWeight(people, person.name, entry.slotIndex);
  var lower = workable.filter(function (s) {
    return summedOthersWeight(people, person.name, s) < assigned;
  });
  if (lower.length) {
    return person.name + ': assigned ' + entry.slotLetter + ' but workable ' +
      lower.map(function (s) { return S.SLOT_LETTERS[s]; }).join(',') + ' are less wanted';
  }
  var laterEqual = workable.filter(function (s) {
    return s > entry.slotIndex && summedOthersWeight(people, person.name, s) === assigned;
  });
  if (laterEqual.length) {
    return person.name + ': tie-break should prefer later ' +
      laterEqual.map(function (s) { return S.SLOT_LETTERS[s]; }).join(',');
  }
  return null;
}

// =====================================================================
console.log('Stage 2 tests — exhaustive solve()\n');
console.log('1. Default dataset');
// =====================================================================

var t0 = Date.now();
var res = S.solve(S.defaultPeople, config, {});
var elapsed = Date.now() - t0;

check('solve returns ok', res.ok === true);
check('hard minimum coverage >= 2 across all 168 hours', res.minCoverage >= 2);
check('maximum coverage is 3', res.maxCoverage === 3);
check('score is a finite number', typeof res.score === 'number' && isFinite(res.score));

// Full independent re-check of the hard constraint from the returned grid.
var below = 0;
res.grid.forEach(function (row) { row.forEach(function (v) { if (v < 2) below++; }); });
eq('returned grid has zero hours below 2', below, 0);

var daph = null;
res.assignment.forEach(function (a) { if (a.name === 'Daphine') daph = a; });
var daphPerson = S.defaultPeople.filter(function (p) { return p.name === 'Daphine'; })[0];
check('Daphine present', !!daph);
// §4: Daphine must get the workable slot the REST of the team least wants
// (lowest summed points), later letter first as a tie-break. The exact letter
// is determined by the data, not hardcoded.
var daphRule = daph && ruleProblemFor(daphPerson, daph, S.defaultPeople, config);
check('Daphine gets the least-wanted workable slot (§4)', daphRule === null,
  daphRule || '');
check('Daphine is never on duty inside her no-work window',
      daph && S.satisfiesNoWorkWindow(daphPerson, daph.slotStart, daph.restDays, config) === true);

// The assigned entries must carry exactly the frozen weighted shape.
var ENTRY_FIELDS = ['name', 'slotIndex', 'slotLetter', 'slotStart', 'restDays',
  'restDayNames', 'priority', 'slotPoints', 'restPoints', 'priorityPoints', 'softPoints'];
var shapeProblem = null;
res.assignment.forEach(function (a) {
  var keys = Object.keys(a).sort();
  if (keys.join(',') !== ENTRY_FIELDS.slice().sort().join(',')) {
    shapeProblem = a.name + ': keys ' + keys.join(',');
  }
  if (a.slotPoints < 0 || a.slotPoints > 100) shapeProblem = a.name + ': slotPoints out of range';
  if (a.restPoints < 0 || a.restPoints > 100) shapeProblem = a.name + ': restPoints out of range';
});
check('every assignment entry has the exact frozen fields', shapeProblem === null, shapeProblem || '');

console.log('\n  Search stats: ' + JSON.stringify(res.stats));
console.log('  Phase: ' + res.phase + '   Elapsed: ' + elapsed + ' ms\n');
console.log('  Resulting schedule:');
res.assignment.forEach(function (a) {
  console.log('    ' + a.name.padEnd(8) + ' slot ' + a.slotLetter +
    '  ' + fmtHour(a.slotStart) + '-' + fmtHour((a.slotStart + config.shiftLen) % 24) +
    '   rest ' + a.restDayNames.join('-') +
    '   priority=' + a.priority +
    '  points=' + a.priorityPoints + '/' + a.softPoints);
});

// =====================================================================
console.log('\n2. Grid coverage detail');
// =====================================================================
var tot = 0, mn = Infinity, mx = 0;
res.grid.forEach(function (row) { row.forEach(function (v) { tot += v; if (v < mn) mn = v; if (v > mx) mx = v; }); });
eq('total person-hours = 8 * 5 * 9 = 360', tot, 360);
check('min = 2 and max = 3 are the only values', mn === 2 && mx === 3);

// =====================================================================
console.log('\n3. Shortcut safety: real solver vs dumb brute force (small cases)');
console.log('   Brute force model (weighted, open domain):');
console.log('     - every person may take any of cfg.numSlots slots and any of');
console.log('       the 7 consecutive rest pairs, even ones with zero points;');
console.log('     - hard coverage on all 168 hours and each no-work window;');
console.log('     - weighted reward (priority dimension * 100, other * 1) of the');
console.log('       0..100 points, HIGHER better;');
console.log('     - window people are pinned to the least-wanted-by-others workable');
console.log('       slot (lowest summed points first) that admits a feasible');
console.log('       schedule, exactly as the solver does. No pruning or ordering');
console.log('       shortcuts.');
// =====================================================================

function scoreManual(entries, pw, sw) {
  var t = 0;
  entries.forEach(function (e) {
    var p = e.person;
    var slotPoints = weightManual(p.shiftWeights, e.slotIndex, 'hours');
    var restPoints = weightManual(p.restWeights, e.restDays, 'rest');
    if (p.priority === 'rest') t += pw * restPoints + sw * slotPoints;
    else t += pw * slotPoints + sw * restPoints;
  });
  return t;
}

function coverageOkManual(entries, cfg) {
  var counts = new Int16Array(HOURS_PER_WEEK);
  entries.forEach(function (e) {
    var hrs = S.personDutyHours(e.slotStart, e.restDays, cfg);
    for (var i = 0; i < hrs.length; i++) counts[hrs[i]] += 1;
  });
  for (var h = 0; h < HOURS_PER_WEEK; h++) if (counts[h] < cfg.minCoverage) return false;
  return true;
}

function windowsOkManual(entries, cfg) {
  return entries.every(function (e) {
    return S.satisfiesNoWorkWindow(e.person, e.slotStart, e.restDays, cfg);
  });
}

// position of each workable slot in the solver's least-wanted-by-others-first
// order (lower sum of the OTHER people's points first, later letter first).
// Missing => not workable.
function windowOrderMap(person, people, personIdx, slots, cfg) {
  var workable = [];
  for (var s = 0; s < cfg.numSlots; s++) {
    if (slotWorkableManual(person, slots[s], cfg)) workable.push(s);
  }
  function dislike(s) {
    var sum = 0;
    for (var p = 0; p < people.length; p++) {
      if (p === personIdx) continue;
      sum += weightManual(people[p].shiftWeights, s, 'hours');
    }
    return sum;
  }
  workable.sort(function (a, b) {
    var da = dislike(a), db = dislike(b);
    if (da !== db) return da - db;  // lower summed points = least wanted, first
    return b - a;                    // tie-break: later letter first
  });
  var map = {};
  workable.forEach(function (s, i) { map[s] = i; });
  return map;
}

function sameTuple(a, b) { return a.length === b.length && a.every(function (v, i) { return v === b[i]; }); }
function lexLess(a, b) {
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function bruteSolve(people, cfg) {
  var pw = S.PRIORITY_WEIGHT, sw = S.SOFT_WEIGHT;
  var slots = S.computeSlots(cfg, 0);
  var n = people.length;

  var windowIdx = [];
  people.forEach(function (p, i) { if (p.noWorkWindow) windowIdx.push(i); });
  var orderMaps = windowIdx.map(function (i) { return windowOrderMap(people[i], people, i, slots, cfg); });
  for (var w = 0; w < orderMaps.length; w++) {
    if (Object.keys(orderMaps[w]).length === 0) return { ok: false, error: 'infeasible' };
  }

  var bestTuple = null, best = -Infinity;
  var assign = new Array(n), used = new Array(cfg.numSlots).fill(false);
  var pairs = new Array(n);

  function evaluate() {
    var entries = [];
    for (var i = 0; i < n; i++) {
      entries.push({
        person: people[i], slotIndex: assign[i],
        slotStart: slots[assign[i]], restDays: pairs[i]
      });
    }
    if (!windowsOkManual(entries, cfg)) return;
    if (!coverageOkManual(entries, cfg)) return;

    var tuple = windowIdx.map(function (pi, k) { return orderMaps[k][assign[pi]]; });
    var sc = scoreManual(entries, pw, sw);
    if (bestTuple === null || lexLess(tuple, bestTuple)) { bestTuple = tuple; best = sc; }
    else if (sameTuple(tuple, bestTuple) && sc > best) { best = sc; }
  }

  function recRest(i) {
    if (i === n) { evaluate(); return; }
    for (var pi = 0; pi < S.ADJACENT_PAIRS.length; pi++) {
      pairs[i] = S.ADJACENT_PAIRS[pi];
      recRest(i + 1);
    }
  }

  function recSlot(i) {
    if (i === n) { recRest(0); return; }
    for (var s = 0; s < cfg.numSlots; s++) {
      if (used[s]) continue;
      used[s] = true; assign[i] = s;
      recSlot(i + 1);
      used[s] = false;
    }
  }
  recSlot(0);

  if (best === -Infinity) return { ok: false, error: 'infeasible' };
  return { ok: true, score: best };
}

// ---- deterministic synthetic cases ------------------------------------
function makeRng(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function makeWeights(rng, n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(Math.floor(rng() * 101));
  return out;
}
function makeCase(seed, opts) {
  var rng = makeRng(seed);
  var cfg = opts.cfg;
  var people = [];

  for (var n = 0; n < opts.count; n++) {
    var isRest = rng() < 0.5;
    people.push({
      name: 'P' + n,
      shiftWeights: makeWeights(rng, cfg.numSlots),
      restWeights: makeWeights(rng, S.ADJACENT_PAIRS.length),
      priority: isRest ? 'rest' : 'hours',
      noWorkWindow: null
    });
  }
  if (opts.windowIndex != null) {
    people[opts.windowIndex].noWorkWindow = opts.window;
  }
  return { label: opts.label, cfg: cfg, people: people };
}

var cases = [
  makeCase(11, {
    label: 'case 1 (3 people, 3 slots, no coverage floor)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 0, numSlots: 3 }, count: 3
  }),
  makeCase(12, {
    label: 'case 2 (4 people, 4 slots, no coverage floor)',
    cfg: { shiftLen: 24, stagger: 6, minCoverage: 0, numSlots: 4 }, count: 4
  }),
  makeCase(13, {
    label: 'case 3 (3 people, 3 slots, minimum coverage 1)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3
  }),
  makeCase(14, {
    label: 'case 4 (4 people, 4 slots, minimum coverage 1)',
    cfg: { shiftLen: 12, stagger: 6, minCoverage: 1, numSlots: 4 }, count: 4
  }),
  makeCase(15, {
    label: 'case 5 (3 people, 3 slots, no-work window on P1)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3,
    windowIndex: 1, window: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 }
  }),
  {
    label: 'case 6 (3 people, 3 slots, impossible minimum coverage)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 3, numSlots: 3 },
    people: [
      { name: 'P0', shiftWeights: [40, 10, 0], restWeights: [5, 3, 2, 4, 1, 0, 2], priority: 'hours', noWorkWindow: null },
      { name: 'P1', shiftWeights: [5, 30, 10], restWeights: [1, 2, 3, 4, 5, 6, 7], priority: 'rest', noWorkWindow: null },
      { name: 'P2', shiftWeights: [10, 5, 30], restWeights: [7, 6, 5, 4, 3, 2, 1], priority: 'rest', noWorkWindow: null }
    ]
  }
];

cases.forEach(function (c) {
  var t = Date.now();
  var real = S.solve(c.people, c.cfg, {});
  var dumb = bruteSolve(c.people, c.cfg);
  var ms = Date.now() - t;
  if (real.ok !== dumb.ok) {
    check(c.label + ' -- ok flags agree (real=' + real.ok + ', brute=' + dumb.ok + ')', false);
  } else if (real.ok && real.score !== dumb.score) {
    check(c.label + ' -- scores agree (real=' + real.score + ', brute=' + dumb.score + ')', false);
  } else if (real.ok) {
    check(c.label + ' -- scores agree (' + real.score + ')', true);
  } else {
    check(c.label + ' -- both correctly infeasible', true);
  }
  console.log('        real=' + (real.ok ? real.score : real.error) +
    '  brute=' + (dumb.ok ? dumb.score : dumb.error) + '   [' + ms + ' ms]');
});

// =====================================================================
console.log('\n4. Cross-run rotation: window slot outranks guarantees');
// =====================================================================
// Simulate the app's run sequence: empty history -> solve -> buildRunRecord
// -> appendHistory -> computeOwed -> solve(with owed) -> ... The
// no-work-window person's rule-determined slot (the least-wanted workable
// slot) must be identical every run. A rotation guarantee that cannot
// coexist with that slot must be DROPPED (with attribution), never the slot.
// The pin is recomputed from the current weights each run, so history can
// never move it.

function findPerson(res, name) {
  return res.assignment.filter(function (a) { return a.name === name; })[0];
}

function runSequence(people, cfg, runs) {
  var history = null;
  var out = [];
  for (var r = 0; r < runs; r++) {
    var owedInfo = S.computeOwed(history, people);
    var res = S.solve(people, cfg, { owed: owedInfo.owed });
    out.push({ result: res, owedInfo: owedInfo });
    if (!res.ok) return out;
    history = S.appendHistory(history, S.buildRunRecord(res.assignment, people));
  }
  return out;
}

var seq = runSequence(S.defaultPeople, config, 3);

seq.forEach(function (step, i) {
  var res = step.result, n = i + 1;
  check('run ' + n + ' succeeds', res.ok === true);
  if (!res.ok) return;
  var d = findPerson(res, 'Daphine');
  var problem = d && ruleProblemFor(daphPerson, d, S.defaultPeople, config);
  check('run ' + n + ': Daphine gets the least-wanted workable slot (§4)', problem === null,
    problem || '');
  check('run ' + n + ': Daphine never on duty inside her window',
    d && S.satisfiesNoWorkWindow(daphPerson, d.slotStart, d.restDays, config) === true);
  if (i > 0) {
    var g = res.guarantees;
    check('run ' + n + ': guarantee report present', !!g);
    if (g) {
      check('run ' + n + ': satisfied + dropped === owed (' +
        g.satisfied.length + '+' + g.dropped.length + '=' + g.owed.length + ')',
        g.satisfied.length + g.dropped.length === g.owed.length);
      var attributed = g.dropped.every(function (x) {
        return typeof x.name === 'string' && typeof x.dimension === 'string' &&
          x.value != null && typeof x.reason === 'string' && x.reason.length > 0;
      });
      check('run ' + n + ': every dropped guarantee is attributed', attributed);
      check('run ' + n + ': a guarantee pin is never placed on the window person',
        g.owed.every(function (x) {
          return !(x.name === 'Daphine' && x.dimension === 'slot');
        }));
    }
  }
});

check('run 2 drops at least one guarantee to keep Daphine on her rule slot',
  seq[1].result.guarantees && seq[1].result.guarantees.dropped.length >= 1);
check('an identical fresh run still puts Daphine on her rule slot (history cannot move it)',
  (function () {
    var fresh = S.solve(S.defaultPeople, config, { owed: S.computeOwed(null, S.defaultPeople).owed });
    var d = findPerson(fresh, 'Daphine');
    return ruleProblemFor(daphPerson, d, S.defaultPeople, config) === null;
  })());

console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

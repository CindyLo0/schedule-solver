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
// Current open-domain result: Daphine takes slot H (21:00), the workable slot
// the REST of the team least wants (highest sum of their ranks), and rest pair
// Fri-Sat, which still keeps her out of her no-work window.
check('Daphine gets slot H', daph && daph.slotLetter === 'H');
check('Daphine starts at 21:00', daph && daph.slotStart === 21);
check('Daphine rests Fri-Sat', daph && S.pairKey(daph.restDays) === S.pairKey([4, 5]));
check('Daphine is never on duty inside her no-work window',
      daph && S.satisfiesNoWorkWindow(daphPerson, daph.slotStart, daph.restDays, config) === true);

console.log('\n  Search stats: ' + JSON.stringify(res.stats));
console.log('  Phase: ' + res.phase + '   Elapsed: ' + elapsed + ' ms\n');
console.log('  Resulting schedule:');
res.assignment.forEach(function (a) {
  console.log('    ' + a.name.padEnd(8) + ' slot ' + a.slotLetter +
    '  ' + fmtHour(a.slotStart) + '-' + fmtHour((a.slotStart + config.shiftLen) % 24) +
    '   rest ' + a.restDayNames.join('-') +
    '   priority=' + a.priority +
    '  prank=' + a.priorityRank + (a.priorityMet ? ' (met)' : ' (not met)') +
    '  soft=' + a.softRank);
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
console.log('   Brute force model (current, open domain):');
console.log('     - every person may take any of cfg.numSlots slots and any of');
console.log('       the 7 consecutive rest pairs, even ones they did not rank;');
console.log('     - hard coverage on all 168 hours and each no-work window;');
console.log('     - weighted rank penalty (priority dimension * 100, other * 1);');
console.log('     - window people are pinned to the first workable slot the REST');
console.log('       of the team least wants (most-disliked first) that admits a');
console.log('       feasible schedule, exactly as the solver does. No pruning or');
console.log('       ordering shortcuts.');
// =====================================================================

// ---- independent brute force (no pruning, no ordering) ----------------
function pairKey(p) { var a = p[0], b = p[1]; return a <= b ? a + ',' + b : b + ',' + a; }

function rankManual(list, value, kind) {
  list = list || [];
  if (kind === 'rest') {
    var k = pairKey(value);
    for (var i = 0; i < list.length; i++) if (pairKey(list[i]) === k) return i;
    return list.length;
  }
  var idx = list.indexOf(value);
  return idx >= 0 ? idx : list.length;
}

function scoreManual(entries, pw, sw) {
  var t = 0;
  entries.forEach(function (e) {
    var p = e.person;
    var restRank = rankManual(p.restOptions, e.restDays, 'rest');
    var hourRank = rankManual(p.shiftOptions, e.slotIndex, 'hours');
    if (p.priority === 'rest') t += pw * restRank + sw * hourRank;
    else t += pw * hourRank + sw * restRank;
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

// A slot is "workable" for a window person when at least one rest pair keeps
// them out of the window at that slot (the solver's slotWindowAllowed).
function slotWorkableManual(person, slotStart, cfg) {
  if (!person.noWorkWindow) return true;
  for (var i = 0; i < S.ADJACENT_PAIRS.length; i++) {
    if (S.satisfiesNoWorkWindow(person, slotStart, S.ADJACENT_PAIRS[i], cfg)) return true;
  }
  return false;
}

// position of each workable slot in the solver's most-disliked-by-others-first
// order (greater sum of the OTHER people's ranks first, later letter first).
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
      sum += rankManual(people[p].shiftOptions, s, 'hours');
    }
    return sum;
  }
  workable.sort(function (a, b) {
    var da = dislike(a), db = dislike(b);
    if (db !== da) return db - da;
    return b - a;
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

  var bestTuple = null, best = Infinity;
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
    else if (sameTuple(tuple, bestTuple) && sc < best) { best = sc; }
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

  if (best === Infinity) return { ok: false, error: 'infeasible' };
  return { ok: true, score: best };
}

// ---- deterministic synthetic cases ------------------------------------
function makeRng(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function sample(rng, arr, n) {
  var copy = arr.slice(), out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
}
function makeCase(seed, opts) {
  var rng = makeRng(seed);
  var cfg = opts.cfg;
  var people = [];
  var slotIdx = [];
  for (var i = 0; i < cfg.numSlots; i++) slotIdx.push(i);

  for (var n = 0; n < opts.count; n++) {
    var isRest = rng() < 0.5;
    var restOptions = sample(rng, S.ADJACENT_PAIRS, 1 + Math.floor(rng() * 2));
    var shiftOptions = sample(rng, slotIdx, 1 + Math.floor(rng() * 2));
    people.push({
      name: 'P' + n,
      restOptions: restOptions,
      shiftOptions: shiftOptions,
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
      { name: 'P0', restOptions: [[4, 5]], shiftOptions: [0, 1], priority: 'hours', noWorkWindow: null },
      { name: 'P1', restOptions: [[0, 1]], shiftOptions: [1, 2], priority: 'rest', noWorkWindow: null },
      { name: 'P2', restOptions: [[2, 3]], shiftOptions: [0, 2], priority: 'rest', noWorkWindow: null }
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

console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

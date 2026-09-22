/* test-stage2.js
 *
 * Node-only checks for the exhaustive scheduler.solve().
 * Run with:  node test-stage2.js
 *
 * The important part is section 3: the real solver is compared against a
 * slow, dumb brute-force search (no pruning, no ordering) over small random
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
check('Daphine present', !!daph);
check('Daphine gets slot G', daph && daph.slotLetter === 'G');
check('Daphine starts at 19:00', daph && daph.slotStart === 19);
check('Daphine rests Thu-Fri', daph && S.pairKey(daph.restDays) === S.pairKey([3, 4]));

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
function allowedPairs(person, relaxed) {
  if (person.exactStart != null) {
    return (person.restOptions && person.restOptions.length) ? person.restOptions : S.ADJACENT_PAIRS;
  }
  if (person.priority === 'rest') {
    if (relaxed) return S.ADJACENT_PAIRS;
    return (person.restOptions && person.restOptions.length) ? person.restOptions : S.ADJACENT_PAIRS;
  }
  return S.ADJACENT_PAIRS;
}
function eachProduct(lists, cb) {
  if (lists.length === 0) { cb([]); return; }
  var cur = new Array(lists.length);
  (function rec(i) {
    if (i === lists.length) { cb(cur.slice()); return; }
    for (var j = 0; j < lists[i].length; j++) { cur[i] = lists[i][j]; rec(i + 1); }
  })(0);
}

// One phase of brute force. Returns {best:Infinity} when nothing is feasible.
function brutePhase(people, cfg, relaxed) {
  var locked = [], free = [];
  people.forEach(function (p) { if (p.exactStart != null) locked.push(p); else free.push(p); });

  var offSet = {};
  locked.forEach(function (p) { offSet[S.offsetForExactStart(p.exactStart, cfg)] = true; });
  var offKeys = Object.keys(offSet);
  if (offKeys.length > 1) return { contradiction: true };
  var offset = offKeys.length ? Number(offKeys[0]) : 0;
  var slots = S.computeSlots(cfg, offset);

  var used = {}, lockedSlot = [], conflict = false;
  locked.forEach(function (p) {
    var si = S.slotForExactStart(p.exactStart, cfg, offset);
    if (si < 0 || used[si]) conflict = true;
    else { used[si] = true; lockedSlot.push(si); }
  });
  if (conflict) return { slotConflict: true };

  var available = [];
  for (var s = 0; s < cfg.numSlots; s++) if (!used[s]) available.push(s);

  var pw = S.PRIORITY_WEIGHT, sw = S.SOFT_WEIGHT;
  var best = Infinity;

  (function recSlots(i, remaining, slotOfFree) {
    if (i === free.length) {
      var allPeople = locked.concat(free);
      var allowed = allPeople.map(function (p) { return allowedPairs(p, relaxed); });
      eachProduct(allowed, function (pairs) {
        var entries = [];
        for (var a = 0; a < locked.length; a++) {
          entries.push({ person: locked[a], slotIndex: lockedSlot[a], slotStart: slots[lockedSlot[a]], restDays: pairs[a] });
        }
        for (var b = 0; b < free.length; b++) {
          var slot = slotOfFree[b];
          entries.push({ person: free[b], slotIndex: slot, slotStart: slots[slot], restDays: pairs[locked.length + b] });
        }
        if (!windowsOkManual(entries, cfg)) return;
        if (!coverageOkManual(entries, cfg)) return;
        var sc = scoreManual(entries, pw, sw);
        if (sc < best) best = sc;
      });
      return;
    }
    for (var r = 0; r < remaining.length; r++) {
      slotOfFree[i] = remaining[r];
      var next = remaining.slice(0, r).concat(remaining.slice(r + 1));
      recSlots(i + 1, next, slotOfFree);
    }
  })(0, available.slice(), new Array(free.length));

  return { best: best, offset: offset, slots: slots };
}

function bruteSolve(people, cfg) {
  var a = brutePhase(people, cfg, false);
  if (a.contradiction || a.slotConflict) return { ok: false, error: 'config' };
  if (a.best === Infinity) {
    var b = brutePhase(people, cfg, true);
    if (b.best === Infinity) return { ok: false, error: 'infeasible' };
    return { ok: true, score: b.best, phase: 'relaxed' };
  }
  return { ok: true, score: a.best, phase: 'strict' };
}

// ---- deterministic random small cases ---------------------------------
function makeRng(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
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
      exactStart: null,
      noWorkWindow: null
    });
  }
  if (opts.lockIndex != null) {
    var lp = people[opts.lockIndex];
    lp.exactStart = opts.lockStart;
  }
  if (opts.windowIndex != null) {
    people[opts.windowIndex].noWorkWindow = opts.window;
  }
  return { cfg: cfg, people: people };
}

// A mix: some with no coverage floor (pure score optimisation, so both
// versions must agree on the best preferences), and some with a real coverage
// floor where the capacity pruning actually bites. shiftLen 24 / 2 slots keeps
// a real coverage constraint but stays small enough for the dumb brute force.
var cases = [
  makeCase(1, { cfg: { shiftLen: 9, stagger: 8, minCoverage: 0, numSlots: 3 }, count: 3 }),
  makeCase(2, { cfg: { shiftLen: 6, stagger: 6, minCoverage: 0, numSlots: 4 }, count: 4 }),
  makeCase(3, { cfg: { shiftLen: 9, stagger: 6, minCoverage: 0, numSlots: 4 }, count: 4 }),
  makeCase(4, { cfg: { shiftLen: 9, stagger: 8, minCoverage: 0, numSlots: 3 }, count: 3, lockIndex: 0, lockStart: 19 }),
  makeCase(5, { cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3 }),
  makeCase(6, { cfg: { shiftLen: 24, stagger: 6, minCoverage: 1, numSlots: 4 }, count: 4 }),
  makeCase(7, { cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3, lockIndex: 0, lockStart: 19 }),
  makeCase(8, {
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3,
    windowIndex: 1, window: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 }
  }),
  // Forced fallback: every rest-priority person only accepts Mon-Tue, which
  // cannot cover the week, so the strict phase must prove infeasible and the
  // relaxed phase must find the best compromise. Both solvers must agree.
  {
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 },
    people: [
      { name: 'P0', restOptions: [[0, 1]], shiftOptions: [0, 1], priority: 'rest', exactStart: null, noWorkWindow: null },
      { name: 'P1', restOptions: [[0, 1]], shiftOptions: [1, 2], priority: 'rest', exactStart: null, noWorkWindow: null },
      { name: 'P2', restOptions: [[0, 1]], shiftOptions: [0, 2], priority: 'rest', exactStart: null, noWorkWindow: null }
    ]
  }
];

cases.forEach(function (c, i) {
  var t = Date.now();
  var real = S.solve(c.people, c.cfg, {});
  var dumb = bruteSolve(c.people, c.cfg);
  var ms = Date.now() - t;
  var label = 'case ' + (i + 1) + ' (' + c.people.length + ' people, ' + c.cfg.numSlots +
    ' slots, min=' + c.cfg.minCoverage + ')';
  if (real.ok !== dumb.ok) {
    check(label + ' -- ok flags agree (real=' + real.ok + ', brute=' + dumb.ok + ')', false);
  } else if (real.ok && real.score !== dumb.score) {
    check(label + ' -- scores agree (real=' + real.score + ', brute=' + dumb.score + ')', false);
  } else if (real.ok) {
    check(label + ' -- scores agree (' + real.score + ', phase ' + real.phase + ')', true);
  } else {
    check(label + ' -- both correctly infeasible', true);
  }
  console.log('        real=' + (real.ok ? real.score : real.error) +
    '  brute=' + (dumb.ok ? dumb.score : dumb.error) + '   [' + ms + ' ms]');
});

console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

/* test-stage2.js
 *
 * Node-only checks for the exhaustive scheduler.solve().
 * Run with:  node test-stage2.js
 *
 * Section 3 compares the real solver against a slow, unpruned brute-force
 * enumeration over small synthetic cases (reward-only, history absent).
 * Section 4 does the same for the bounded-fairness objective with a small
 * history. The brute force is deliberately independent: it never calls the
 * solver's search, only its public helpers.
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;
var HOURS_PER_WEEK = S.HOURS_PER_WEEK;

var passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label); } }
function eq(label, actual, expected) {
  check(label + '  (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')',
        JSON.stringify(actual) === JSON.stringify(expected));
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
function fmtHour(h) { return (h < 10 ? '0' : '') + h + ':00'; }

// ---- independent helpers (re-implemented here on purpose) -------------
function pairKey(p) { var a = p[0], b = p[1]; return a <= b ? a + ',' + b : b + ',' + a; }
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
// Effective weights, mirroring the engine's flattening rule.
function effManual(person, cfg) {
  if (!person.noWorkWindow) {
    return { sw: person.shiftWeights, rw: person.restWeights, pri: person.priority };
  }
  var n = cfg.numSlots, m = S.ADJACENT_PAIRS.length;
  var sw = [], rw = [];
  for (var i = 0; i < n; i++) sw.push(100 / n);
  for (var j = 0; j < m; j++) rw.push(100 / m);
  return { sw: sw, rw: rw, pri: person.priority };
}
function rewardManual(entry, cfg) {
  var e = effManual(entry.person, cfg);
  var sp = weightManual(e.sw, entry.slotIndex, 'hours');
  var rp = weightManual(e.rw, entry.restDays, 'rest');
  return e.pri === 'rest' ? 100 * rp + sp : 100 * sp + rp;
}
function coverageOkManual(entries, cfg) {
  var counts = new Int16Array(HOURS_PER_WEEK);
  entries.forEach(function (x) {
    S.personDutyHours(x.slotStart, x.restDays, cfg).forEach(function (h) { counts[h] += 1; });
  });
  for (var h = 0; h < HOURS_PER_WEEK; h++) if (counts[h] < cfg.minCoverage) return false;
  return true;
}
function windowsOkManual(entries, cfg) {
  return entries.every(function (x) {
    return S.satisfiesNoWorkWindow(x.person, x.slotStart, x.restDays, cfg);
  });
}

// Exhaustive enumeration of every slot permutation and every rest pair for
// every person. No pruning, no ordering. `evalAt` receives
// { sl, pr, entries, reward, coverageOk, windowsOk }.
function bruteEnumerate(people, cfg, evalAt) {
  var slots = S.computeSlots(cfg, 0);
  var n = people.length;
  var sl = new Array(n), used = new Array(cfg.numSlots).fill(false);
  var pr = new Array(n);
  function rest(i) {
    if (i === n) {
      var entries = [];
      for (var k = 0; k < n; k++) {
        entries.push({
          person: people[k], slotIndex: sl[k], slotStart: slots[sl[k]], restDays: pr[k].slice()
        });
      }
      var reward = 0;
      entries.forEach(function (e) { reward += rewardManual(e, cfg); });
      evalAt({
        sl: sl.slice(), pr: pr.map(function (p) { return p.slice(); }),
        entries: entries, reward: reward,
        coverageOk: coverageOkManual(entries, cfg),
        windowsOk: windowsOkManual(entries, cfg)
      });
      return;
    }
    for (var p = 0; p < S.ADJACENT_PAIRS.length; p++) {
      pr[i] = S.ADJACENT_PAIRS[p];
      rest(i + 1);
    }
  }
  function slot(i) {
    if (i === n) { rest(0); return; }
    for (var s = 0; s < cfg.numSlots; s++) {
      if (used[s]) continue;
      used[s] = true; sl[i] = s;
      slot(i + 1);
      used[s] = false;
    }
  }
  slot(0);
}

function bruteReward(people, cfg) {
  var best = -Infinity, feasible = false;
  bruteEnumerate(people, cfg, function (c) {
    if (!c.coverageOk || !c.windowsOk) return;
    feasible = true;
    if (c.reward > best) best = c.reward;
  });
  return feasible ? { ok: true, score: best } : { ok: false, error: 'infeasible' };
}

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
  var people = [];
  for (var n = 0; n < opts.count; n++) {
    people.push({
      name: 'P' + n,
      shiftWeights: makeWeights(rng, opts.cfg.numSlots),
      restWeights: makeWeights(rng, S.ADJACENT_PAIRS.length),
      priority: rng() < 0.5 ? 'rest' : 'hours',
      noWorkWindow: null
    });
  }
  if (opts.windowIndex != null) people[opts.windowIndex].noWorkWindow = opts.window;
  return { label: opts.label, cfg: opts.cfg, people: people };
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
check('history absent => achieved total equals the exact maximum (no fairness trade)',
  approx(res.score, res.maxTotal, 1e-9));

var below = 0;
res.grid.forEach(function (row) { row.forEach(function (v) { if (v < 2) below++; }); });
eq('returned grid has zero hours below 2', below, 0);

var daph = null;
res.assignment.forEach(function (a) { if (a.name === 'Daphine') daph = a; });
var daphPerson = S.defaultPeople.filter(function (p) { return p.name === 'Daphine'; })[0];
check('Daphine present', !!daph);
check('Daphine is never on duty inside her no-work window',
  daph && S.satisfiesNoWorkWindow(daphPerson, daph.slotStart, daph.restDays, config) === true);
check('Daphine is flattened (all effective shift weights equal)',
  S.effectiveWeights(daphPerson, config).shiftWeights.every(function (v) {
    return Math.abs(v - 100 / config.numSlots) < 1e-9;
  }));

var ENTRY_FIELDS = ['name', 'slotIndex', 'slotLetter', 'slotStart', 'restDays',
  'restDayNames', 'priority', 'slotPoints', 'restPoints', 'priorityPoints', 'softPoints'];
var shapeProblem = null;
res.assignment.forEach(function (a) {
  var keys = Object.keys(a).sort();
  if (keys.join(',') !== ENTRY_FIELDS.slice().sort().join(',')) {
    shapeProblem = a.name + ': keys ' + keys.join(',');
  }
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
console.log('\n3. Shortcut safety: real solver vs dumb brute force (reward only)');
console.log('   The brute force enumerates ALL slot permutations and ALL 7 rest');
console.log('   pairs per person, checks coverage and windows, and uses effective');
console.log('   (flattened) weights. No pruning or ordering shortcuts.');
// =====================================================================

var cases = [
  makeCase(11, { label: 'case 1 (3 people, 3 slots, no coverage floor)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 0, numSlots: 3 }, count: 3 }),
  makeCase(12, { label: 'case 2 (4 people, 4 slots, no coverage floor)',
    cfg: { shiftLen: 24, stagger: 6, minCoverage: 0, numSlots: 4 }, count: 4 }),
  makeCase(13, { label: 'case 3 (3 people, 3 slots, minimum coverage 1)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3 }),
  makeCase(14, { label: 'case 4 (4 people, 4 slots, minimum coverage 1)',
    cfg: { shiftLen: 12, stagger: 6, minCoverage: 1, numSlots: 4 }, count: 4 }),
  makeCase(15, { label: 'case 5 (3 people, 3 slots, no-work window on P1)',
    cfg: { shiftLen: 24, stagger: 8, minCoverage: 1, numSlots: 3 }, count: 3,
    windowIndex: 1, window: { startDay: 4, startHour: 18, endDay: 5, endHour: 18 } }),
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
  var dumb = bruteReward(c.people, c.cfg);
  var ms = Date.now() - t;
  if (real.ok !== dumb.ok) {
    check(c.label + ' -- ok flags agree (real=' + real.ok + ', brute=' + dumb.ok + ')', false);
  } else if (real.ok && !approx(real.score, dumb.score, 1e-9)) {
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
console.log('\n4. Bounded-fairness objective vs brute force (small history)');
// =====================================================================
var fc = makeCase(21, { label: 'fairness case',
  cfg: { shiftLen: 24, stagger: 8, minCoverage: 0, numSlots: 3 }, count: 3 });
var run1 = S.solve(fc.people, fc.cfg, {});
check('fairness case run 1 succeeds', run1.ok === true);
var history = S.appendHistory(null, S.buildRunRecord(run1.assignment, fc.people));
var pre = S.computeFairness(history, fc.people);

var LAM = S.FAIRNESS_LAMBDA, BAND = S.FAIRNESS_BAND;
var maxTotal = S.solve(fc.people, fc.cfg, {}).maxTotal;
var bandFloor = (1 - BAND) * maxTotal;

var bruteBest = -Infinity, bruteReward = -Infinity;
bruteEnumerate(fc.people, fc.cfg, function (c) {
  if (!c.coverageOk || !c.windowsOk) return;
  if (c.reward < bandFloor - 1e-9) return;
  var worst = -Infinity;
  for (var i = 0; i < fc.people.length; i++) {
    var ideal = pre.ideals[i];
    var rounds = pre.pastRounds[i] + 1;
    var sat = ideal <= 0 ? 1 : (pre.pastPoints[i] + rewardManual(c.entries[i], fc.cfg)) / (ideal * rounds);
    var sh = 1 - sat;
    if (sh > worst) worst = sh;
  }
  var obj = c.reward - LAM * worst;
  if (obj > bruteBest) { bruteBest = obj; bruteReward = c.reward; }
});

var fairRes = S.solve(fc.people, fc.cfg, { history: history });
var solverObj = fairRes.score - LAM * fairRes.fairness.worstShortfall;
check('fairness result succeeds', fairRes.ok === true);
check('fairness objective agrees with brute force (' + solverObj.toFixed(3) + ' vs ' + bruteBest.toFixed(3) + ')',
  approx(solverObj, bruteBest, 1e-4));
check('fairness total clears the band floor (' + fairRes.score.toFixed(2) + ' >= ' + bandFloor.toFixed(2) + ')',
  fairRes.score >= bandFloor - 1e-9);
check('fairness never exceeds the exact maximum', fairRes.score <= maxTotal + 1e-9);

// =====================================================================
console.log('\n5. Breaker model (points), no more "guarantee every miss"');
// =====================================================================
// A fresh history produces no breaker. A seeded breaker streak that has
// tripped is honoured (or dropped with a reason) and clears/carries.
check('fresh history produces no breaker guarantees',
  S.computeFairness(null, fc.people).breaker.length === 0);

var seeded = { version: S.HISTORY_VERSION, runs: [], fingerprints: {}, breaker: {} };
fc.people.forEach(function (p) { seeded.breaker[p.name] = { worstStreak: S.BREAKER_STREAK }; });
var seededRes = S.solve(fc.people, fc.cfg, { history: seeded, fairnessLambda: 0 });
check('seeded tripped breaker is reported as fired or dropped',
  (seededRes.fairness.breakerFired.length + seededRes.fairness.breakerDropped.length) === fc.people.length);
seededRes.fairness.breakerDropped.forEach(function (b) {
  check('dropped breaker has a reason: ' + b.name, typeof b.reason === 'string' && b.reason.length > 0);
});
seededRes.fairness.breakerFired.forEach(function (b) {
  check('fired breaker has a dimension/value: ' + b.name,
    (b.dimension === 'slot' || b.dimension === 'rest') && b.value != null);
});

console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

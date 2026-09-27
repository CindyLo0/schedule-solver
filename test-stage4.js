/* test-stage4.js
 *
 * Node-only multi-round debt / fairness / breaker tests. No DOM, no browser.
 * Run with:  node test-stage4.js
 *
 * It drives the same run sequence the app uses:
 *   computeFairness -> solve -> buildRunRecord -> appendHistory -> ...
 *
 * Checks:
 *   (a) hard coverage + no-work windows hold every round;
 *   (b) reproducibility (same inputs -> same output);
 *   (c) the raw total stays inside the band every round;
 *   (d) rotation debt lifts the bottom person smoothly and no one is left
 *       permanently far behind;
 *   (e) a window holder stays at ~100% satisfaction and never trips;
 *   (f) a preference change (new fingerprint) resets that person's history;
 *   (g) the circuit breaker fires on a deliberately extreme contested case
 *       and then resets (or carries when its guarantee is infeasible).
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;

var passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

function scheduleKey(assignment) {
  return assignment
    .map(function (a) { return a.name + '|slot=' + a.slotIndex + '|rest=' + S.pairKey(a.restDays); })
    .sort()
    .join(';');
}

function clonePeople(people) {
  return people.map(function (p) {
    return {
      name: p.name,
      shiftWeights: p.shiftWeights.slice(),
      restWeights: p.restWeights.slice(),
      priority: p.priority,
      noWorkWindow: p.noWorkWindow ? JSON.parse(JSON.stringify(p.noWorkWindow)) : null
    };
  });
}

function coverageOk(result) {
  var below = 0;
  result.grid.forEach(function (row) { row.forEach(function (v) { if (v < config.minCoverage) below++; }); });
  return below === 0;
}

function windowsOk(result, people) {
  var byName = {};
  people.forEach(function (p) { byName[p.name] = p; });
  var problems = [];
  result.assignment.forEach(function (a) {
    var p = byName[a.name];
    if (p && p.noWorkWindow && !S.satisfiesNoWorkWindow(p, a.slotStart, a.restDays, config)) {
      problems.push(a.name);
    }
  });
  return problems;
}

// Bottom (lowest) cumulative satisfaction in a post-run fairness block.
function bottomOf(fairness) {
  var mn = Infinity, who = null;
  fairness.entries.forEach(function (e) {
    if (e.satisfaction < mn) { mn = e.satisfaction; who = e.name; }
  });
  return { sat: mn, name: who };
}

function finalFairness(history, people) {
  var f = S.computeFairness(JSON.parse(JSON.stringify(history)), people, config, S.FAIRNESS_MU);
  var mn = Infinity, who = null;
  f.entries.forEach(function (e) { if (e.satisfaction < mn) { mn = e.satisfaction; who = e.name; } });
  return { min: mn, who: who, fairness: f };
}

// The contested dataset: random-looking but fixed; P0/P4 both top out on slot
// D (index 3), so at most one of them can get it.
var contested = [
  { name: 'P0', shiftWeights: [27, 26, 7, 93, 3, 42, 27, 26], restWeights: [27, 64, 73, 0, 58, 65, 10], priority: 'hours', noWorkWindow: null },
  { name: 'P1', shiftWeights: [18, 65, 66, 68, 34, 7, 38, 56], restWeights: [34, 14, 73, 11, 72, 46, 5], priority: 'hours', noWorkWindow: null },
  { name: 'P2', shiftWeights: [14, 74, 96, 83, 99, 51, 4, 46], restWeights: [69, 37, 84, 80, 23, 8, 3], priority: 'hours', noWorkWindow: null },
  { name: 'P3', shiftWeights: [51, 68, 6, 83, 34, 23, 80, 80], restWeights: [35, 16, 93, 26, 9, 1, 11], priority: 'rest', noWorkWindow: null },
  { name: 'P4', shiftWeights: [3, 20, 23, 99, 29, 16, 15, 20], restWeights: [32, 85, 80, 74, 90, 55, 59], priority: 'hours', noWorkWindow: null },
  { name: 'P5', shiftWeights: [94, 45, 48, 77, 33, 45, 10, 43], restWeights: [56, 8, 81, 78, 80, 64, 57], priority: 'rest', noWorkWindow: null },
  { name: 'P6', shiftWeights: [95, 79, 13, 13, 61, 28, 74, 64], restWeights: [6, 63, 38, 54, 68, 67, 50], priority: 'hours', noWorkWindow: null },
  { name: 'P7', shiftWeights: [36, 58, 35, 81, 100, 72, 74, 77], restWeights: [97, 19, 59, 15, 17, 31, 72], priority: 'hours', noWorkWindow: null }
];

console.log('Stage 4 tests — multi-round rotation debt / calibration\n');
console.log('Calibration in use:');
console.log('  SPLIT_PRIORITY         = ' + S.SPLIT_PRIORITY + ' + SPLIT_SOFT ' + S.SPLIT_SOFT);
console.log('  FAIRNESS_MU            = ' + S.FAIRNESS_MU + '  (personWeight = 1 + MU*debt)');
console.log('  FAIRNESS_BAND          = ' + S.FAIRNESS_BAND + '  (' + (S.FAIRNESS_BAND * 100).toFixed(1) + '% of the best raw total)');
console.log('  DECAY_HALF_LIFE        = ' + S.DECAY_HALF_LIFE);
console.log('  BREAKER_STREAK         = ' + S.BREAKER_STREAK);
console.log('  BREAKER_GAP            = ' + S.BREAKER_GAP + '  (' + (S.BREAKER_GAP * 100).toFixed(0) + ' score points)');
console.log('  BREAKER_RATIO          = ' + S.BREAKER_RATIO + 'x the next-worst shortfall');
console.log('  BREAKER_MIN_SHORTFALL  = ' + S.BREAKER_MIN_SHORTFALL);

// =====================================================================
console.log('\n1. Default dataset — app run sequence (10 rounds)');
// =====================================================================
var people = clonePeople(S.defaultPeople);
var history = null;
var rounds = 10;
var roundResults = [];
var roundKeys = [];
var bottomSeq = [];
var bottomNames = [];
var allCoverage = true, allWindows = true, allInBand = true;
var maxLossPct = 0;
for (var r = 0; r < rounds; r++) {
  var res = S.solve(people, config, { history: history });
  if (!res.ok) { check('round ' + (r + 1) + ' succeeds', false, res.error); break; }
  if (!coverageOk(res)) allCoverage = false;
  if (windowsOk(res, people).length) allWindows = false;
  var floor = (1 - S.FAIRNESS_BAND) * res.maxTotal;
  if (res.score < floor - 1e-6) allInBand = false;
  var loss = (res.maxTotal - res.score) / res.maxTotal;
  if (loss > maxLossPct) maxLossPct = loss;
  var b = bottomOf(res.fairness);
  bottomSeq.push(b.sat);
  bottomNames.push(b.name);
  roundResults.push(res);
  roundKeys.push(scheduleKey(res.assignment));
  history = S.appendHistory(history, S.buildRunRecord(res.assignment, people));
}
check('all ' + rounds + ' rounds succeeded', roundResults.length === rounds);
check('(a) coverage >= ' + config.minCoverage + ' every round', allCoverage);
check('(a) no-work windows respected every round', allWindows);
check('(c) every round stays inside the band', allInBand,
  'worst loss ' + (maxLossPct * 100).toFixed(2) + '%');
console.log('  observed worst-round raw cost: ' + (maxLossPct * 100).toFixed(2) + '% (band ' +
  (S.FAIRNESS_BAND * 100).toFixed(0) + '%)');

// (d) Rotation debt lifts the bottom smoothly and does not strand anyone.
// bottomSeq[r] is the minimum cumulative satisfaction right after round r+1.
var distinctBottoms = {};
bottomNames.forEach(function (n) { distinctBottoms[n] = true; });
check('(d) the run starts with a clear bottom person (sat ' + bottomSeq[0].toFixed(3) + ' < 0.76)',
  bottomSeq[0] < 0.76);
check('(d) the bottom is lifted by round 3 (' + bottomSeq[0].toFixed(3) + ' -> ' + bottomSeq[2].toFixed(3) + ')',
  bottomSeq[2] > bottomSeq[0] + 0.05);
var lateBottom = 0;
for (var lb = 4; lb < bottomSeq.length; lb++) lateBottom += bottomSeq[lb];
lateBottom /= (bottomSeq.length - 4);
check('(d) later rounds hold the bottom up (avg ' + lateBottom.toFixed(3) + ' > ' + (bottomSeq[0] + 0.04).toFixed(3) + ')',
  lateBottom > bottomSeq[0] + 0.04);
var finalMin = bottomOf(roundResults[roundResults.length - 1].fairness).sat;
check('(d) no one is left permanently low (final bottom ' + finalMin.toFixed(3) + ' >= 0.70)',
  finalMin >= 0.70);
check('(d) the worst-off rotates (distinct people: ' + Object.keys(distinctBottoms).join(', ') + ')',
  Object.keys(distinctBottoms).length >= 2);
console.log('  per-round worst-off (post-run):  ' + bottomNames.join(', '));
console.log('  per-round bottom satisfaction:   ' + bottomSeq.map(function (v) { return v.toFixed(3); }).join(', '));
console.log('  per-round breaker fired:         ' + roundResults.map(function (res, i) {
  return (i + 1) + ':' + (res.fairness.breakerFired.length ? res.fairness.breakerFired.map(function (b) { return b.name; }).join('+') : '-');
}).join(', '));
check('(g) breaker stays rare on the calm default team (never fires)',
  roundResults.every(function (res) { return res.fairness.breakerFired.length === 0; }));

// (e) window holder stays at ~100% satisfaction and never trips.
var daph = S.defaultPeople.filter(function (p) { return p.noWorkWindow; })[0];
var daphAlwaysPerfect = true;
roundResults.forEach(function (res) {
  var e = res.fairness.entries.filter(function (x) { return x.name === daph.name; })[0];
  if (!e || !approx(e.satisfaction, 1, 1e-6) || !approx(e.shortfall, 0, 1e-6)) daphAlwaysPerfect = false;
  res.fairness.breakerFired.forEach(function (b) { if (b.name === daph.name) daphAlwaysPerfect = false; });
});
check('(e) window holder ' + daph.name + ' stays at ~100% satisfaction every round', daphAlwaysPerfect);
check('(e) window holder never trips the breaker (streak stays 0)',
  !history.breaker[daph.name] || history.breaker[daph.name].worstStreak === 0);

// (b) reproducibility: same history -> same schedule.
var histCopy = JSON.parse(JSON.stringify(history));
var peopleCopy = clonePeople(people);
var rerunA = S.solve(people, config, { history: JSON.parse(JSON.stringify(histCopy)) });
var rerunB = S.solve(peopleCopy, config, { history: JSON.parse(JSON.stringify(histCopy)) });
check('(b) two identical runs give the same schedule',
  rerunA.ok && rerunB.ok && scheduleKey(rerunA.assignment) === scheduleKey(rerunB.assignment));

// (f) preference edit resets only that person's history.
var before = {};
S.computeFairness(JSON.parse(JSON.stringify(history)), people).entries.forEach(function (e) { before[e.name] = e.rounds; });
var edited = clonePeople(people);
edited[0].shiftWeights[0] = edited[0].shiftWeights[0] + 1; // new fingerprint for Cindy
var afterHist = JSON.parse(JSON.stringify(history));
var after = {};
S.computeFairness(afterHist, edited).entries.forEach(function (e) { after[e.name] = e.rounds; });
check('(f) edited person\'s history is reset to zero',
  approx(after[edited[0].name], 0, 1e-9), edited[0].name + '=' + after[edited[0].name]);
var untouched = Object.keys(before).filter(function (n) { return n !== edited[0].name; })
  .every(function (n) { return approx(after[n], before[n], 1e-9); });
check('(f) everyone else\'s history is untouched', untouched);

// =====================================================================
console.log('\n2. Contested dataset — rotation debt lifts the bottom vs a MU=0 control');
// =====================================================================
function simulate(ppl, mu, nRounds) {
  var h = null;
  var out = { bottom: [], total: [], maxTotal: [], fired: 0 };
  for (var i = 0; i < nRounds; i++) {
    var res = S.solve(ppl, config, { history: h, fairnessMu: mu });
    if (!res.ok) break;
    h = S.appendHistory(h, S.buildRunRecord(res.assignment, ppl));
    out.bottom.push(res.fairness.worstShortfall);
    out.total.push(res.score);
    out.maxTotal.push(res.maxTotal);
    out.fired += res.fairness.breakerFired.length;
  }
  var end = finalFairness(h, ppl);
  out.finalMinSat = end.min;
  out.finalMinWho = end.who;
  return out;
}

var ctrl = simulate(clonePeople(contested), 0, 10);
var fair = simulate(clonePeople(contested), S.FAIRNESS_MU, 10);
check('contested control simulation completed', ctrl.total.length === 10);
check('contested fairness simulation completed', fair.total.length === 10);

console.log('  control final bottom: ' + ctrl.finalMinWho + ' at ' + ctrl.finalMinSat.toFixed(3));
console.log('  fairness final bottom: ' + fair.finalMinWho + ' at ' + fair.finalMinSat.toFixed(3));
check('(c) rotation debt lifts the bottom person (' + ctrl.finalMinSat.toFixed(3) + ' -> ' + fair.finalMinSat.toFixed(3) + ')',
  fair.finalMinSat > ctrl.finalMinSat + 0.05);

var inBand = true, cMaxLoss = 0;
for (var ci = 0; ci < fair.total.length; ci++) {
  var cfloor = (1 - S.FAIRNESS_BAND) * fair.maxTotal[ci];
  if (fair.total[ci] < cfloor - 1e-6) inBand = false;
  var closs = (fair.maxTotal[ci] - fair.total[ci]) / fair.maxTotal[ci];
  if (closs > cMaxLoss) cMaxLoss = closs;
}
check('(c) every fairness round stays inside the band', inBand);
console.log('  observed worst-round reward cost: ' + (cMaxLoss * 100).toFixed(2) + '% (band ' +
  (S.FAIRNESS_BAND * 100).toFixed(0) + '%)');

// =====================================================================
console.log('\n3. Circuit breaker — fires on an extreme contested case, then resets/carries');
// =====================================================================
// With debt deliberately switched off (MU=0), the same person is the unique
// dramatic worst-off for three consecutive rounds, so the breaker fires on the
// fourth and hands them their top priority pick.
var bp = clonePeople(contested);
var bh = null;
var fireRound = -1, firedName = null, firedValue = null;
var streakAfterFire = null, worstWhoSeq = [];
for (var rr = 1; rr <= 6; rr++) {
  var bres = S.solve(bp, config, { history: bh, fairnessMu: 0 });
  if (!bres.ok) break;
  worstWhoSeq.push(bres.fairness.worstName);
  bh = S.appendHistory(bh, S.buildRunRecord(bres.assignment, bp));
  if (bres.fairness.breakerFired.length && fireRound < 0) {
    fireRound = rr;
    firedName = bres.fairness.breakerFired[0].name;
    firedValue = bres.fairness.breakerFired[0].value;
    var entry = bres.assignment.filter(function (a) { return a.name === firedName; })[0];
    var person = bp.filter(function (p) { return p.name === firedName; })[0];
    var gotTop = S.weightOf(S.effectiveWeights(person, config).shiftWeights, entry.slotIndex, 'hours') ===
      Math.max.apply(null, person.shiftWeights);
    check('(d) firing round gives the guaranteed top priority pick to ' + firedName, gotTop);
    streakAfterFire = bh.breaker[firedName] ? bh.breaker[firedName].worstStreak : null;
  }
}
check('(d) breaker fired within 6 rounds', fireRound > 0);
check('(d) breaker fired for a persistently worst-off person', !!firedName);
check('(d) streak resets after the guarantee is applied', streakAfterFire === 0,
  'streak=' + streakAfterFire);
console.log('  worst-off sequence: ' + worstWhoSeq.join(', ') +
  '   fired round ' + fireRound + ' for ' + firedName + ' (value ' + firedValue + ')');

// Carry: two people both tripped on the SAME top slot -> only one can be
// satisfied; the other is dropped and its streak carries forward.
var carryHist = {
  version: S.HISTORY_VERSION, runs: [], fingerprints: {},
  breaker: { P0: { worstStreak: S.BREAKER_STREAK }, P4: { worstStreak: S.BREAKER_STREAK } }
};
var carryRes = S.solve(contested, config, { history: carryHist, fairnessMu: 0 });
check('(d) carry case: exactly one of the conflicting guarantees fires',
  carryRes.fairness.breakerFired.length === 1);
check('(d) carry case: the other is dropped with a reason',
  carryRes.fairness.breakerDropped.length === 1 &&
  typeof carryRes.fairness.breakerDropped[0].reason === 'string' &&
  carryRes.fairness.breakerDropped[0].reason.length > 0);
var droppedName = carryRes.fairness.breakerDropped[0].name;
var carried = S.appendHistory(carryHist, S.buildRunRecord(carryRes.assignment, contested));
check('(d) dropped person\'s streak carries forward (increments)',
  carried.breaker[droppedName].worstStreak > S.BREAKER_STREAK,
  droppedName + ' streak=' + carried.breaker[droppedName].worstStreak);

// =====================================================================
console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

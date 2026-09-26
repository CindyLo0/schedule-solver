/* verify.js
 *
 * Independent, DOM-free verification tool for the Shift Coverage Solver v2.
 *
 * It loads the default dataset, runs the solver, and checks HARD PROPERTIES
 * of the result (coverage, valid rest pairs, valid 9-hour shifts, the
 * no-work-window rule, the general weight-flattening rule, fairness result
 * consistency, reproducibility and grid shape). It does NOT check for one
 * specific expected schedule.
 *
 * Run:  node verify.js
 * Exit code is non-zero if any assertion fails.
 */

'use strict';

var Scheduler = require('./scheduler.js');

var config = Scheduler.config;
var defaultPeople = Scheduler.defaultPeople;

var HOURS_PER_DAY = Scheduler.HOURS_PER_DAY;   // 24
var DAYS_PER_WEEK = Scheduler.DAYS_PER_WEEK;   // 7
var HOURS_PER_WEEK = Scheduler.HOURS_PER_WEEK; // 168

var passes = 0;
var failures = 0;

function assert(condition, label, detail) {
  if (condition) {
    passes++;
    console.log('PASS  ' + label);
  } else {
    failures++;
    console.log('FAIL  ' + label + (detail ? '  -- ' + detail : ''));
  }
}

function section(title) {
  console.log('');
  console.log('== ' + title + ' ==');
}

// ---------------------------------------------------------------------
// Small independent helpers (re-implemented here on purpose).
// ---------------------------------------------------------------------

function mod(n, m) {
  return ((n % m) + m) % m;
}

function inWindow(a, win) {
  var start = win.startDay * HOURS_PER_DAY + win.startHour;
  var end = win.endDay * HOURS_PER_DAY + win.endHour;
  if (end <= start) end += HOURS_PER_WEEK;
  if (a >= start && a < end) return true;
  if (a + HOURS_PER_WEEK >= start && a + HOURS_PER_WEEK < end) return true;
  return false;
}

function scheduleKey(assignment) {
  return assignment
    .map(function (a) {
      return a.name + '|slot=' + a.slotIndex + '|rest=' + Scheduler.pairKey(a.restDays);
    })
    .sort()
    .join(';');
}

function recomputeCounts(assignment) {
  var counts = new Array(HOURS_PER_WEEK).fill(0);
  assignment.forEach(function (a) {
    var duty = Scheduler.personDutyHours(a.slotStart, a.restDays, config);
    duty.forEach(function (h) { counts[h] += 1; });
  });
  return counts;
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

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-6);
}

// ---------------------------------------------------------------------
// Main verification (synchronous)
// ---------------------------------------------------------------------

function main(result) {
  section('Run sync solve(defaultPeople, config)');
  console.log('ok=' + result.ok +
    (result.ok ? (', elapsedMs=' + result.elapsedMs) : (', error=' + result.error)));

  section('1. Solver success');
  assert(result.ok === true, 'solve() returns ok === true',
    result.ok ? '' : 'error=' + result.error);
  if (!result.ok) return;

  var assignment = result.assignment;

  section('2. Hard coverage (every one of 168 hours >= minCoverage)');
  var counts = recomputeCounts(assignment);
  var minHour = Infinity, maxHour = 0;
  for (var h = 0; h < HOURS_PER_WEEK; h++) {
    if (counts[h] < minHour) minHour = counts[h];
    if (counts[h] > maxHour) maxHour = counts[h];
  }
  var below = [];
  for (var h2 = 0; h2 < HOURS_PER_WEEK; h2++) {
    if (counts[h2] < config.minCoverage) below.push(h2);
  }
  assert(below.length === 0, 'every hour meets minCoverage=' + config.minCoverage,
    'hours below min: ' + below.slice(0, 10).join(','));
  console.log('      recomputed min/max headcount: ' + minHour + '/' + maxHour);

  var recomputedGrid = countsToGrid(counts);
  var gridMatches = true;
  for (var d = 0; d < DAYS_PER_WEEK && gridMatches; d++) {
    for (var hh = 0; hh < HOURS_PER_DAY; hh++) {
      if (result.grid[d][hh] !== recomputedGrid[d][hh]) { gridMatches = false; break; }
    }
  }
  assert(gridMatches, 'returned grid matches independently recomputed grid');

  section('3. Rest pairs are two consecutive days (cyclic, no duplicates)');
  var badPairs = [];
  assignment.forEach(function (a) {
    var r = a.restDays;
    var okShape = Array.isArray(r) && r.length === 2 &&
      typeof r[0] === 'number' && typeof r[1] === 'number';
    if (!okShape) { badPairs.push(a.name + ': malformed ' + JSON.stringify(r)); return; }
    var d0 = mod(r[0], DAYS_PER_WEEK);
    var d1 = mod(r[1], DAYS_PER_WEEK);
    if (d0 === d1) { badPairs.push(a.name + ': duplicate day ' + d0); return; }
    if (mod(d1 - d0, DAYS_PER_WEEK) !== 1) {
      badPairs.push(a.name + ': not consecutive ' + d0 + ',' + d1);
    }
  });
  assert(badPairs.length === 0, 'all 8 rest pairs are two consecutive days',
    badPairs.join('; '));

  section('4. Each shift is exactly 9 consecutive hours with wraparound');
  var shiftProblems = [];
  assignment.forEach(function (a) {
    var restSet = {};
    a.restDays.forEach(function (d) { restSet[mod(d, DAYS_PER_WEEK)] = true; });
    var built = [];
    for (var d = 0; d < DAYS_PER_WEEK; d++) {
      if (restSet[d]) continue;
      for (var k = 0; k < config.shiftLen; k++) {
        built.push(mod(d * HOURS_PER_DAY + a.slotStart + k, HOURS_PER_WEEK));
      }
    }
    var duty = Scheduler.personDutyHours(a.slotStart, a.restDays, config);
    var seen = {};
    var dup = false;
    built.forEach(function (x) { if (seen[x]) dup = true; seen[x] = true; });
    if (dup) shiftProblems.push(a.name + ': duplicate hours in shift blocks');
    var builtSorted = built.slice().sort(function (x, y) { return x - y; });
    var dutySorted = duty.slice().sort(function (x, y) { return x - y; });
    if (builtSorted.join(',') !== dutySorted.join(',')) {
      shiftProblems.push(a.name + ': shift blocks != personDutyHours');
    }
  });
  assert(shiftProblems.length === 0, 'all shifts are 9 clean consecutive hours',
    shiftProblems.join('; '));

  section('4b. Weighted points (0..100) and priority/soft consistency (effective weights)');
  var byName = {};
  defaultPeople.forEach(function (p) { byName[p.name] = p; });
  var pointProblems = [];
  assignment.forEach(function (a) {
    var p = byName[a.name];
    if (!p) { pointProblems.push(a.name + ': not in dataset'); return; }
    var ew = Scheduler.effectiveWeights(p, config);
    ['slotPoints', 'restPoints', 'priorityPoints', 'softPoints'].forEach(function (f) {
      var v = a[f];
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) {
        pointProblems.push(a.name + ': ' + f + ' = ' + v + ' out of range');
      }
    });
    var expectedSlot = Scheduler.weightOf(ew.shiftWeights, a.slotIndex, 'hours');
    var expectedRest = Scheduler.weightOf(ew.restWeights, a.restDays, 'rest');
    if (a.slotPoints !== expectedSlot) {
      pointProblems.push(a.name + ': slotPoints ' + a.slotPoints + ' != ' + expectedSlot);
    }
    if (a.restPoints !== expectedRest) {
      pointProblems.push(a.name + ': restPoints ' + a.restPoints + ' != ' + expectedRest);
    }
    var expectedPriority = p.priority === 'rest' ? expectedRest : expectedSlot;
    var expectedSoft = p.priority === 'rest' ? expectedSlot : expectedRest;
    if (a.priorityPoints !== expectedPriority) {
      pointProblems.push(a.name + ': priorityPoints ' + a.priorityPoints + ' != ' + expectedPriority);
    }
    if (a.softPoints !== expectedSoft) {
      pointProblems.push(a.name + ': softPoints ' + a.softPoints + ' != ' + expectedSoft);
    }
  });
  assert(pointProblems.length === 0, 'every entry\'s points are in 0..100 and match the person\'s effective weights',
    pointProblems.join('; '));

  section('5. No-work window respected, and the general flattening rule');
  var windowPeople = defaultPeople.filter(function (p) { return p.noWorkWindow; });
  var windowProblems = [];
  windowPeople.forEach(function (person) {
    var entry = assignment.filter(function (a) { return a.name === person.name; })[0];
    if (!entry) { windowProblems.push(person.name + ': no assignment found'); return; }

    // (a) window actually respected, checked directly against duty hours.
    var respected = Scheduler.satisfiesNoWorkWindow(person, entry.slotStart, entry.restDays, config);
    var duty = Scheduler.personDutyHours(entry.slotStart, entry.restDays, config);
    var overlap = duty.filter(function (a) { return inWindow(a, person.noWorkWindow); });
    if (!respected) windowProblems.push(person.name + ': satisfiesNoWorkWindow false');
    if (overlap.length > 0) windowProblems.push(person.name + ': ' + overlap.length + ' duty hours inside window');

    // (b) general flattening: both effective dimensions are equal weights.
    var ew = Scheduler.effectiveWeights(person, config);
    var s0 = ew.shiftWeights[0], r0 = ew.restWeights[0];
    var flatSlots = ew.shiftWeights.every(function (v) { return Math.abs(v - s0) < 1e-9; });
    var flatRest = ew.restWeights.every(function (v) { return Math.abs(v - r0) < 1e-9; });
    if (!flatSlots) windowProblems.push(person.name + ': effective shift weights are not flat');
    if (!flatRest) windowProblems.push(person.name + ': effective rest weights are not flat');
    if (!approx(s0, 100 / config.numSlots, 1e-9)) {
      windowProblems.push(person.name + ': flattened slot value ' + s0 + ' != 100/numSlots');
    }
    if (!approx(r0, 100 / Scheduler.ADJACENT_PAIRS.length, 1e-9)) {
      windowProblems.push(person.name + ': flattened rest value ' + r0 + ' != 100/numPairs');
    }
  });
  assert(windowProblems.length === 0, 'all no-work-window people respect their window and are flattened',
    windowProblems.join('; '));

  section('5b. Window holders have ~100% satisfaction / zero shortfall');
  var fair = result.fairness;
  assert(fair && Array.isArray(fair.entries), 'result.fairness present with entries',
    fair ? '' : 'missing');
  if (fair && Array.isArray(fair.entries)) {
    var winSatProblems = [];
    windowPeople.forEach(function (person) {
      var fe = fair.entries.filter(function (e) { return e.name === person.name; })[0];
      if (!fe) { winSatProblems.push(person.name + ': no fairness entry'); return; }
      if (!approx(fe.satisfaction, 1, 1e-6)) {
        winSatProblems.push(person.name + ': satisfaction ' + fe.satisfaction + ' != 1');
      }
      if (!approx(fe.shortfall, 0, 1e-6)) {
        winSatProblems.push(person.name + ': shortfall ' + fe.shortfall + ' != 0');
      }
    });
    assert(winSatProblems.length === 0, 'window holders sit at ~100% satisfaction',
      winSatProblems.join('; '));
  }

  section('5c. result.fairness is internally consistent');
  if (fair) {
    var consistency = [];
    if (!approx(fair.achievedTotal, result.score, 1e-6)) {
      consistency.push('achievedTotal != score');
    }
    if (!(fair.maxTotal >= fair.achievedTotal - 1e-9)) {
      consistency.push('maxTotal < achievedTotal');
    }
    if (typeof fair.bandPercent !== 'number') consistency.push('bandPercent not a number');
    if (result.maxTotal !== fair.maxTotal) consistency.push('result.maxTotal != fairness.maxTotal');
    if (result.band !== Scheduler.FAIRNESS_BAND) consistency.push('result.band != FAIRNESS_BAND');
    if (fair.entries.length !== defaultPeople.length) consistency.push('entries count != people count');
    var maxShort = -Infinity;
    fair.entries.forEach(function (e) {
      if (e.ideal <= 0) return;
      if (!approx(e.shortfall, 1 - e.satisfaction, 1e-9)) consistency.push(e.name + ': shortfall != 1 - satisfaction');
      if (e.shortfall > maxShort) maxShort = e.shortfall;
    });
    if (!approx(fair.worstShortfall, maxShort, 1e-9)) consistency.push('worstShortfall != max entry shortfall');
    assert(consistency.length === 0, 'fairness totals, band, entries and worst all match',
      consistency.join('; '));
  }

  section('6. Reproducibility (two identical runs)');
  var result2 = Scheduler.solve(defaultPeople, config);
  var same = result2.ok === true &&
    scheduleKey(assignment) === scheduleKey(result2.assignment);
  assert(same, 'solve() twice gives the same schedule', same ? '' : 'schedules differ');

  section('7. Grid shape and total person-hours');
  var grid = result.grid;
  var shapeOk = Array.isArray(grid) && grid.length === DAYS_PER_WEEK;
  grid.forEach(function (row) {
    if (!Array.isArray(row) || row.length !== HOURS_PER_DAY) shapeOk = false;
  });
  assert(shapeOk, 'grid is 7 rows x 24 columns', shapeOk ? '' : 'unexpected grid shape');

  var workingDays = DAYS_PER_WEEK - 2;
  var expectedTotal = config.shiftLen * workingDays * defaultPeople.length;
  var total = 0;
  grid.forEach(function (row) { row.forEach(function (v) { total += v; }); });
  assert(total === expectedTotal, 'grid total === shiftLen * workdays * people (' + expectedTotal + ')',
    'got ' + total);

  section('Information: final schedule');
  assignment.forEach(function (a) {
    console.log('  ' + pad(a.name, 9) +
      ' slot ' + a.slotLetter +
      '  start ' + pad2(a.slotStart + ':00') +
      '  rest ' + a.restDayNames.join('-') +
      '  priority=' + a.priority +
      ' (priority points ' + a.priorityPoints + ', soft points ' + a.softPoints + ')');
  });
  console.log('  score=' + result.score +
    '  maxTotal=' + result.maxTotal +
    '  minCoverage=' + result.minCoverage +
    '  maxCoverage=' + result.maxCoverage +
    '  totalPersonHours=' + result.totalPersonHours);
  console.log('  ties=' + (result.tie ? result.tie.count : 'n/a') +
    '  seed=' + (result.tie ? result.tie.seed : 'n/a') +
    '  elapsedMs=' + result.elapsedMs);
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function pad2(s) { s = String(s); while (s.length < 5) s = '0' + s; return s; }

// ---------------------------------------------------------------------
// Async progress-snapshot regression
// ---------------------------------------------------------------------

async function asyncCheck(syncResult) {
  section('8. Async progress-snapshot regression');

  var snapshots = 0;
  var badSnapshot = null;

  var asyncResult = await Scheduler.solveAsync(defaultPeople, config, {
    onProgress: function (snap) {
      snapshots++;
      if (snap === undefined || snap === null) {
        badSnapshot = 'snapshot ' + snapshots + ' is null/undefined';
        throw new Error(badSnapshot);
      }
      if (typeof snap !== 'object') {
        badSnapshot = 'snapshot ' + snapshots + ' is not an object';
        throw new Error(badSnapshot);
      }
      var fields = ['outerChecked', 'totalOuter', 'innerChecked', 'hasBest', 'phase'];
      for (var i = 0; i < fields.length; i++) {
        if (!(fields[i] in snap)) {
          badSnapshot = 'snapshot ' + snapshots + ' missing ' + fields[i];
          throw new Error(badSnapshot);
        }
      }
      if (typeof snap.outerChecked !== 'number' ||
          typeof snap.totalOuter !== 'number' ||
          typeof snap.innerChecked !== 'number' ||
          typeof snap.hasBest !== 'boolean' ||
          typeof snap.phase !== 'string') {
        badSnapshot = 'snapshot ' + snapshots + ' has an ill-typed field';
        throw new Error(badSnapshot);
      }
    }
  });

  assert(badSnapshot === null, 'every progress snapshot is well-formed', badSnapshot || '');
  console.log('      snapshots observed: ' + snapshots);
  console.log('      async ok=' + asyncResult.ok);
  assert(asyncResult.ok === true, 'solveAsync() returns ok === true',
    asyncResult.ok ? '' : 'error=' + asyncResult.error);
  assert(syncResult.ok &&
    scheduleKey(syncResult.assignment) === scheduleKey(asyncResult.assignment),
    'async assignment deep-equals sync assignment');
}

function finish() {
  console.log('');
  console.log('========================================');
  console.log('  PASS: ' + passes + '   FAIL: ' + failures);
  console.log('  STATUS: ' + (failures === 0 ? 'PASS' : 'FAIL'));
  console.log('========================================');
  process.exit(failures ? 1 : 0);
}

var syncResult = Scheduler.solve(defaultPeople, config);
main(syncResult);

asyncCheck(syncResult).then(function () {
  finish();
}).catch(function (err) {
  failures++;
  console.log('FAIL  async regression threw: ' + (err && err.stack ? err.stack : err));
  finish();
});

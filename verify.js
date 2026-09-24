/* verify.js
 *
 * Independent, DOM-free verification tool for the Shift Coverage Solver.
 *
 * It loads the default dataset, runs the solver, and checks HARD PROPERTIES
 * of the result (coverage, valid rest pairs, valid 9-hour shifts, the
 * no-work-window rule, reproducibility and grid shape). It does NOT check for
 * one specific expected schedule.
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

// ---------------------------------------------------------------------
// Tiny assert helper: prints PASS/FAIL lines, counts them.
// ---------------------------------------------------------------------

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
// Small independent helpers (re-implemented here on purpose, so the
// verification does not just call the same code it is testing).
// ---------------------------------------------------------------------

function mod(n, m) {
  return ((n % m) + m) % m;
}

// Is absolute week-hour `a` inside the no-work window (Mon=0 based)?
// Mirrors the documented rule: window is [start, end), wrapping if needed.
function inWindow(a, win) {
  var start = win.startDay * HOURS_PER_DAY + win.startHour;
  var end = win.endDay * HOURS_PER_DAY + win.endHour;
  if (end <= start) end += HOURS_PER_WEEK;
  if (a >= start && a < end) return true;
  if (a + HOURS_PER_WEEK >= start && a + HOURS_PER_WEEK < end) return true;
  return false;
}

// Does at least one of the 7 adjacent rest pairs keep this person out of
// their window at this slot? (The same "workable" idea as the solver's
// slotWindowAllowed, implemented from satisfiesNoWorkWindow.)
function slotWorkable(person, slotStart) {
  if (!person.noWorkWindow) return true;
  for (var i = 0; i < Scheduler.ADJACENT_PAIRS.length; i++) {
    if (Scheduler.satisfiesNoWorkWindow(person, slotStart, Scheduler.ADJACENT_PAIRS[i], config)) {
      return true;
    }
  }
  return false;
}

// A stable per-person signature used to compare two schedules.
function scheduleKey(assignment) {
  return assignment
    .map(function (a) {
      return a.name + '|slot=' + a.slotIndex + '|rest=' + Scheduler.pairKey(a.restDays);
    })
    .sort()
    .join(';');
}

// Recompute the 168-hour headcount from the assignment alone.
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

// ---------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------

function main(result) {
  section('Run sync solve(defaultPeople, config)');
  console.log('ok=' + result.ok +
    (result.ok ? (', elapsedMs=' + result.elapsedMs) : (', error=' + result.error)));

  // 1. Solver succeeds --------------------------------------------------
  section('1. Solver success');
  assert(result.ok === true, 'solve() returns ok === true',
    result.ok ? '' : 'error=' + result.error);
  if (!result.ok) {
    // Nothing else can be checked without a schedule.
    return;
  }

  var assignment = result.assignment;

  // 2. Hard coverage, recomputed independently --------------------------
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

  // 3. Rest pairs are two genuinely consecutive days -------------------
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

  // 4. Shifts are exactly 9 consecutive hours, overnight wrap included --
  section('4. Each shift is exactly 9 consecutive hours with wraparound');
  var shiftProblems = [];
  assignment.forEach(function (a) {
    var restSet = {};
    a.restDays.forEach(function (d) { restSet[mod(d, DAYS_PER_WEEK)] = true; });

    // Build the 9-hour block for every working day, independently.
    var built = [];
    for (var d = 0; d < DAYS_PER_WEEK; d++) {
      if (restSet[d]) continue;
      for (var k = 0; k < config.shiftLen; k++) {
        built.push(mod(d * HOURS_PER_DAY + a.slotStart + k, HOURS_PER_WEEK));
      }
    }
    var duty = Scheduler.personDutyHours(a.slotStart, a.restDays, config);

    // No duplicates, nothing missing, same total.
    var seen = {};
    var dup = false, gap = false;
    built.forEach(function (x) { if (seen[x]) dup = true; seen[x] = true; });
    if (dup) { shiftProblems.push(a.name + ': duplicate hours in shift blocks'); }
    if (built.length !== duty.length) gap = true;

    var builtSorted = built.slice().sort(function (x, y) { return x - y; });
    var dutySorted = duty.slice().sort(function (x, y) { return x - y; });
    if (builtSorted.join(',') !== dutySorted.join(',')) gap = true;
    if (gap) { shiftProblems.push(a.name + ': shift blocks != personDutyHours'); }
  });
  assert(shiftProblems.length === 0, 'all shifts are 9 clean consecutive hours',
    shiftProblems.join('; '));

  // 5. No-work-window rule (Reading A) ----------------------------------
  section('5. No-work-window rule (Reading A)');
  console.log('      Condition used: assigned slot must be the maximal workable');
  console.log('      (rank, letter) combination (greater rank first, later letter');
  console.log('      first). If that fails, the simple sufficient condition is');
  console.log('      accepted: assigned is workable, unranked (rank === list');
  console.log('      length), and no later unranked slot is workable.');
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

    // (b) assigned slot is the least-preferred workable slot.
    var numSlots = config.numSlots;
    var workable = [];
    for (var s = 0; s < numSlots; s++) {
      if (slotWorkable(person, Scheduler.computeSlots(config, 0)[s])) workable.push(s);
    }
    var assignedWorkable = workable.indexOf(entry.slotIndex) >= 0;
    if (!assignedWorkable) windowProblems.push(person.name + ': assigned slot not workable');

    // Preference comparator: greater rank first, then later letter first.
    function cmp(a, b) {
      var ra = Scheduler.rankOf(person.shiftOptions, a, 'hours');
      var rb = Scheduler.rankOf(person.shiftOptions, b, 'hours');
      if (rb !== ra) return rb - ra;
      return b - a;
    }
    var ideal = workable.slice().sort(cmp)[0];
    var fullOk = (entry.slotIndex === ideal);

    // Simple sufficient condition for the default data.
    var assignedRank = Scheduler.rankOf(person.shiftOptions, entry.slotIndex, 'hours');
    var unranked = assignedRank === (person.shiftOptions || []).length;
    var laterUnrankedWorkable = workable.filter(function (s) {
      return s > entry.slotIndex &&
        Scheduler.rankOf(person.shiftOptions, s, 'hours') === (person.shiftOptions || []).length;
    });
    var simpleOk = assignedWorkable && unranked && laterUnrankedWorkable.length === 0;

    if (fullOk) {
      console.log('      ' + person.name + ': assigned ' + entry.slotLetter +
        ' is the maximal workable slot (full condition).');
    } else if (simpleOk) {
      console.log('      ' + person.name + ': assigned ' + entry.slotLetter +
        ' passes the simple sufficient condition.');
    } else {
      windowProblems.push(person.name + ': assigned ' + entry.slotLetter +
        ' is not least-preferred (ideal=' + Scheduler.SLOT_LETTERS[ideal] + ')');
    }
  });
  assert(windowProblems.length === 0, 'all no-work-window people satisfy Reading A',
    windowProblems.join('; '));

  // 6. Reproducibility --------------------------------------------------
  section('6. Reproducibility (two identical runs)');
  var result2 = Scheduler.solve(defaultPeople, config);
  var same = result2.ok === true &&
    scheduleKey(assignment) === scheduleKey(result2.assignment);
  assert(same, 'solve() twice gives the same schedule',
    same ? '' : 'schedules differ');

  // 7. Grid shape and total --------------------------------------------
  section('7. Grid shape and total person-hours');
  var grid = result.grid;
  var shapeOk = Array.isArray(grid) && grid.length === DAYS_PER_WEEK;
  grid.forEach(function (row) {
    if (!Array.isArray(row) || row.length !== HOURS_PER_DAY) shapeOk = false;
  });
  assert(shapeOk, 'grid is 7 rows x 24 columns',
    shapeOk ? '' : 'unexpected grid shape');

  var workingDays = DAYS_PER_WEEK - 2; // 7 consecutive days, 2 rest days
  var expectedTotal = config.shiftLen * workingDays * defaultPeople.length;
  var total = 0;
  grid.forEach(function (row) { row.forEach(function (v) { total += v; }); });
  assert(total === expectedTotal, 'grid total === shiftLen * workdays * people (' + expectedTotal + ')',
    'got ' + total);

  // ----- informational output -----------------------------------------
  section('Information: final schedule');
  assignment.forEach(function (a) {
    console.log('  ' + pad(a.name, 9) +
      ' slot ' + a.slotLetter +
      '  start ' + pad2(a.slotStart + ':00') +
      '  rest ' + a.restDayNames.join('-') +
      '  priority=' + a.priority +
      ' (rank ' + a.priorityRank + ', met=' + a.priorityMet + ')');
  });
  console.log('  score=' + result.score +
    '  minCoverage=' + result.minCoverage +
    '  maxCoverage=' + result.maxCoverage +
    '  totalPersonHours=' + result.totalPersonHours);
  console.log('  ties=' + (result.tie ? result.tie.count : 'n/a') +
    '  seed=' + (result.tie ? result.tie.seed : 'n/a') +
    '  elapsedMs=' + result.elapsedMs);
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
function pad2(s) {
  s = String(s);
  while (s.length < 5) s = '0' + s;
  return s;
}

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
        var f = fields[i];
        if (!(f in snap)) {
          badSnapshot = 'snapshot ' + snapshots + ' missing ' + f;
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

  assert(badSnapshot === null, 'every progress snapshot is well-formed',
    badSnapshot || '');
  console.log('      snapshots observed: ' + snapshots);
  console.log('      async ok=' + asyncResult.ok);
  assert(asyncResult.ok === true, 'solveAsync() returns ok === true',
    asyncResult.ok ? '' : 'error=' + asyncResult.error);
  assert(syncResult.ok &&
    scheduleKey(syncResult.assignment) === scheduleKey(asyncResult.assignment),
    'async assignment deep-equals sync assignment');
}

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------

function finish() {
  console.log('');
  console.log('========================================');
  console.log('  PASS: ' + passes + '   FAIL: ' + failures);
  console.log('  STATUS: ' + (failures === 0 ? 'PASS' : 'FAIL'));
  console.log('========================================');
  process.exit(failures ? 1 : 0);
}

// Run async section after the synchronous one so the sync result is available.
var syncResult = Scheduler.solve(defaultPeople, config);
main(syncResult);

asyncCheck(syncResult).then(function () {
  // finish() may already have run inside main(); if so this is unreachable.
  finish();
}).catch(function (err) {
  failures++;
  console.log('FAIL  async regression threw: ' + (err && err.stack ? err.stack : err));
  finish();
});

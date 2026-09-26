/* test-stage1.js
 *
 * Node-only checks for scheduler.js. No DOM, no browser.
 * Run with:  node test-stage1.js
 */

'use strict';

var Scheduler = require('./scheduler.js');
var config = Scheduler.config;
var S = Scheduler;

var passed = 0;
var failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.log('  FAIL  ' + label);
  }
}

function eq(label, actual, expected) {
  check(label + '  (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')',
        JSON.stringify(actual) === JSON.stringify(expected));
}

function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

console.log('Stage 1 tests — scheduler.js\n');

// ---------------------------------------------------------------------
console.log('1. Slot math');
eq('computeSlots(offset 0)', S.computeSlots(config, 0), [0, 3, 6, 9, 12, 15, 18, 21]);
eq('computeSlots(offset 1)', S.computeSlots(config, 1), [1, 4, 7, 10, 13, 16, 19, 22]);

// ---------------------------------------------------------------------
console.log('\n2. Overnight wraparound — a 22:00 shift runs into the next day');
var wrapAssignment = [{ name: 'NightOwl', slotIndex: 7, slotStart: 22, restDays: [] }];
var wrapGrid = S.buildCoverageGrid(wrapAssignment, config);

var dutySet = {};
S.personDutyHours(22, [], config).forEach(function (a) { dutySet[a] = true; });
eq('Mon 22:00 shift covers abs hours 22,23,24..30',
   [22, 23, 24, 25, 26, 27, 28, 29, 30].every(function (a) { return dutySet[a]; }), true);
check('Mon 22:00 shift does NOT cover abs hour 31 (Tue 07:00)', !dutySet[31]);
check('Mon 22:00 covered', wrapGrid[0][22] === 1);
check('Mon 23:00 covered', wrapGrid[0][23] === 1);
check('Tue 00:00 covered (wrapped)', wrapGrid[1][0] === 1);
check('Tue 06:00 covered (last hour)', wrapGrid[1][6] === 1);
check('Tue 07:00 NOT covered', wrapGrid[1][7] === 0);
var sundayWrap = S.buildCoverageGrid(
  [{ name: 'X', slotIndex: 7, slotStart: 22, restDays: [0, 1, 2, 3, 4, 5] }], config);
check('Sun-night shift covers Sun 22,23 and Mon 00..06 via week wrap',
      sundayWrap[6][22] === 1 && sundayWrap[6][23] === 1 &&
      sundayWrap[0][0] === 1 && sundayWrap[0][6] === 1);
check('Sun-night shift does NOT reach Mon 07:00', sundayWrap[0][7] === 0);

// ---------------------------------------------------------------------
console.log('\n3. Daphine — no-work window Fri 18:00 -> Sat 18:00 and weight flattening');
var daphine = S.defaultPeople.filter(function (p) { return p.name === 'Daphine'; })[0];
check('Daphine found in default dataset', !!daphine);
check('Daphine prioritises rest', daphine && daphine.priority === 'rest');
check('Daphine shiftWeights has 8 entries and restWeights has 7',
      daphine && daphine.shiftWeights.length === 8 && daphine.restWeights.length === 7);
check('Daphine no-work window is Fri 18:00 -> Sat 18:00',
      daphine && daphine.noWorkWindow &&
      daphine.noWorkWindow.startDay === 4 && daphine.noWorkWindow.startHour === 18 &&
      daphine.noWorkWindow.endDay === 5 && daphine.noWorkWindow.endHour === 18);

var daphEff = S.effectiveWeights(daphine, config);
check('effective shift weights all equal 100/numSlots',
      daphEff.shiftWeights.every(function (v) { return approx(v, 100 / config.numSlots); }));
check('effective rest weights all equal 100/numPairs',
      daphEff.restWeights.every(function (v) { return approx(v, 100 / S.ADJACENT_PAIRS.length); }));

check('Daphine at 19:00 with Thu-Fri off satisfies the window',
      S.satisfiesNoWorkWindow(daphine, 19, [3, 4], config) === true);
check('Daphine at 19:00 WITHOUT Friday off violates the window',
      S.satisfiesNoWorkWindow(daphine, 19, [3, 2], config) === false);
check('Daphine at 15:00 with Thu-Fri off still violates (Sat 15:00-18:00 is inside window)',
      S.satisfiesNoWorkWindow(daphine, 15, [3, 4], config) === false);
check('Non-window person always passes',
      S.satisfiesNoWorkWindow(S.defaultPeople[0], 15, [3, 4], config) === true);

// ---------------------------------------------------------------------
console.log('\n4. Hand-built full 8-person assignment -> coverage grid');
var slotsOff1 = S.computeSlots(config, 1);
var full = [
  { person: S.defaultPeople[0], name: 'Cindy',   slotIndex: 0, slotStart: slotsOff1[0], restDays: [2, 3] },
  { person: S.defaultPeople[1], name: 'Inah',    slotIndex: 1, slotStart: slotsOff1[1], restDays: [4, 5] },
  { person: S.defaultPeople[2], name: 'Daphine', slotIndex: 6, slotStart: slotsOff1[6], restDays: [3, 4] },
  { person: S.defaultPeople[3], name: 'Bing',    slotIndex: 3, slotStart: slotsOff1[3], restDays: [2, 3] },
  { person: S.defaultPeople[4], name: 'Phoebe',  slotIndex: 4, slotStart: slotsOff1[4], restDays: [5, 6] },
  { person: S.defaultPeople[5], name: 'Joan',    slotIndex: 5, slotStart: slotsOff1[5], restDays: [0, 1] },
  { person: S.defaultPeople[6], name: 'LA',      slotIndex: 2, slotStart: slotsOff1[2], restDays: [0, 1] },
  { person: S.defaultPeople[7], name: 'Sherie',  slotIndex: 7, slotStart: slotsOff1[7], restDays: [5, 6] }
];
check('Daphine is on slot G (19:00)', full[2].slotStart === 19);
var grid = S.buildCoverageGrid(full, config);

check('grid has 7 rows', grid.length === 7);
check('each row has 24 columns', grid.every(function (r) { return r.length === 24; }));
var total = 0, min = Infinity, max = 0;
grid.forEach(function (row) {
  row.forEach(function (v) { total += v; if (v < min) min = v; if (v > max) max = v; });
});
eq('total person-hours 8 * 5 days * 9 hrs = 360', total, 360);
check('min coverage >= 2 (hard constraint holds)', min >= 2);
check('max coverage is 3 (nothing overstaffed)', max === 3);
check('meetsCoverage(grid, 2) is true', S.meetsCoverage(grid, 2) === true);
check('meetsCoverage(grid, 3) is false', S.meetsCoverage(grid, 3) === false);

// ---------------------------------------------------------------------
console.log('\n5. scoreAssignment — weighted points on EFFECTIVE weights, higher is better');
// Daphine has a no-work window, so her effective weights are flat: every slot
// is 100/8 = 12.5 and every rest pair is 100/7. Priority 'rest' means
// 100 * (100/7) + 1 * 12.5 = 1441.0714..., whichever slot/pair she is given.
var daphFlat = 100 * (100 / S.ADJACENT_PAIRS.length) + 1 * (100 / config.numSlots);
var daphAny = [{ person: daphine, name: 'Daphine', slotIndex: 6, slotStart: 18, restDays: [4, 5] }];
check('Daphine scores her flat total 100*(100/7) + 12.5 whichever option',
  approx(S.scoreAssignment(daphAny, config), daphFlat, 1e-9));

var daphAny2 = [{ person: daphine, name: 'Daphine', slotIndex: 0, slotStart: 0, restDays: [0, 1] }];
check('Daphine scores the same flat total on a different option',
  approx(S.scoreAssignment(daphAny2, config), daphFlat, 1e-9));

var cindy = S.defaultPeople[0];
var cindyBest = [{ person: cindy, name: 'Cindy', slotIndex: 5, slotStart: 15, restDays: [0, 1] }];
// priority hours: 100 * slotPoints(32, 15:00) + 1 * restPoints(30, Mon-Tue) = 3230.
eq('Cindy on her top slot (15:00) and top rest pair scores 100*32 + 30 = 3230',
   S.scoreAssignment(cindyBest, config), 3230);

var cindyOff = [{ person: cindy, name: 'Cindy', slotIndex: 2, slotStart: 6, restDays: [1, 2] }];
// priority hours: 100 * slotPoints(12, 06:00) + 1 * restPoints(7, Tue-Wed) = 1207.
eq('Cindy slot 06:00 (12) and rest Tue-Wed (7) scores 100*12 + 7 = 1207',
   S.scoreAssignment(cindyOff, config), 1207);

var score = S.scoreAssignment(full, config);
check('scoreAssignment on the hand-built sheet returns a finite number',
      typeof score === 'number' && isFinite(score));
console.log('    hand-built assignment score (higher is better): ' + score);

// ---------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

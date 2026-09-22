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

console.log('Stage 1 tests — scheduler.js\n');

// ---------------------------------------------------------------------
console.log('1. Slot math');
eq('computeSlots(offset 0)', S.computeSlots(config, 0), [0, 3, 6, 9, 12, 15, 18, 21]);
eq('computeSlots(offset 1)', S.computeSlots(config, 1), [1, 4, 7, 10, 13, 16, 19, 22]);
eq('offsetForExactStart(19) = 1', S.offsetForExactStart(19, config), 1);
eq('slot landing at 19:00 is G (index 6)', S.slotForExactStart(19, config, 1), 6);

// ---------------------------------------------------------------------
console.log('\n2. Overnight wraparound — a 22:00 shift runs into the next day');
var wrapAssignment = [{
  name: 'NightOwl',
  slotIndex: 7,
  slotStart: 22,
  restDays: []
}];
var wrapGrid = S.buildCoverageGrid(wrapAssignment, config);

// Expected duty for the Monday shift: 22,23 then Tue 00..06.
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
// Cyclic week wrap: with only Sunday worked, the Sunday 22:00 shift spills
// into Monday 00:00-06:00 of this same week.
var sundayWrap = S.buildCoverageGrid(
  [{ name: 'X', slotIndex: 7, slotStart: 22, restDays: [0, 1, 2, 3, 4, 5] }], config);
check('Sun-night shift covers Sun 22,23 and Mon 00..06 via week wrap',
      sundayWrap[6][22] === 1 && sundayWrap[6][23] === 1 &&
      sundayWrap[0][0] === 1 && sundayWrap[0][6] === 1);
check('Sun-night shift does NOT reach Mon 07:00', sundayWrap[0][7] === 0);

// ---------------------------------------------------------------------
console.log('\n3. Daphine — no-work window Fri 18:00 -> Sat 18:00, slot at 19:00');
var daphine = S.defaultPeople.filter(function (p) { return p.name === 'Daphine'; })[0];
check('Daphine found in default dataset', !!daphine);
check('Daphine defaults are exactly as in PROMPT (19:00, rest priority)',
      daphine.exactStart === 19 && daphine.priority === 'rest');
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
// A known gap-free layout on the offset-1 grid (slots 1,4,...,22), with
// Daphine on slot G (19:00) and Thu-Fri off. Every slot used exactly once.
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
check('Daphine never on duty inside her window in this assignment',
      S.satisfiesNoWorkWindow(daphine, 19, [3, 4], config) === true);

console.log('\n  Coverage by day (headcount per hour):');
S.DAYS.forEach(function (day, d) {
  console.log('    ' + day + '  ' + grid[d].join(' '));
});

// ---------------------------------------------------------------------
console.log('\n5. scoreAssignment sanity');
var score = S.scoreAssignment(full, config);
check('scoreAssignment returns a finite number', typeof score === 'number' && isFinite(score));
console.log('    full assignment score (lower is better): ' + score);

// ---------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

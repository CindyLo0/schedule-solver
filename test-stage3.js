/* test-stage3.js
 *
 * Node-only checks for the generator-based solver.
 * Run with:  node test-stage3.js
 *
 * The critical part is section 3: solveAsync() must keep handing well-formed
 * progress snapshots to onProgress, all the way through a forced long run.
 * If any snapshot were `undefined` or missing a field, this test fails loudly.
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;

var passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label); }
}
function eq(label, actual, expected) {
  check(label + '  (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')',
        JSON.stringify(actual) === JSON.stringify(expected));
}

var SNAPSHOT_KEYS = ['outerChecked', 'totalOuter', 'innerChecked', 'hasBest', 'phase'];

// Throw loudly (rejects the async solve) if a snapshot is not a well-formed
// progress object. This is exactly the failure mode described in PROMPT.md.
function assertSnapshot(s) {
  if (s === undefined || s === null) {
    throw new Error('onProgress received ' + String(s) + ' instead of a snapshot object');
  }
  if (typeof s !== 'object') {
    throw new Error('onProgress received a ' + typeof s + ' instead of an object');
  }
  var keys = Object.keys(s).sort().join(',');
  if (keys !== SNAPSHOT_KEYS.slice().sort().join(',')) {
    throw new Error('snapshot has wrong keys: ' + keys);
  }
  if (typeof s.outerChecked !== 'number' || typeof s.totalOuter !== 'number' ||
      typeof s.innerChecked !== 'number' || typeof s.hasBest !== 'boolean' ||
      typeof s.phase !== 'string') {
    throw new Error('snapshot has a field of the wrong type: ' + JSON.stringify(s));
  }
}

function fmtHour(h) { return (h < 10 ? '0' : '') + h + ':00'; }

// A stable per-person signature, used to compare two schedules.
function scheduleKey(assignment) {
  return assignment
    .map(function (a) { return a.name + '|slot=' + a.slotIndex + '|rest=' + S.pairKey(a.restDays); })
    .sort()
    .join(';');
}

// =====================================================================
(async function main() {
  console.log('Stage 3 tests — generator solver / solveAsync()\n');

  // -------------------------------------------------------------------
  console.log('1. solve() on the default dataset is deterministic');
  // -------------------------------------------------------------------
  // The domain is open (phase 'open-domain'); the grid starts at 00:00.
  // Hard properties are covered by verify.js, so here we just pin the
  // result down and check that a second identical run matches it.
  var sync = S.solve(S.defaultPeople, config, {});
  var syncAgain = S.solve(S.defaultPeople, config, {});
  check('ok', sync.ok === true);
  eq('minCoverage', sync.minCoverage, 2);
  eq('maxCoverage', sync.maxCoverage, 3);
  eq('phase', sync.phase, 'open-domain');
  check('score is a finite number', typeof sync.score === 'number' && isFinite(sync.score));
  check('two identical runs give the same schedule',
        scheduleKey(sync.assignment) === scheduleKey(syncAgain.assignment));

  // -------------------------------------------------------------------
  console.log('\n2. solveAsync() on the default dataset');
  // -------------------------------------------------------------------
  var count = 0, shapes = {}, last = null;
  var asyncDefault = await S.solveAsync(S.defaultPeople, config, {
    onProgress: function (s) {
      assertSnapshot(s); // throws -> rejects the promise
      count++;
      shapes[Object.keys(s).sort().join(',')] = true;
      last = s;
    }
  });
  check('result matches solve() score', asyncDefault.score === sync.score);
  check('result matches solve() schedule',
        JSON.stringify(asyncDefault.assignment) === JSON.stringify(sync.assignment));
  check('onProgress was called at least once', count > 0);
  eq('exactly one snapshot shape was ever seen', Object.keys(shapes).length, 1);
  check('final snapshot reached hasBest=true', last && last.hasBest === true);
  console.log('        snapshots: ' + count + ', last: ' + JSON.stringify(last));

  // -------------------------------------------------------------------
  console.log('\n3. Forced long run: impossible minimum coverage');
  // -------------------------------------------------------------------
  // 8 people, one 12-hour shift every 3 hours, minimum 3 per hour. Because
  // everyone must rest 2 days, 3-per-hour is impossible, and the capacity is
  // still >= 1 in most hours so the inner rest-day search cannot short-circuit
  // — it must exhaust a large space before concluding "infeasible".
  var longPeople = [];
  for (var i = 0; i < 8; i++) {
    longPeople.push({
      name: 'P' + i,
      restOptions: [[4, 5]],
      shiftOptions: [i],
      priority: 'hours',
      exactStart: null,
      noWorkWindow: null
    });
  }
  var longCfg = { shiftLen: 12, stagger: 3, minCoverage: 3, numSlots: 8 };

  var longCount = 0, longShapes = {}, longBad = 0;
  var innerSnapshots = 0, prevOuter = -1, maxInner = 0, sawBestFalse = false, phaseSeen = {};
  var t0 = Date.now();
  var longRes = await S.solveAsync(longPeople, longCfg, {
    onProgress: function (s) {
      assertSnapshot(s); // throws -> rejects the promise
      longCount++;
      longShapes[Object.keys(s).sort().join(',')] = true;
      if (s.innerChecked > maxInner) maxInner = s.innerChecked;
      if (s.phase) phaseSeen[s.phase] = true;
      // An "inner" snapshot arrives while the same outer arrangement is still
      // being worked on (i.e. it did not come from the once-per-outer yield).
      if (s.outerChecked === prevOuter) innerSnapshots++;
      prevOuter = s.outerChecked;
      if (s.hasBest === false) sawBestFalse = true;
    }
  });
  var longMs = Date.now() - t0;

  check('long run correctly reports infeasible', longRes.ok === false && longRes.error === 'infeasible');
  check('long run took more than 1 second (genuinely long)', longMs > 1000);
  check('many progress snapshots arrived (> 100)', longCount > 100);
  check('every snapshot was well-formed (none undefined)', longBad === 0);
  eq('exactly one snapshot shape was ever seen', Object.keys(longShapes).length, 1);
  check('inner-search snapshots arrived too (same outer, repeated)', innerSnapshots > 0);
  check('innerChecked advanced well past the yield threshold', maxInner > 40000);
  check('hasBest stayed false throughout (no exit-early path)', sawBestFalse === true);
  console.log('        elapsed: ' + longMs + ' ms, snapshots: ' + longCount +
    ', inner snapshots: ' + innerSnapshots + ', max innerChecked: ' + maxInner);
  console.log('        phases seen: ' + JSON.stringify(Object.keys(phaseSeen)));

  // -------------------------------------------------------------------
  console.log('\n4. Nested yield* path under a small threshold');
  // -------------------------------------------------------------------
  // With a tiny yieldEvery the nested rest-day DFS yields internal snapshots
  // quickly; they must still be the same shape (this is the exact bug: a bare
  // `yield;` inside a nested generator would surface as `undefined` here).
  var nestedCount = 0, nestedShapes = {};
  var nestedRes = await S.solveAsync(longPeople, longCfg, {
    yieldEvery: 50,
    onProgress: function (s) {
      assertSnapshot(s);
      nestedCount++;
      nestedShapes[Object.keys(s).sort().join(',')] = true;
    }
  });
  check('nested run still reports infeasible', nestedRes.ok === false);
  check('nested run produced many snapshots', nestedCount > longCount);
  eq('nested run used exactly one snapshot shape', Object.keys(nestedShapes).length, 1);

  // -------------------------------------------------------------------
  console.log('\n----------------------------------------');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (err) {
  console.log('\n  FAIL  ' + (err && err.stack ? err.stack : err));
  console.log('\nA bad snapshot or internal error rejected the async solve.');
  process.exit(1);
});

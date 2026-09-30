/* test-stage6.js
 *
 * Node-only tests for the preferences file helpers (serialize / validate /
 * normalize). No DOM, no browser. Run with:  node test-stage6.js
 *
 * Covers:
 *   1. serialize -> JSON -> validate round-trips defaultPeople exactly
 *   2. bare array and bare { people:[...] } are both accepted
 *   3. malformed files are rejected with a clear message, input unchanged
 *   4. out-of-range weights are clamped to 0..100 and reported
 *   5. duplicate names warn but still succeed
 *   6. fingerprintOf is still exported and unchanged for a default person
 *   7. solve() determinism against the frozen baseline schedule
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;

var passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); }
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var j = 0; j < ka.length; j++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
    if (!deepEqual(a[ka[j]], b[ka[j]])) return false;
  }
  return true;
}

function personByName(people, name) {
  for (var i = 0; i < people.length; i++) if (people[i].name === name) return people[i];
  return null;
}

// The frozen baseline key from STEP 0 (name:slotIndex:restDays joined by |).
var BASELINE_KEY =
  'Cindy:5:1.2|Inah:3:3.4|Daphine:6:3.4|Bing:0:2.3|Phoebe:4:5.6|Joan:2:0.1|LA:1:5.6|Sherie:7:6.0';

function scheduleKey(result) {
  return result.assignment
    .map(function (a) { return a.name + ':' + a.slotIndex + ':' + a.restDays.join('.'); })
    .join('|');
}

console.log('Stage 6 tests — preferences file round-trip\n');

// =====================================================================
console.log('1. Round-trip: serialize -> JSON -> validate deep-equals defaultPeople');
// =====================================================================
var payload = S.serializePreferences(S.defaultPeople, 1);
check('serialize carries kind and version',
  payload.kind === S.PREF_KIND && payload.version === S.PREF_VERSION,
  'kind=' + payload.kind + ' version=' + payload.version);
check('serialize carries the seed', payload.tieSeed === 1);
check('serialize has an ISO exportedAt string',
  typeof payload.exportedAt === 'string' && !isNaN(Date.parse(payload.exportedAt)));

var reparsed = JSON.parse(JSON.stringify(payload));
var rt = S.validatePreferencesFile(reparsed);
check('validate accepts the round-tripped file', rt.ok === true, rt.error);
check('round-trip people deep-equal defaultPeople (order and numbers)',
  deepEqual(rt.people, S.defaultPeople),
  JSON.stringify(rt.people));
check('round-trip seed preserved', rt.tieSeed === 1);
check('no warnings on the clean default round-trip',
  rt.warnings.length === 0, JSON.stringify(rt.warnings));

// =====================================================================
console.log('\n2. Bare array and bare { people:[...] } both accepted');
// =====================================================================
var bareArray = S.validatePreferencesFile(clone(S.defaultPeople));
check('bare array accepted', bareArray.ok === true, bareArray.error);
check('bare array people deep-equal defaults', deepEqual(bareArray.people, S.defaultPeople));
check('bare array has a null seed', bareArray.tieSeed === null);

var bareObj = S.validatePreferencesFile({ people: clone(S.defaultPeople) });
check('bare { people:[...] } accepted', bareObj.ok === true, bareObj.error);
check('bare { people:[...] } people deep-equal defaults', deepEqual(bareObj.people, S.defaultPeople));

// =====================================================================
console.log('\n3. Rejections: clear error, input object unchanged');
// =====================================================================
var base = S.serializePreferences(S.defaultPeople, 1);

function rejectCase(label, makeObj) {
  var obj = makeObj();
  var before = JSON.stringify(obj);
  var res = S.validatePreferencesFile(obj);
  check('rejects: ' + label,
    res.ok === false && typeof res.error === 'string' && res.error.length > 0,
    JSON.stringify(res));
  check('  input unchanged: ' + label, JSON.stringify(obj) === before);
}

rejectCase('wrapped version 2', function () {
  var o = clone(base); o.version = 2; return o;
});
rejectCase('people not an array', function () {
  return { kind: S.PREF_KIND, version: S.PREF_VERSION, people: 'nope' };
});
rejectCase('people is an empty array', function () {
  return { kind: S.PREF_KIND, version: S.PREF_VERSION, people: [] };
});
rejectCase('shiftWeights length 7', function () {
  var o = clone(base); o.people[0].shiftWeights = o.people[0].shiftWeights.slice(0, 7); return o;
});
rejectCase('restWeights length 8', function () {
  var o = clone(base); o.people[0].restWeights = o.people[0].restWeights.concat([1]); return o;
});
rejectCase('a non-numeric weight', function () {
  var o = clone(base); o.people[0].shiftWeights[0] = 'x'; return o;
});
rejectCase('priority "both"', function () {
  var o = clone(base); o.people[0].priority = 'both'; return o;
});
rejectCase('noWorkWindow startHour 24', function () {
  var o = clone(base);
  var d = personByName(o.people, 'Daphine');
  d.noWorkWindow.startHour = 24;
  return o;
});
rejectCase('noWorkWindow missing a field', function () {
  var o = clone(base);
  var d = personByName(o.people, 'Daphine');
  delete d.noWorkWindow.endHour;
  return o;
});

// =====================================================================
console.log('\n4. Out-of-range weights are clamped to 0..100 with a warning');
// =====================================================================
var clampObj = S.serializePreferences(S.defaultPeople, 1);
clampObj.people[0].shiftWeights[0] = 150;
clampObj.people[0].restWeights[1] = -5;
var clampRes = S.validatePreferencesFile(clampObj);
check('clamped file still validates', clampRes.ok === true, clampRes.error);
check('high value clamped to 100', clampRes.ok && clampRes.people[0].shiftWeights[0] === 100,
  clampRes.ok ? String(clampRes.people[0].shiftWeights[0]) : 'n/a');
check('negative value clamped to 0', clampRes.ok && clampRes.people[0].restWeights[1] === 0,
  clampRes.ok ? String(clampRes.people[0].restWeights[1]) : 'n/a');
check('clamping reported in warnings',
  clampRes.ok && clampRes.warnings.some(function (w) { return /clamp/i.test(w); }),
  JSON.stringify(clampRes.warnings));

// =====================================================================
console.log('\n5. Duplicate names warn but still succeed');
// =====================================================================
var dupObj = S.serializePreferences(S.defaultPeople, 1);
dupObj.people[1].name = dupObj.people[0].name;
var dupRes = S.validatePreferencesFile(dupObj);
check('duplicate-name file still validates', dupRes.ok === true, dupRes.error);
check('duplicate name reported in warnings',
  dupRes.ok && dupRes.warnings.some(function (w) { return /duplicate/i.test(w); }),
  JSON.stringify(dupRes.warnings));

// =====================================================================
console.log('\n6. fingerprintOf is still exported and unchanged for a default person');
// =====================================================================
check('fingerprintOf is a function', typeof S.fingerprintOf === 'function');
var cindy = S.defaultPeople[0];
var expectedFp = cindy.priority + '|' + cindy.shiftWeights.join(',') + '|' +
  cindy.restWeights.join(',') + '|N';
check('fingerprintOf matches the documented format for Cindy',
  S.fingerprintOf(cindy, config) === expectedFp,
  S.fingerprintOf(cindy, config));
// A window holder is fingerprinted from its flattened effective weights.
var daphine = S.defaultPeople[2];
var eff = S.effectiveWeights(daphine, config);
var expectedDaph = eff.priority + '|' + eff.shiftWeights.join(',') + '|' +
  eff.restWeights.join(',') + '|W';
check('fingerprintOf matches the flattened format for Daphine',
  S.fingerprintOf(daphine, config) === expectedDaph,
  S.fingerprintOf(daphine, config));

// =====================================================================
console.log('\n7. Determinism: solve(defaultPeople, config, tieSeed 1) matches baseline');
// =====================================================================
var solved = S.solve(S.defaultPeople, config, { tieSeed: 1 });
check('solve succeeded', solved.ok === true, solved.error);
var key = scheduleKey(solved);
check('schedule key is byte-identical to the STEP 0 baseline',
  key === BASELINE_KEY,
  '\n    got:      ' + key + '\n    baseline: ' + BASELINE_KEY);

console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

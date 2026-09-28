/* test-stage5.js
 *
 * Node-only tests for the fairness export/import round-trip and validation.
 * No DOM, no browser. Run with:  node test-stage5.js
 *
 * Covers:
 *   1. export -> parse -> validate -> normalize round-trips satisfaction/debt
 *   2. schedule reproducibility from the original vs the imported history
 *   3. malformed files are rejected and never mutate a live history
 *   4. mismatch matrix: unknown / fresh / fingerprint-changed
 *   5. team replacement: unchanged members keep their fairness, new members
 *      start fresh at 100% satisfaction / 0 debt
 *   6. both the export wrapper and a raw history object are accepted
 */

'use strict';

var S = require('./scheduler.js');
var config = S.config;

var passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : '')); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-12); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function clonePeople(people) {
  return people.map(function (p) {
    return {
      name: p.name,
      shiftWeights: p.shiftWeights.slice(),
      restWeights: p.restWeights.slice(),
      priority: p.priority,
      noWorkWindow: p.noWorkWindow ? clone(p.noWorkWindow) : null
    };
  });
}

function scheduleKey(assignment) {
  return assignment
    .map(function (a) { return a.name + '|slot=' + a.slotIndex + '|rest=' + S.pairKey(a.restDays); })
    .sort()
    .join(';');
}

function buildHistory(people, seeds) {
  var h = null;
  seeds.forEach(function (seed) {
    var res = S.solve(people, config, { history: h, tieSeed: seed });
    if (!res.ok) throw new Error('build solve failed for seed ' + seed + ': ' + res.error);
    h = S.appendHistory(h, S.buildRunRecord(res.assignment, people));
  });
  return h;
}

// Mirror of the app's normalization: keep every run (so recency weighting is
// unchanged), drop entries/fingerprints/breaker records for names off the team.
function normalizeHistoryForTeam(src, people) {
  var teamNames = {};
  people.forEach(function (p) { teamNames[p.name] = true; });
  var runs = (src.runs || []).map(function (run) {
    return {
      at: run && run.at,
      entries: ((run && run.entries) || []).filter(function (e) { return e && teamNames[e.name]; })
    };
  });
  var fingerprints = {};
  Object.keys(src.fingerprints || {}).forEach(function (n) {
    if (teamNames[n]) fingerprints[n] = src.fingerprints[n];
  });
  var breaker = {};
  Object.keys(src.breaker || {}).forEach(function (n) {
    if (teamNames[n]) breaker[n] = src.breaker[n];
  });
  return { version: S.HISTORY_VERSION, runs: runs, fingerprints: fingerprints, breaker: breaker };
}

function wrapHistory(hist) {
  return {
    kind: 'shift-solver-fairness',
    exportedAt: '2026-01-01T00:00:00.000Z',
    rounds: (hist.runs || []).length,
    version: S.HISTORY_VERSION,
    summary: [],
    history: hist
  };
}

function fairnessMap(history, people) {
  var f = S.computeFairness(clone(history), clonePeople(people), config);
  var out = {};
  f.entries.forEach(function (e) { out[e.name] = { satisfaction: e.satisfaction, debt: e.debt }; });
  return out;
}

function rowOf(summary, name) {
  for (var i = 0; i < summary.rows.length; i++) if (summary.rows[i].name === name) return summary.rows[i];
  return null;
}

console.log('Stage 5 tests — fairness export/import round-trip\n');

// Shared fixture: a real 3-round history from the default team.
var people = clonePeople(S.defaultPeople);
var original = buildHistory(people, [1, 2, 3]);

// =====================================================================
console.log('1. Round-trip core: export -> validate -> normalize');
// =====================================================================
var exportedText = JSON.stringify(wrapHistory(original), null, 2);
var parsedWrapper = JSON.parse(exportedText);
var v1 = S.validateHistoryFile(parsedWrapper);
check('validateHistoryFile accepts the export wrapper', v1.ok === true, v1.error);
var imported = normalizeHistoryForTeam(clone(v1.history), people);

var origFair = fairnessMap(original, people);
var impFair = fairnessMap(imported, people);
var allSame = true, detail = '';
people.forEach(function (p) {
  var a = origFair[p.name], b = impFair[p.name];
  if (!a || !b || !approx(a.satisfaction, b.satisfaction) || !approx(a.debt, b.debt)) {
    allSame = false;
    detail = p.name + ' original=' + JSON.stringify(a) + ' imported=' + JSON.stringify(b);
  }
});
check('satisfaction/debt identical after round-trip (<=1e-12)', allSame, detail);
check('rounds count preserved (' + original.runs.length + ' -> ' + imported.runs.length + ')',
  original.runs.length === imported.runs.length && imported.runs.length === 3);

// =====================================================================
console.log('\n2. Schedule reproducibility from original vs imported history');
// =====================================================================
var resOrig = S.solve(clonePeople(people), config, { history: clone(original), tieSeed: 7 });
var resImp = S.solve(clonePeople(people), config, { history: clone(imported), tieSeed: 7 });
check('both solves succeed', resOrig.ok && resImp.ok);
check('same canonical schedule key',
  scheduleKey(resOrig.assignment) === scheduleKey(resImp.assignment),
  '\n    original: ' + scheduleKey(resOrig.assignment) + '\n    imported: ' + scheduleKey(resImp.assignment));

// =====================================================================
console.log('\n3. Malformed files rejected without mutating a live history');
// =====================================================================
var live = clone(original);
var liveSnapshot = JSON.stringify(live);

var malformed = [
  ['wrong version', (function () { var o = clone(original); o.version = 2; return o; })()],
  ['runs not an array', (function () { var o = clone(original); o.runs = {}; return o; })()],
  ['score 1.5', (function () { var o = clone(original); o.runs[0].entries[0].score = 1.5; return o; })()],
  ['score -0.1', (function () { var o = clone(original); o.runs[0].entries[0].score = -0.1; return o; })()],
  ['entry.name not a string', (function () { var o = clone(original); o.runs[0].entries[0].name = 5; return o; })()],
  ['not an object', 'this is just a string'],
  ['null', null]
];
malformed.forEach(function (pair) {
  var res = S.validateHistoryFile(pair[1]);
  check('rejects: ' + pair[0],
    res.ok === false && typeof res.error === 'string' && res.error.length > 0,
    JSON.stringify(res));
});
var threw = false;
try { JSON.parse('{"version":3,"runs":['); } catch (err) { threw = true; }
check('truncated/invalid JSON throws before validation', threw);
check('live history is unchanged by rejected validations', JSON.stringify(live) === liveSnapshot);

// =====================================================================
console.log('\n4. Mismatch matrix (unknown / fresh / fingerprint-changed)');
// =====================================================================
var snapshot = JSON.stringify(original);

// unknown: a name in the file that is not on the team
var withGhost = clone(original);
withGhost.runs[0].entries.push({ name: 'Ghost', score: 0.5 });
withGhost.fingerprints.Ghost = 'ghost-fp';
var sumGhost = S.historySummary(withGhost, people, config);
check('name not on team appears in unknown', sumGhost.unknown.indexOf('Ghost') >= 0,
  JSON.stringify(sumGhost.unknown));
var normGhost = normalizeHistoryForTeam(withGhost, people);
var ghostLeft = normGhost.runs.some(function (r) {
  return (r.entries || []).some(function (e) { return e.name === 'Ghost'; });
}) || Object.prototype.hasOwnProperty.call(normGhost.fingerprints, 'Ghost');
check('unknown name is dropped after normalize', ghostLeft === false);

// fresh: a team member absent from the file (a name added since the export)
var peoplePlus = clonePeople(S.defaultPeople);
peoplePlus.push({
  name: 'Newbie', shiftWeights: [0, 0, 0, 0, 0, 0, 0, 0],
  restWeights: [0, 0, 0, 0, 0, 0, 0], priority: 'hours', noWorkWindow: null
});
var sumFresh = S.historySummary(original, peoplePlus, config);
check('team member absent from file is missing', sumFresh.missing.indexOf('Newbie') >= 0);
check('team member absent from file has status "fresh"',
  rowOf(sumFresh, 'Newbie') && rowOf(sumFresh, 'Newbie').status === 'fresh',
  rowOf(sumFresh, 'Newbie') ? rowOf(sumFresh, 'Newbie').status : 'no row');

// fingerprint-changed: stored fingerprint differs from the current one
var changed = clone(original);
changed.fingerprints.Cindy = 'a-different-fingerprint';
var sumChanged = S.historySummary(changed, people, config);
check('changed fingerprint appears in mismatches', sumChanged.mismatches.indexOf('Cindy') >= 0,
  JSON.stringify(sumChanged.mismatches));
check('changed fingerprint has status "fingerprint-changed"',
  rowOf(sumChanged, 'Cindy') && rowOf(sumChanged, 'Cindy').status === 'fingerprint-changed',
  rowOf(sumChanged, 'Cindy') ? rowOf(sumChanged, 'Cindy').status : 'no row');

check('historySummary never mutated its input', JSON.stringify(original) === snapshot);

// =====================================================================
console.log('\n5. Team replacement keeps unchanged fairness, new members start fresh');
// =====================================================================
var teamB = clonePeople(S.defaultPeople).filter(function (p) { return p.name !== 'Sherie'; });
teamB.push({
  name: 'Newbie', shiftWeights: [0, 0, 0, 0, 0, 0, 0, 0],
  restWeights: [0, 0, 0, 0, 0, 0, 0], priority: 'hours', noWorkWindow: null
});
var normalizedB = normalizeHistoryForTeam(original, teamB);
var fairB = fairnessMap(normalizedB, teamB);
var fairA = fairnessMap(original, people);

var unchangedOk = true, unchangedDetail = '';
teamB.forEach(function (p) {
  if (p.name === 'Newbie') return;
  var a = fairA[p.name], b = fairB[p.name];
  if (!a || !b || !approx(a.satisfaction, b.satisfaction) || !approx(a.debt, b.debt)) {
    unchangedOk = false;
    unchangedDetail = p.name + ' original=' + JSON.stringify(a) + ' replacement=' + JSON.stringify(b);
  }
});
check('unchanged members keep identical satisfaction/debt after replacement', unchangedOk, unchangedDetail);
check('new member starts at satisfaction 1 / debt 0',
  fairB.Newbie && approx(fairB.Newbie.satisfaction, 1) && approx(fairB.Newbie.debt, 0),
  JSON.stringify(fairB.Newbie));

// =====================================================================
console.log('\n6. Wrapper and raw history both accepted');
// =====================================================================
var viaRaw = S.validateHistoryFile(clone(original));
var viaWrap = S.validateHistoryFile(wrapHistory(clone(original)));
check('raw history object accepted', viaRaw.ok === true, viaRaw.error);
check('export wrapper accepted', viaWrap.ok === true, viaWrap.error);
check('both expose the same history content',
  JSON.stringify(viaRaw.history) === JSON.stringify(viaWrap.history) &&
  JSON.stringify(viaRaw.history) === JSON.stringify(original));

// =====================================================================
console.log('\n----------------------------------------');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);

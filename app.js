/* app.js
 *
 * Interface for the Shift Coverage Solver: explanation, fixed constraints,
 * editable per-person preference weights, and the cross-run fairness view.
 *
 * State is a plain array of people in the same shape scheduler.js expects:
 *   { name, shiftWeights, restWeights, priority, noWorkWindow }
 * Each weight is 0..100; higher means more wanted.
 *
 * Fairness is scored in POINTS and SATISFACTION. The
 * engine flattens both weight lists of anyone with a no-work window, so this
 * screen shows those people their equal (flat) values and locks the boxes.
 */

(function () {
  'use strict';

  var S = window.Scheduler;
  var config = S.config;
  var NUM_SLOTS = config.numSlots;
  var NUM_PAIRS = S.ADJACENT_PAIRS.length;

  // ------------------------------------------------------------------
  // State (pre-loaded with the default dataset)
  // ------------------------------------------------------------------

  function clonePerson(p) {
    return {
      name: p.name,
      shiftWeights: p.shiftWeights.slice(),
      restWeights: p.restWeights.slice(),
      priority: p.priority, // 'rest' | 'hours'
      noWorkWindow: p.noWorkWindow
        ? {
            startDay: p.noWorkWindow.startDay,
            startHour: p.noWorkWindow.startHour,
            endDay: p.noWorkWindow.endDay,
            endHour: p.noWorkWindow.endHour
          }
        : null
    };
  }

  var state = S.defaultPeople.map(clonePerson);
  var views = []; // per-person DOM references

  // ------------------------------------------------------------------
  // Cross-run fairness history (persisted in this browser, version 2)
  // ------------------------------------------------------------------
  //
  // Shape: {
  //   version: 2,
  //   runs:      [ { at, entries:[ { name, points, slotPoints, restPoints,
  //                                  priorityPoints, softPoints, ideal, windowed } ] } ],
  //   fingerprints: { "<name>": "<string>" },
  //   breaker:      { "<name>": { worstStreak: <n> } }
  // }
  //
  // The v1 key is deliberately ignored, so old data can never be read here.

  var HISTORY_KEY = 'shift-solver-history-v2';
  var storageWorking = true;
  var history = loadHistory();

  function emptyHistory() {
    return {
      version: S.HISTORY_VERSION,
      runs: [],
      fingerprints: {},
      breaker: {}
    };
  }

  // Read the saved history, tolerating missing or corrupt data. Never throws:
  // anything missing, unreadable, or from an older version becomes an empty
  // version-2 history.
  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return emptyHistory();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return emptyHistory();
      if (parsed.version !== S.HISTORY_VERSION) return emptyHistory();
      if (!Array.isArray(parsed.runs)) return emptyHistory();
      return {
        version: S.HISTORY_VERSION,
        runs: parsed.runs,
        fingerprints: (parsed.fingerprints && typeof parsed.fingerprints === 'object')
          ? parsed.fingerprints : {},
        breaker: (parsed.breaker && typeof parsed.breaker === 'object')
          ? parsed.breaker : {}
      };
    } catch (err) {
      storageWorking = false;
      return emptyHistory();
    }
  }

  function saveHistory() {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      storageWorking = true;
    } catch (err) {
      storageWorking = false;
    }
  }

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function pairKey(pair) { return S.pairKey(pair); }
  function pairLabel(pair) { return S.DAYS[pair[0]] + '\u2013' + S.DAYS[pair[1]]; }
  function fmtHour(h) { return (h < 10 ? '0' : '') + h + ':00'; }

  function clampWeight(value) {
    var n = parseInt(value, 10);
    if (isNaN(n) || n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function sum(arr) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += arr[i];
    return t;
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  // A weight can be an integer typed by the person, or an engine-computed
  // equal value for a no-work-window person (e.g. 100 / 8). Show it short.
  function fmtWeight(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 10000) / 10000);
  }

  // The grid is fixed: the eight slots always start at 00:00, 03:00, ... 21:00.
  function currentSlots() {
    return S.computeSlots(config, 0);
  }

  function slotLabel(index) {
    return S.SLOT_LETTERS[index] + '  ' + fmtHour(currentSlots()[index]);
  }

  function swapClass(node, name, on) {
    if (on) node.classList.add(name); else node.classList.remove(name);
  }

  // The two weight lists the ENGINE will actually use for this person. For
  // anyone with a no-work window both lists are flattened to equal values
  // (each slot = 100/numSlots, each pair = 100/numPairs); the engine enforces
  // this, and the screen mirrors it. Everyone else keeps their own numbers.
  function effectiveWeightArrays(p) {
    if (typeof S.effectiveWeights === 'function') {
      try {
        var e = S.effectiveWeights(p);
        if (e && e.shiftWeights && e.restWeights) return e;
        if (Array.isArray(e) && e.length === 2 &&
            Array.isArray(e[0]) && Array.isArray(e[1])) {
          return { shiftWeights: e[0], restWeights: e[1] };
        }
      } catch (err) { /* fall through to the local copy */ }
    }
    if (p.noWorkWindow) {
      var shift = [], rest = [];
      for (var i = 0; i < NUM_SLOTS; i++) shift.push(100 / NUM_SLOTS);
      for (var j = 0; j < NUM_PAIRS; j++) rest.push(100 / NUM_PAIRS);
      return { shiftWeights: shift, restWeights: rest };
    }
    return { shiftWeights: p.shiftWeights, restWeights: p.restWeights };
  }

  // Normalise a satisfaction value to a 0..100 percentage number. The engine
  // may report it as a ratio (0..1) or already as a percentage.
  function satisfactionValue(entry) {
    if (!entry) return null;
    if (typeof entry.satisfaction === 'number' && isFinite(entry.satisfaction)) {
      var s = entry.satisfaction;
      if (s >= 0 && s <= 1.0000001) s *= 100;
      return s;
    }
    if (typeof entry.ideal === 'number' && entry.ideal > 0 &&
        typeof entry.points === 'number') {
      return 100 * entry.points / entry.ideal;
    }
    return null;
  }

  function fmtSatisfaction(entry) {
    var v = satisfactionValue(entry);
    return v === null ? '\u2014' : round1(v) + '%';
  }

  // ------------------------------------------------------------------
  // Fixed constraints panel
  // ------------------------------------------------------------------

  function renderConstraints() {
    var rows = [
      ['Shift length', config.shiftLen + ' hours', 'Each shift runs ' + config.shiftLen + ' hours straight.'],
      ['Stagger between shifts', config.stagger + ' hours', 'The slots start ' + config.stagger + ' hours apart, evenly across the day.'],
      ['Shift slots', config.numSlots + ' (A\u2013H)', 'Every person is assigned exactly one slot letter.'],
      ['Work days per person', '5 per week', '45 hours each, the same for everyone.'],
      ['Rest days per person', '2 per week', 'Normally a consecutive pair of days.'],
      ['Hard minimum coverage', config.minCoverage + ' people', 'Never fewer than ' + config.minCoverage + ' on duty, in every one of the 168 hours.'],
      ['Hours per week', '168', '24 hours \u00d7 7 days; the solver checks every one.']
    ];
    var tbody = document.querySelector('#constraint-table tbody');
    tbody.innerHTML = '';
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'constraint-name', row[0]));
      tr.appendChild(el('td', 'constraint-value', row[1]));
      tr.appendChild(el('td', 'constraint-meaning', row[2]));
      tbody.appendChild(tr);
    });
  }

  // ------------------------------------------------------------------
  // Person cards
  // ------------------------------------------------------------------

  function buildSelect(options, value, onChange) {
    var sel = document.createElement('select');
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onChange(parseInt(sel.value, 10)); });
    return sel;
  }

  function buildCard(person, index) {
    var view = { index: index };

    var card = el('article', 'person');

    // --- header: name + priority toggle ---
    var head = el('header', 'person-head');

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'person-name';
    nameInput.value = person.name;
    nameInput.setAttribute('aria-label', 'Name');
    nameInput.addEventListener('input', function () {
      state[index].name = nameInput.value;
      refreshFairness();
    });
    head.appendChild(nameInput);

    var pBlock = el('div', 'priority-block');
    pBlock.appendChild(el('span', 'priority-label', 'Priority:'));
    var group = el('div', 'toggle-group');
    var restBtn = el('button', null, 'Rest days');
    restBtn.type = 'button';
    restBtn.title = 'This person cares most about their rest-day pairs.';
    restBtn.addEventListener('click', function () {
      state[index].priority = 'rest';
      updatePerson(view);
      refreshStanding();
    });
    var hoursBtn = el('button', null, 'Work hours');
    hoursBtn.type = 'button';
    hoursBtn.title = 'This person cares most about their shift start times.';
    hoursBtn.addEventListener('click', function () {
      state[index].priority = 'hours';
      updatePerson(view);
      refreshStanding();
    });
    group.appendChild(restBtn);
    group.appendChild(hoursBtn);
    pBlock.appendChild(group);
    head.appendChild(pBlock);
    card.appendChild(head);

    // --- the no-work-window rule note (hidden unless it applies) ---
    var windowNote = el('p', 'window-note note',
      'Equal weight by rule (no-work-window people are indifferent; they take the leftover).');
    windowNote.hidden = true;
    card.appendChild(windowNote);

    // --- rest-day pairs dimension (weight 0..100 each) ---
    var restDim = el('div', 'dimension');
    var restHead = el('div', 'dim-head');
    restHead.appendChild(el('h4', null, 'Rest-day pairs (points 0\u2013100)'));
    var restTotal = el('span', 'dim-total', '');
    restHead.appendChild(restTotal);
    restDim.appendChild(restHead);
    var restInputs = [];
    var restGrid = el('div', 'weight-grid');
    S.ADJACENT_PAIRS.forEach(function (pair, i) {
      var cell = el('label', 'weight-cell');
      cell.appendChild(el('span', 'weight-name', pairLabel(pair)));
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'weight-input';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(person.restWeights[i]);
      input.addEventListener('input', function () { setWeight(view, 'rest', i, input); });
      input.addEventListener('blur', function () { snapWeight(input); });
      cell.appendChild(input);
      restGrid.appendChild(cell);
      restInputs.push(input);
    });
    restDim.appendChild(restGrid);
    card.appendChild(restDim);

    // --- shift slots dimension ---
    var hourDim = el('div', 'dimension');
    var hourHead = el('div', 'dim-head');
    hourHead.appendChild(el('h4', null, 'Shift slots (points 0\u2013100)'));
    var hourTotal = el('span', 'dim-total', '');
    hourHead.appendChild(hourTotal);
    hourDim.appendChild(hourHead);
    var hourInputs = [];
    var hourGrid = el('div', 'weight-grid');
    for (var si = 0; si < config.numSlots; si++) {
      (function (idx) {
        var cell = el('label', 'weight-cell');
        cell.appendChild(el('span', 'weight-name', slotLabel(idx)));
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'weight-input';
        input.min = '0';
        input.max = '100';
        input.step = '1';
        input.value = String(person.shiftWeights[idx]);
        input.addEventListener('input', function () { setWeight(view, 'hours', idx, input); });
        input.addEventListener('blur', function () { snapWeight(input); });
        cell.appendChild(input);
        hourGrid.appendChild(cell);
        hourInputs.push(input);
      })(si);
    }
    hourDim.appendChild(hourGrid);
    card.appendChild(hourDim);

    // --- advanced (collapsed) ---
    var adv = el('details', 'advanced');
    adv.appendChild(el('summary', null, 'Advanced (no-work window)'));
    var advBody = el('div', 'adv-body');

    var winRow = el('div', 'adv-row');
    var winLabel = el('label');
    var winEnabled = document.createElement('input');
    winEnabled.type = 'checkbox';
    winLabel.appendChild(winEnabled);
    winLabel.appendChild(el('span', null, 'Has a no-work window'));
    winRow.appendChild(winLabel);
    advBody.appendChild(winRow);

    var dayOptions = S.DAYS.map(function (d, i) { return { value: i, label: d }; });
    var hourOptions = [];
    for (var hh = 0; hh < 24; hh++) hourOptions.push({ value: hh, label: fmtHour(hh) });

    var winFields = el('div', 'adv-fields');
    var startDaySel = buildSelect(dayOptions, 4, readWindow);
    var startHourSel = buildSelect(hourOptions, 18, readWindow);
    var endDaySel = buildSelect(dayOptions, 5, readWindow);
    var endHourSel = buildSelect(hourOptions, 18, readWindow);
    winFields.appendChild(el('span', 'field-label', 'from'));
    winFields.appendChild(startDaySel);
    winFields.appendChild(startHourSel);
    winFields.appendChild(el('span', 'field-label', 'to'));
    winFields.appendChild(endDaySel);
    winFields.appendChild(endHourSel);
    advBody.appendChild(winFields);

    function readWindow() {
      if (!winEnabled.checked) return;
      state[index].noWorkWindow = {
        startDay: parseInt(startDaySel.value, 10),
        startHour: parseInt(startHourSel.value, 10),
        endDay: parseInt(endDaySel.value, 10),
        endHour: parseInt(endHourSel.value, 10)
      };
    }

    winEnabled.addEventListener('change', function () {
      if (winEnabled.checked) {
        readWindow();
        if (!state[index].noWorkWindow) {
          state[index].noWorkWindow = { startDay: 4, startHour: 18, endDay: 5, endHour: 18 };
        }
      } else {
        state[index].noWorkWindow = null;
      }
      updatePerson(view);
      refreshStanding();
    });

    adv.appendChild(advBody);
    card.appendChild(adv);

    view.card = card;
    view.nameInput = nameInput;
    view.restBtn = restBtn;
    view.hoursBtn = hoursBtn;
    view.restInputs = restInputs;
    view.hourInputs = hourInputs;
    view.restTotal = restTotal;
    view.hourTotal = hourTotal;
    view.windowNote = windowNote;
    view.winEnabled = winEnabled;
    view.winFields = winFields;
    view.startDaySel = startDaySel;
    view.startHourSel = startHourSel;
    view.endDaySel = endDaySel;
    view.endHourSel = endHourSel;
    return view;
  }

  function setWeight(view, kind, index, input) {
    if (state[view.index].noWorkWindow) return; // inputs are locked, values are equal by rule
    var raw = input.value;
    var v = clampWeight(raw);
    var arr = kind === 'rest' ? state[view.index].restWeights : state[view.index].shiftWeights;
    arr[index] = v;
    if (raw !== '' && String(v) !== raw) input.value = String(v);
    updateTotals(view);
    refreshStanding();
  }

  function snapWeight(input) {
    if (input.value === '') input.value = '0';
  }

  function updateTotals(view) {
    var p = state[view.index];
    var eff = effectiveWeightArrays(p);
    view.restTotal.textContent = 'Total ' + fmtWeight(sum(eff.restWeights)) + ' / 100';
    view.hourTotal.textContent = 'Total ' + fmtWeight(sum(eff.shiftWeights)) + ' / 100';
  }

  function updatePerson(view) {
    var p = state[view.index];

    swapClass(view.restBtn, 'active', p.priority === 'rest');
    swapClass(view.hoursBtn, 'active', p.priority === 'hours');

    // A no-work-window person is flattened to equal values by the engine, so
    // show those equal values and lock the boxes. Turning the window off
    // restores the person's own numbers, which are still held in state.
    var windowed = !!p.noWorkWindow;
    var eff = effectiveWeightArrays(p);

    for (var i = 0; i < NUM_SLOTS; i++) {
      view.hourInputs[i].value = fmtWeight(eff.shiftWeights[i]);
      view.hourInputs[i].disabled = windowed;
    }
    for (var r = 0; r < NUM_PAIRS; r++) {
      view.restInputs[r].value = fmtWeight(eff.restWeights[r]);
      view.restInputs[r].disabled = windowed;
    }
    updateTotals(view);
    view.windowNote.hidden = !windowed;

    view.winEnabled.checked = windowed;
    view.winFields.style.display = windowed ? 'flex' : 'none';
    view.startDaySel.disabled = !windowed;
    view.startHourSel.disabled = !windowed;
    view.endDaySel.disabled = !windowed;
    view.endHourSel.disabled = !windowed;
    if (windowed) {
      view.startDaySel.value = String(p.noWorkWindow.startDay);
      view.startHourSel.value = String(p.noWorkWindow.startHour);
      view.endDaySel.value = String(p.noWorkWindow.endDay);
      view.endHourSel.value = String(p.noWorkWindow.endHour);
    }
  }

  function updateAll() {
    views.forEach(updatePerson);
  }

  function renderPeople() {
    var list = document.getElementById('people-list');
    list.innerHTML = '';
    views = [];
    state.forEach(function (p, i) {
      var view = buildCard(p, i);
      views.push(view);
      list.appendChild(view.card);
    });
    updateAll();
  }

  // ------------------------------------------------------------------
  // Fairness (standing, ledger, recent runs) — points and satisfaction
  // ------------------------------------------------------------------

  function currentFairness(people) {
    if (typeof S.computeFairness !== 'function') return null;
    try {
      return S.computeFairness(history, people) || null;
    } catch (err) {
      return null;
    }
  }

  function fairnessEntries(f) {
    if (f && Array.isArray(f.entries)) return f.entries;
    return [];
  }

  function fairnessByName(f, name) {
    var list = fairnessEntries(f);
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) return list[i];
    }
    return null;
  }

  function breakerStreak(name) {
    var b = (history && history.breaker) || {};
    var rec = b[name];
    return (rec && typeof rec.worstStreak === 'number') ? rec.worstStreak : 0;
  }

  function entryPendingBreaker(entry) {
    return !!(entry && (entry.breakerPending || entry.pendingBreaker ||
      entry.breakerArmed || entry.breakered));
  }

  // Show who is behind, by satisfaction, with their running points, and flag
  // any pending breaker.
  function refreshStanding() {
    var box = document.getElementById('standing-box');
    if (!box) return;
    box.innerHTML = '';

    var f = currentFairness(state);
    var entries = fairnessEntries(f);
    if (!entries.length) {
      box.appendChild(el('p', 'note',
        'No runs recorded yet. Everyone starts level \u2014 the first run is a plain best-points search.'));
      return;
    }

    var nums = [];
    entries.forEach(function (e) {
      var v = satisfactionValue(e);
      if (v !== null) nums.push(v);
    });
    var minVal = nums.length ? Math.min.apply(null, nums) : null;
    var maxVal = nums.length ? Math.max.apply(null, nums) : null;
    var spread = (minVal !== null && maxVal !== null) ? (maxVal - minVal) : 0;

    var list = el('ul', 'standing-list');
    entries.slice().sort(function (a, b) {
      var av = satisfactionValue(a), bv = satisfactionValue(b);
      if (av === null) av = Infinity;
      if (bv === null) bv = Infinity;
      return av - bv;
    }).forEach(function (e) {
      var li = el('li', 'standing-item');
      var sat = satisfactionValue(e);
      var streak = breakerStreak(e.name);
      var pending = entryPendingBreaker(e) || streak > 0;

      var main = el('div', 'standing-main');
      main.appendChild(el('span', 'standing-name', e.name));
      main.appendChild(el('span', 'standing-sat', 'satisfaction ' + fmtSatisfaction(e)));
      var points = (typeof e.lifetimePoints === 'number') ? e.lifetimePoints
        : (typeof e.points === 'number' ? e.points : 0);
      var rounds = (typeof e.rounds === 'number')
        ? ' over ' + e.rounds + ' run' + (e.rounds === 1 ? '' : 's') : '';
      main.appendChild(el('span', 'standing-points', 'running points ' + points + rounds));
      li.appendChild(main);

      var marks = el('div', 'standing-marks');
      if (spread > 0.05 && sat !== null && Math.abs(sat - minVal) < 0.05) {
        marks.appendChild(el('span', 'standing-mark', 'near the bottom'));
      }
      if (pending) {
        marks.appendChild(el('span', 'standing-mark breaker',
          'pending breaker' + (streak > 0 ? ' (shortfall streak ' + streak + ')' : '')));
      }
      if (e.windowed) {
        marks.appendChild(el('span', 'standing-note',
          'has a no-work window \u2014 slot is chosen by rule'));
      }
      if (marks.childNodes.length) li.appendChild(marks);

      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function latestRunPoints(name) {
    var runs = (history && history.runs) || [];
    if (!runs.length) return null;
    var last = runs[runs.length - 1];
    var entries = (last && last.entries) || [];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === name) {
        return typeof entries[i].points === 'number' ? entries[i].points : null;
      }
    }
    return null;
  }

  function refreshLedger() {
    var tbody = document.querySelector('#ledger-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    var f = currentFairness(state);
    state.forEach(function (p) {
      var e = fairnessByName(f, p.name);
      var cumulative = e
        ? ((typeof e.lifetimePoints === 'number') ? e.lifetimePoints
          : (typeof e.points === 'number' ? e.points : 0))
        : 0;
      var latest = latestRunPoints(p.name);

      var tr = document.createElement('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, e ? fmtSatisfaction(e) : '\u2014'));
      tr.appendChild(el('td', 'points', String(cumulative)));
      tr.appendChild(el('td', 'points', latest === null ? '\u2014' : String(latest)));
      tbody.appendChild(tr);
    });
  }

  function refreshRecentRuns() {
    var box = document.getElementById('recent-runs');
    if (!box) return;
    box.innerHTML = '';

    var runs = (history && history.runs) || [];
    if (!runs.length) {
      box.appendChild(el('div', 'recent-none', 'No runs recorded yet in this browser.'));
      return;
    }

    var wrap = el('div', 'recent-runs');
    runs.slice().reverse().slice(0, 5).forEach(function (run) {
      var entries = (run && run.entries) || [];
      var total = 0;
      var worst = null;
      var worstPts = Infinity;
      entries.forEach(function (e) {
        var pts = (typeof e.points === 'number') ? e.points : 0;
        total += pts;
        if (pts < worstPts) { worstPts = pts; worst = e.name; }
      });

      var when = 'unknown time';
      try {
        var d = new Date(run.at);
        if (!isNaN(d.getTime())) when = d.toLocaleString();
      } catch (err) { /* keep the placeholder */ }

      var summary = entries.length + ' people, ' + total + ' points awarded';
      if (worst) summary += '; least to ' + worst + ' (' + worstPts + ' points)';

      var row = el('div', 'recent-run');
      row.appendChild(el('span', 'recent-when', when + ': '));
      row.appendChild(el('span', null, summary + '.'));
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  function refreshFairness() {
    refreshStanding();
    refreshLedger();
    refreshRecentRuns();
  }

  function downloadHistory() {
    var text = JSON.stringify(history, null, 2);
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'shift-solver-history.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (err) {
      logLine('Could not build the history download in this browser.');
    }
  }

  function wireHistoryControls() {
    var dl = document.getElementById('download-history');
    if (dl) dl.addEventListener('click', downloadHistory);

    var reset = document.getElementById('reset-history');
    var confirmBox = document.getElementById('reset-confirm');
    var yes = document.getElementById('reset-confirm-yes');
    var no = document.getElementById('reset-confirm-no');

    if (reset && confirmBox) {
      reset.addEventListener('click', function () { confirmBox.hidden = false; });
    }
    if (no && confirmBox) {
      no.addEventListener('click', function () { confirmBox.hidden = true; });
    }
    if (yes && confirmBox) {
      yes.addEventListener('click', function () {
        history = emptyHistory();
        saveHistory();
        confirmBox.hidden = true;
        refreshFairness();
        logLine('Fairness history cleared.');
      });
    }
  }

  // ------------------------------------------------------------------
  // Run, progress and log
  // ------------------------------------------------------------------

  var running = false;
  var lastRunPeople = null; // the exact people list the current results were solved from

  function logLine(text) {
    var log = document.getElementById('log');
    log.textContent += text + '\n';
    log.scrollTop = log.scrollHeight;
  }

  function statOrZero(stats, key) {
    return (stats && typeof stats[key] === 'number') ? stats[key] : 0;
  }

  function wireRun() {
    var btn = document.getElementById('run-btn');
    btn.addEventListener('click', function () {
      if (running) return;
      running = true;
      btn.disabled = true;

      var fill = document.getElementById('progress-fill');
      var ptext = document.getElementById('progress-text');
      document.getElementById('log').textContent = '';
      fill.style.width = '0%';
      ptext.textContent = 'running\u2026';

      logLine('Starting exhaustive search (open domain).');
      logLine('Preferences loaded for ' + state.length + ' people, ' + config.numSlots + ' slots.');

      var lastLog = 0, lastPhase = null, lastHasBest = false, snapshots = 0;
      var frozen = state.map(clonePerson); // snapshot so mid-run edits cannot disturb it
      lastRunPeople = frozen;

      logLine('Fairness history: ' + (history.runs || []).length + ' saved run' +
        ((history.runs || []).length === 1 ? '' : 's') + ' going into this run.');

      var seedInput = document.getElementById('tie-seed');
      var seed = parseInt(seedInput.value, 10);
      if (isNaN(seed)) { seed = S.DEFAULT_TIE_SEED; seedInput.value = String(seed); }
      logLine('Tie-break rule: seeded random draw (mulberry32), seed ' + seed + '.');

      S.solveAsync(frozen, config, {
        tieSeed: seed,
        history: history,
        onProgress: function (s) {
          if (!s || typeof s.outerChecked !== 'number' || typeof s.totalOuter !== 'number' ||
              typeof s.innerChecked !== 'number' || typeof s.hasBest !== 'boolean') {
            logLine('WARNING: malformed progress snapshot skipped.');
            return;
          }
          snapshots++;
          var frac = s.totalOuter ? (s.outerChecked / s.totalOuter) : 0;
          fill.style.width = Math.round(frac * 100) + '%';
          ptext.textContent = s.phase + ' | outer ' + s.outerChecked + '/' + s.totalOuter +
            ' | inner checks ' + s.innerChecked;

          if (s.phase !== lastPhase) {
            lastPhase = s.phase;
            logLine('Phase ' + s.phase + ': ' + s.totalOuter + ' outer arrangements to try.');
          }
          if (s.hasBest && !lastHasBest) {
            lastHasBest = true;
            logLine('First feasible schedule found; continuing to prove it is the best.');
          }
          if (Date.now() - lastLog > 250) {
            lastLog = Date.now();
            logLine('outer ' + s.outerChecked + '/' + s.totalOuter +
              ' | inner checks ' + s.innerChecked +
              ' | feasible yet: ' + (s.hasBest ? 'yes' : 'no'));
          }
        }
      }).then(function (result) {
        logLine('Search finished in ' + result.elapsedMs + ' ms (' + snapshots + ' progress updates).');
        if (result.ok) {
          logLine('Best points score ' + result.score + '. Coverage ' +
            result.minCoverage + ' to ' + result.maxCoverage + '.');
          logLine('Checked ' + statOrZero(result.stats, 'innerPerms') + ' slot arrangements and ' +
            statOrZero(result.stats, 'innerChecked') + ' coverage checks across ' +
            statOrZero(result.stats, 'outers') + ' outer arrangements.');
          if (result.tie) {
            logLine('Top-points schedules: ' + result.tie.count +
              (result.tie.count > 1
                ? ' (tied). Tie-break chose entry #' + (result.tie.chosenIndex + 1) +
                  ' using seed ' + result.tie.seed + '.'
                : ' (no tie).'));
          }
          if (result.fairness) {
            logLine('Fairness: awarded ' + result.fairness.achievedTotal + ' of a best-possible ' +
              result.fairness.maxTotal + ' points' +
              (typeof result.fairness.bandPercent === 'number'
                ? ' (band ' + fmtWeight(result.fairness.bandPercent) + '%)' : '') + '.');
            if (result.fairness.worstName) {
              logLine('Worst-off this run: ' + result.fairness.worstName +
                ' (short by ' + result.fairness.worstShortfall + ').');
            }
            var fired = (result.fairness.breakerFired || []).length;
            var dropped = (result.fairness.breakerDropped || []).length;
            if (fired) logLine('Fairness breaker applied for ' + fired + ' person(s).');
            if (dropped) logLine('Fairness breaker dropped for ' + dropped + ' person(s).');
          }
          var runRecord = S.buildRunRecord(result.assignment, frozen);
          history = S.appendHistory(history, runRecord);
          saveHistory();
          refreshFairness();
          logLine('Fairness history saved for the next run (' + history.runs.length +
            ' run' + (history.runs.length === 1 ? '' : 's') + ' recorded).');
        } else {
          logLine('No schedule produced: ' + result.error + '.');
        }
        renderResults(result);
        fill.style.width = '100%';
        ptext.textContent = 'done in ' + result.elapsedMs + ' ms';
      }).catch(function (err) {
        logLine('ERROR: ' + (err && err.message ? err.message : String(err)));
        ptext.textContent = 'error';
      }).then(function () {
        running = false;
        btn.disabled = false;
      });
    });
  }

  // ------------------------------------------------------------------
  // Results
  // ------------------------------------------------------------------

  function byName(result, name) {
    for (var i = 0; i < result.assignment.length; i++) {
      if (result.assignment[i].name === name) return result.assignment[i];
    }
    return null;
  }

  function personByName(people, name) {
    for (var i = 0; i < people.length; i++) {
      if (people[i].name === name) return people[i];
    }
    return null;
  }

  function coverageColor(count, min) {
    if (count < min) return { bg: '#c0392b', fg: '#ffffff' };
    if (count === min) return { bg: '#e8f2ea', fg: '#1a1a1a' };
    var extra = count - min;
    var shades = ['#c3e3cd', '#93cfac', '#63b98a', '#3a9d68', '#1f7d4c'];
    var bg = shades[Math.min(extra - 1, shades.length - 1)];
    return { bg: bg, fg: extra >= 3 ? '#ffffff' : '#1a1a1a' };
  }

  // Turn a breaker entry's dimension/value into plain words. The value may be
  // a slot index, a rest-pair array, or a rest-pair index.
  function breakerWhat(dimension, value) {
    if (dimension === 'slot') {
      if (typeof value === 'number' && S.SLOT_LETTERS[value]) return 'slot ' + S.SLOT_LETTERS[value];
      return 'a shift slot (' + value + ')';
    }
    if (Array.isArray(value)) return 'rest days ' + pairLabel(value);
    if (typeof value === 'number' && S.ADJACENT_PAIRS[value]) {
      return 'rest days ' + pairLabel(S.ADJACENT_PAIRS[value]);
    }
    return 'rest days (' + value + ')';
  }

  function renderResults(result) {
    document.getElementById('results-empty').hidden = true;
    document.getElementById('results').hidden = false;
    renderTie(result);
    renderSummary(result);
    renderSchedule(result);
    renderHeatmap(result);
    renderFairnessResult(result);
    renderExplanation(result);
  }

  function renderTie(result) {
    var box = document.getElementById('tie-note');
    box.innerHTML = '';

    if (!result.ok) {
      box.appendChild(el('p', null, 'No schedule was produced, so there was no tie to break.'));
      return;
    }

    var t = result.tie;
    if (!t || t.count <= 1) {
      box.appendChild(el('p', null,
        'No tie: a single schedule reached the top score of ' + result.score + '. The tie-break below was not needed.'));
      return;
    }

    box.appendChild(el('p', null,
      t.count + ' schedules tied at the top score of ' + result.score + '.'));

    var inter = (t.interchangeableGroups || []).map(function (g) {
      return g.filter(function (n) { return t.swingNames.indexOf(n) >= 0; });
    }).filter(function (g) { return g.length > 1; });
    inter.forEach(function (g) {
      box.appendChild(el('p', null,
        g.join(' and ') + ' entered identical weights, so either could have been the one to fall short.'));
    });

    box.appendChild(el('p', null,
      'Tie-break rule: ' + t.ruleLabel + ', seed ' + t.seed + '. The tied schedules are sorted by who holds ' +
      'which slot (by name), and the draw picked entry #' + (t.chosenIndex + 1) + ' of ' + t.count + '. ' +
      'The same seed and the same weights always give the same result; change the seed and press Run again to redraw.'));

    if (t.swingNames && t.swingNames.length) {
      box.appendChild(el('p', null,
        'People whose assignment changed between the tied schedules: ' + t.swingNames.join(', ') + '.'));
    }
    box.appendChild(el('p', 'note', t.definition));
  }

  function renderSummary(result) {
    var box = document.getElementById('summary-tiles');
    box.innerHTML = '';
    var tiles = [];

    if (!result.ok) {
      tiles.push({ label: 'Status', value: 'no schedule' });
      tiles.push({ label: 'Reason', value: result.error });
      tiles.push({ label: 'Solve time', value: result.elapsedMs + ' ms' });
    } else {
      var atMin = 0, above = 0;
      result.grid.forEach(function (row) {
        row.forEach(function (v) {
          if (v === result.minCoverage) atMin++;
          else if (v > result.minCoverage) above++;
        });
      });
      var prioritySum = result.assignment.reduce(function (s, a) { return s + a.priorityPoints; }, 0);
      var maxPriority = result.assignment.length * 100;
      tiles.push({ label: 'Minimum coverage', value: String(result.minCoverage) });
      tiles.push({ label: 'Maximum coverage', value: String(result.maxCoverage) });
      tiles.push({ label: 'Hours at minimum', value: String(atMin) });
      tiles.push({ label: 'Hours above minimum', value: String(above) });
      tiles.push({ label: 'Total scheduled hours', value: String(result.totalPersonHours) });
      tiles.push({ label: 'Priority weight points', value: prioritySum + ' / ' + maxPriority });
      if (result.fairness) {
        tiles.push({ label: 'Points awarded', value: String(result.fairness.achievedTotal) });
        tiles.push({ label: 'Best possible points', value: String(result.fairness.maxTotal) });
        if (typeof result.fairness.bandPercent === 'number') {
          tiles.push({ label: 'Fairness band', value: fmtWeight(result.fairness.bandPercent) + '%' });
        }
        if (result.fairness.worstName) {
          tiles.push({
            label: 'Worst-off this run',
            value: result.fairness.worstName + ' (' + result.fairness.worstShortfall + ' short)'
          });
        }
      }
      tiles.push({ label: 'Outer arrangements', value: String(statOrZero(result.stats, 'outers')) });
      tiles.push({ label: 'Coverage checks', value: String(statOrZero(result.stats, 'innerChecked')) });
      tiles.push({ label: 'Solve time', value: result.elapsedMs + ' ms' });
    }

    tiles.forEach(function (t) {
      var tile = el('div', 'tile');
      tile.appendChild(el('div', 'tile-label', t.label));
      tile.appendChild(el('div', 'tile-value', t.value));
      box.appendChild(tile);
    });
  }

  function renderSchedule(result) {
    var tbody = document.querySelector('#schedule-table tbody');
    tbody.innerHTML = '';
    if (!result.ok) return;

    result.assignment.forEach(function (a) {
      var tr = document.createElement('tr');

      tr.appendChild(el('td', null, a.name));
      tr.appendChild(el('td', null, a.slotLetter + ' ' + fmtHour(a.slotStart)));
      var end = (a.slotStart + config.shiftLen) % 24;
      tr.appendChild(el('td', null, fmtHour(a.slotStart) + '\u2013' + fmtHour(end)));
      tr.appendChild(el('td', null, a.restDayNames.join('\u2013')));
      tr.appendChild(el('td', null, a.priority === 'rest' ? 'Rest days' : 'Work hours'));
      tr.appendChild(el('td', 'points', String(a.priorityPoints)));
      tr.appendChild(el('td', 'points', String(a.softPoints)));

      tbody.appendChild(tr);
    });
  }

  function renderHeatmap(result) {
    var table = document.getElementById('heatmap-table');
    table.innerHTML = '';
    var min = result.ok ? result.minCoverage : config.minCoverage;

    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'day', ''));
    for (var h = 0; h < 24; h++) hr.appendChild(el('th', null, String(h)));
    thead.appendChild(hr);
    table.appendChild(thead);

    var counts = {};
    var tbody = el('tbody');
    S.DAYS.forEach(function (day, d) {
      var tr = el('tr');
      tr.appendChild(el('td', 'day', day));
      for (var hh = 0; hh < 24; hh++) {
        var c = result.ok ? result.grid[d][hh] : 0;
        counts[c] = true;
        var col = coverageColor(c, min);
        var td = el('td', null, String(c));
        td.style.backgroundColor = col.bg;
        td.style.color = col.fg;
        td.title = day + ' ' + fmtHour(hh) + ': ' + c + ' on duty';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var legend = document.getElementById('heatmap-legend');
    legend.innerHTML = '';
    var entries = [];
    if (min > 0) entries.push({ c: min - 1, label: 'below minimum' });
    entries.push({ c: min, label: 'at minimum (' + min + ')' });
    Object.keys(counts).map(Number).filter(function (c) { return c > min; }).sort(function (a, b) { return a - b; })
      .forEach(function (c) { entries.push({ c: c, label: c + ' people' }); });
    entries.forEach(function (e) {
      var item = el('div', 'legend-item');
      var sw = el('span', 'legend-swatch');
      sw.style.backgroundColor = coverageColor(e.c, min).bg;
      item.appendChild(sw);
      item.appendChild(el('span', null, e.label));
      legend.appendChild(item);
    });
  }

  // Post-run fairness: totals, the worst-off person, and any breaker that
  // fired or was dropped, with the engine's own reasons.
  function renderFairnessResult(result) {
    var box = document.getElementById('fairness-result');
    if (!box) return;
    box.innerHTML = '';

    var f = result.fairness;
    if (!f) {
      box.appendChild(el('p', 'note', 'No fairness detail was returned for this run.'));
      return;
    }

    box.appendChild(el('p', null,
      'This schedule awarded ' + f.achievedTotal + ' of a best-possible ' + f.maxTotal + ' points' +
      (typeof f.bandPercent === 'number'
        ? ', inside a fairness band of ' + fmtWeight(f.bandPercent) + '% of that best total.' : '.')));

    if (f.achievedTotal < f.maxTotal) {
      box.appendChild(el('p', null,
        'Fairness gave up ' + (f.maxTotal - f.achievedTotal) +
        ' points on purpose within that band, so no single person was left far behind.'));
    }

    if (f.worstName) {
      box.appendChild(el('p', null,
        'Furthest from their own ideal this run: ' + f.worstName +
        (typeof f.worstShortfall === 'number' ? ' (short by ' + f.worstShortfall + ' points).' : '.')));
    }

    appendBreakerList(box, 'Fairness breaker applied', f.breakerFired);
    appendBreakerList(box, 'Fairness breaker not applied', f.breakerDropped);
  }

  function appendBreakerList(box, heading, list) {
    if (!list || !list.length) return;
    box.appendChild(el('h4', 'sub-head', heading));
    var ul = el('ul', 'breaker-list');
    list.forEach(function (b) {
      var text = b.name + ' \u2014 ' + breakerWhat(b.dimension, b.value);
      text += b.reason ? ': ' + b.reason : '';
      ul.appendChild(el('li', null, text));
    });
    box.appendChild(ul);
  }

  function buildExplanation(result, people) {
    people = people || state;
    var out = [];

    if (!result.ok) {
      var msg;
      if (result.error === 'infeasible') {
        msg = 'The exhaustive search proved that no assignment can keep at least ' +
          config.minCoverage + ' people on duty in all 168 hours while respecting every ' +
          'no-work window and every pending fairness rule. No valid schedule exists for these weights.';
      } else if (result.error === 'exact-start-contradiction') {
        msg = 'Two requested exact start hours do not fall on the same ' + config.stagger +
          '-hour grid, so no single set of evenly spaced slots can satisfy both. Change one of the requested hours.';
      } else if (result.error === 'slot-conflict') {
        msg = 'Two people requested the same exact start hour, but only one person can hold a given slot.';
      } else {
        msg = 'The solver reported: ' + result.error + '.';
      }
      out.push({ h: 'No schedule', text: [msg] });
      return out;
    }

    var atMin = 0, above = 0;
    result.grid.forEach(function (row) {
      row.forEach(function (v) {
        if (v === result.minCoverage) atMin++;
        else if (v > result.minCoverage) above++;
      });
    });
    out.push({
      h: 'Coverage',
      text: ['Every one of the 168 hours meets the hard minimum of ' + config.minCoverage +
        '. ' + atMin + ' hours have exactly ' + result.minCoverage + ' people on duty and ' +
        above + ' hours have more, up to ' + result.maxCoverage + '.']
    });

    // Fairness: totals, band, and the worst-off person, all in points.
    var f = result.fairness;
    if (f) {
      var lines = [];
      lines.push('The best points total this group could theoretically reach is ' + f.maxTotal +
        '. This schedule awarded ' + f.achievedTotal + ' points' +
        (typeof f.bandPercent === 'number'
          ? ' \u2014 a deliberate choice kept within a ' + fmtWeight(f.bandPercent) +
            '% band of that best total.' : '.'));
      if (f.achievedTotal < f.maxTotal) {
        lines.push('That means ' + (f.maxTotal - f.achievedTotal) +
          ' points were given up inside the band so the worst-off person would not be left far behind.');
      }
      if (f.worstName) {
        lines.push('The person furthest from their own ideal this run was ' + f.worstName +
          (typeof f.worstShortfall === 'number' ? ', short by ' + f.worstShortfall + ' points.' : '.'));
      }
      out.push({ h: 'Fairness and points', text: lines });

      if (Array.isArray(f.breakerFired) && f.breakerFired.length) {
        out.push({
          h: 'Fairness breaker applied',
          text: f.breakerFired.map(function (b) {
            return b.name + ' was given ' + breakerWhat(b.dimension, b.value) + ' because ' +
              (b.reason || 'their fairness breaker fired this run') + '.';
          })
        });
      }
      if (Array.isArray(f.breakerDropped) && f.breakerDropped.length) {
        out.push({
          h: 'Fairness breaker not applied',
          text: f.breakerDropped.map(function (b) {
            return 'The fairness breaker for ' + b.name + ' (' + breakerWhat(b.dimension, b.value) +
              ') could not be applied' + (b.reason ? ': ' + b.reason : '') + '.';
          })
        });
      }
    }

    if (result.tie && result.tie.count > 1) {
      var t = result.tie;
      var tieText = t.count + ' different person-to-slot assignments all reached the top score of ' +
        result.score + '. The tie was broken by a ' + t.ruleLabel.toLowerCase() + ' with seed ' + t.seed +
        ', which selected entry #' + (t.chosenIndex + 1) + ' of ' + t.count + ' in a name-sorted list. ' +
        'Change the seed and press Run to redraw; the outcome never depends on the order people are listed.';
      var tInter = (t.interchangeableGroups || []).map(function (g) {
        return g.filter(function (n) { return t.swingNames.indexOf(n) >= 0; });
      }).filter(function (g) { return g.length > 1; });
      tInter.forEach(function (g) {
        tieText += ' ' + g.join(' and ') + ' entered identical weights, so either could have been the one to fall short.';
      });
      if (t.swingNames.length) {
        tieText += ' The assignment changed between the tied schedules for: ' + t.swingNames.join(', ') + '.';
      }
      out.push({ h: 'Tie-break', text: [tieText] });
    }

    people.filter(function (p) { return p.noWorkWindow; }).forEach(function (p) {
      var a = byName(result, p.name);
      if (!a) return;
      var w = p.noWorkWindow;
      out.push({
        h: 'No-work window: ' + p.name,
        text: [p.name + ' may never work between ' + S.DAYS[w.startDay] + ' ' + fmtHour(w.startHour) +
          ' and ' + S.DAYS[w.endDay] + ' ' + fmtHour(w.endHour) + '. Both of ' + p.name +
          '\u2019s weight lists are flattened to equal points by rule, so they are indifferent and take the ' +
          'leftover shift that keeps the window safe. Their assigned slot is ' + a.slotLetter +
          ' (starting ' + fmtHour(a.slotStart) + '), with rest days ' + a.restDayNames.join('\u2013') + '.']
      });
    });

    result.assignment.forEach(function (a) {
      var dim = a.priority === 'rest' ? 'rest-day pair' : 'shift slot';
      var other = a.priority === 'rest' ? 'shift slot' : 'rest-day pair';
      var fe = fairnessByName(f, a.name);
      var text = a.name + ' earned ' + a.priorityPoints + ' points on their priority ' + dim +
        ' and ' + a.softPoints + ' points on their ' + other + '.';
      if (fe && typeof fe.ideal === 'number' && fe.ideal > 0) {
        text += ' Their own ideal total was ' + fe.ideal + ' points, so this run they reached ' +
          fmtSatisfaction(fe) + ' of it.';
      }
      out.push({
        h: a.name + ' \u2014 ' + a.priorityPoints + ' priority points',
        text: [text]
      });
    });

    return out;
  }

  function renderExplanation(result) {
    var box = document.getElementById('explanation-body');
    box.innerHTML = '';
    buildExplanation(result, lastRunPeople).forEach(function (item) {
      var wrap = el('div', 'explain-item');
      wrap.appendChild(el('h4', null, item.h));
      item.text.forEach(function (t) { wrap.appendChild(el('p', null, t)); });
      box.appendChild(wrap);
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  renderConstraints();
  renderPeople();
  wireRun();
  wireHistoryControls();
  refreshFairness();
})();

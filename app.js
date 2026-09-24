/* app.js
 *
 * Interface for the Shift Coverage Solver: explanation, fixed constraints and
 * editable per-person preference cards. This stage captures preferences only;
 * the solver is not run from this screen yet.
 *
 * State is a plain array of people in the same shape scheduler.js expects:
 *   { name, restOptions, shiftOptions, priority, noWorkWindow }
 */

(function () {
  'use strict';

  var S = window.Scheduler;
  var config = S.config;

  // ------------------------------------------------------------------
  // State (pre-loaded with the default dataset)
  // ------------------------------------------------------------------

  function clonePerson(p) {
    return {
      name: p.name,
      restOptions: p.restOptions.map(function (pair) { return pair.slice(); }),
      shiftOptions: p.shiftOptions.slice(),
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
  // Cross-run fairness history (persisted in this browser)
  // ------------------------------------------------------------------

  var HISTORY_KEY = 'shift-solver-history-v1';
  var storageWorking = true;
  var history = loadHistory();

  function emptyHistory() {
    return { version: S.HISTORY_VERSION, runs: [], streaks: {} };
  }

  // Read the saved history, tolerating missing or corrupt data. Never throws:
  // if storage is unavailable we just carry on with an empty history.
  function loadHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return emptyHistory();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' ||
          !Array.isArray(parsed.runs) ||
          !parsed.streaks || typeof parsed.streaks !== 'object') {
        return emptyHistory();
      }
      return {
        version: S.HISTORY_VERSION,
        runs: parsed.runs,
        streaks: parsed.streaks
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
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
      refreshOwed();
    });
    head.appendChild(nameInput);

    var pBlock = el('div', 'priority-block');
    pBlock.appendChild(el('span', 'priority-label', 'Priority:'));
    var group = el('div', 'toggle-group');
    var restBtn = el('button', null, 'Rest days');
    restBtn.type = 'button';
    restBtn.title = 'This person\u2019s rest-day list is a requirement.';
    restBtn.addEventListener('click', function () { state[index].priority = 'rest'; updatePerson(view); });
    var hoursBtn = el('button', null, 'Work hours');
    hoursBtn.type = 'button';
    hoursBtn.title = 'This person\u2019s shift-slot list is a requirement.';
    hoursBtn.addEventListener('click', function () { state[index].priority = 'hours'; updatePerson(view); });
    group.appendChild(restBtn);
    group.appendChild(hoursBtn);
    pBlock.appendChild(group);
    head.appendChild(pBlock);
    card.appendChild(head);

    // --- rest-day pairs dimension ---
    var restDim = el('div', 'dimension');
    restDim.appendChild(el('h4', null, 'Acceptable rest-day pairs'));
    var restChips = el('div', 'chips');
    var restChipMap = {};
    S.ADJACENT_PAIRS.forEach(function (pair) {
      var key = pairKey(pair);
      var chip = el('button', 'chip', pairLabel(pair));
      chip.type = 'button';
      chip.addEventListener('click', function () { toggleRest(view, pair); });
      restChips.appendChild(chip);
      restChipMap[key] = chip;
    });
    restDim.appendChild(restChips);
    var restRankWrap = el('div', 'rank-wrap');
    restRankWrap.appendChild(el('span', 'rank-caption', 'Rank (drag):'));
    var restRank = el('ol', 'rank-list');
    restRankWrap.appendChild(restRank);
    restDim.appendChild(restRankWrap);
    card.appendChild(restDim);

    // --- shift slots dimension ---
    var hourDim = el('div', 'dimension');
    hourDim.appendChild(el('h4', null, 'Acceptable shift slots'));
    var hourChips = el('div', 'chips');
    var hourChipMap = {};
    for (var i = 0; i < config.numSlots; i++) {
      (function (idx) {
        var chip = el('button', 'chip', '');
        chip.type = 'button';
        chip.addEventListener('click', function () { toggleHour(view, idx); });
        hourChips.appendChild(chip);
        hourChipMap[idx] = chip;
      })(i);
    }
    hourDim.appendChild(hourChips);
    var hourRankWrap = el('div', 'rank-wrap');
    hourRankWrap.appendChild(el('span', 'rank-caption', 'Rank (drag):'));
    var hourRank = el('ol', 'rank-list');
    hourRankWrap.appendChild(hourRank);
    hourDim.appendChild(hourRankWrap);
    card.appendChild(hourDim);

    // --- advanced (collapsed) ---
    var adv = el('details', 'advanced');
    adv.appendChild(el('summary', null, 'Advanced (no-work window)'));
    var advBody = el('div', 'adv-body');

    // no-work window
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
    });

    adv.appendChild(advBody);
    card.appendChild(adv);

    view.card = card;
    view.nameInput = nameInput;
    view.restBtn = restBtn;
    view.hoursBtn = hoursBtn;
    view.restChips = restChipMap;
    view.hourChips = hourChipMap;
    view.restRank = restRank;
    view.hourRank = hourRank;
    view.winEnabled = winEnabled;
    view.winFields = winFields;
    view.startDaySel = startDaySel;
    view.startHourSel = startHourSel;
    view.endDaySel = endDaySel;
    view.endHourSel = endHourSel;
    view.restSortable = null;
    view.hourSortable = null;
    return view;
  }

  function toggleRest(view, pair) {
    var p = state[view.index];
    var key = pairKey(pair);
    var at = -1;
    for (var i = 0; i < p.restOptions.length; i++) if (pairKey(p.restOptions[i]) === key) at = i;
    if (at >= 0) p.restOptions.splice(at, 1);
    else p.restOptions.push(pair.slice());
    updatePerson(view);
  }

  function toggleHour(view, idx) {
    var p = state[view.index];
    var at = p.shiftOptions.indexOf(idx);
    if (at >= 0) p.shiftOptions.splice(at, 1);
    else p.shiftOptions.push(idx);
    updatePerson(view);
  }

  function commitRankOrder(view, dim) {
    var p = state[view.index];
    var ol = dim === 'rest' ? view.restRank : view.hourRank;
    var keys = Array.prototype.slice.call(ol.children).map(function (li) {
      return li.getAttribute('data-key');
    });
    if (dim === 'rest') {
      var byKey = {};
      S.ADJACENT_PAIRS.forEach(function (pr) { byKey[pairKey(pr)] = pr; });
      p.restOptions = keys.map(function (k) { return byKey[k].slice(); });
    } else {
      p.shiftOptions = keys.map(function (k) { return parseInt(k, 10); });
    }
    Array.prototype.slice.call(ol.children).forEach(function (li, i) {
      li.querySelector('.rank-num').textContent = String(i + 1);
    });
  }

  function refreshRank(view, dim) {
    var p = state[view.index];
    var ol = dim === 'rest' ? view.restRank : view.hourRank;
    var list = dim === 'rest' ? p.restOptions : p.shiftOptions;

    var key = dim === 'rest' ? 'restSortable' : 'hourSortable';
    if (view[key]) { view[key].destroy(); view[key] = null; }
    ol.innerHTML = '';
    list.forEach(function (v, i) {
      var li = el('li', 'rank-item');
      li.setAttribute('data-key', dim === 'rest' ? pairKey(v) : String(v));
      li.appendChild(el('span', 'rank-num', String(i + 1)));
      li.appendChild(el('span', null, dim === 'rest' ? pairLabel(v) : slotLabel(v)));
      ol.appendChild(li);
    });
    if (window.Sortable) {
      view[key] = window.Sortable.create(ol, {
        animation: 0,
        onEnd: function () { commitRankOrder(view, dim); }
      });
    }
  }

  function updatePerson(view) {
    var p = state[view.index];

    swapClass(view.restBtn, 'active', p.priority === 'rest');
    swapClass(view.hoursBtn, 'active', p.priority === 'hours');

    S.ADJACENT_PAIRS.forEach(function (pair) {
      var key = pairKey(pair);
      var has = p.restOptions.some(function (r) { return pairKey(r) === key; });
      swapClass(view.restChips[key], 'selected', has);
    });

    for (var i = 0; i < config.numSlots; i++) {
      var chip = view.hourChips[i];
      chip.textContent = slotLabel(i);
      swapClass(chip, 'selected', p.shiftOptions.indexOf(i) >= 0);
    }

    refreshRank(view, 'rest');
    refreshRank(view, 'hour');

    view.winEnabled.checked = !!p.noWorkWindow;
    view.winFields.style.display = p.noWorkWindow ? 'flex' : 'none';
    view.startDaySel.disabled = !p.noWorkWindow;
    view.startHourSel.disabled = !p.noWorkWindow;
    view.endDaySel.disabled = !p.noWorkWindow;
    view.endHourSel.disabled = !p.noWorkWindow;
    if (p.noWorkWindow) {
      view.startDaySel.value = String(p.noWorkWindow.startDay);
      view.startHourSel.value = String(p.noWorkWindow.startHour);
      view.endDaySel.value = String(p.noWorkWindow.endDay);
      view.endHourSel.value = String(p.noWorkWindow.endHour);
    }

    refreshOwed();
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
  // Fairness (rotation): guaranteed list, ledger, recent runs, history
  // ------------------------------------------------------------------

  // Plain-English guarantee sentences, built entirely from the data.
  function guaranteeSentences(people) {
    var owedInfo = S.computeOwed(history, people);
    var lines = [];
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      var o = owedInfo.owed[i];
      if (!o) continue;
      if (o.slot != null) {
        lines.push({
          text: p.name + ' is guaranteed their #1 shift slot (' + S.SLOT_LETTERS[o.slot] +
            ') this run \u2014 ' + missPhrase(o.slotStreak, 'slot'),
          kind: 'slot'
        });
      }
      if (o.pair != null) {
        lines.push({
          text: p.name + ' is guaranteed their #1 rest-day pair (' + pairLabel(o.pair) +
            ') this run \u2014 ' + missPhrase(o.pairStreak, 'rest'),
          kind: 'rest'
        });
      }
    }
    return lines;
  }

  function missPhrase(streak, dimension) {
    if (!streak || streak <= 1) return 'they missed it last time.';
    return 'they have missed it ' + streak + ' ' + dimension + ' runs in a row.';
  }

  function refreshOwed() {
    var box = document.getElementById('owed-box');
    if (!box) return;
    box.innerHTML = '';
    var lines = guaranteeSentences(state);

    if (!lines.length) {
      box.appendChild(el('p', 'note',
        'No guarantees this round: no previous run, or everyone got their first choices last time.'));
      return;
    }

    var list = el('ul', 'owed-list');
    lines.forEach(function (line) {
      var li = el('li', 'owed-item');
      li.appendChild(el('span', 'owed-mark', 'Guaranteed:'));
      li.appendChild(el('span', null, line.text));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function refreshLedger() {
    var tbody = document.querySelector('#ledger-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var streaks = (history && history.streaks) || {};

    state.forEach(function (p) {
      var st = streaks[p.name] || { slot: 0, rest: 0 };
      var exempt = !!p.noWorkWindow;
      var slotMisses = exempt ? 0 : (st.slot || 0);
      var restMisses = st.rest || 0;

      var tr = document.createElement('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, String(slotMisses)));
      tr.appendChild(el('td', null, String(restMisses)));
      tr.appendChild(el('td', 'note', exempt ? 'Exempt (has a no-work window)' : 'Tracked'));
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
      var slotTracked = entries.filter(function (e) { return e.slotTracked !== false; });
      var restTracked = entries.filter(function (e) { return e.restTracked !== false; });
      var slotHits = slotTracked.filter(function (e) { return e.slotHit; }).length;
      var restHits = restTracked.filter(function (e) { return e.restHit; }).length;

      var when = 'unknown time';
      try {
        var d = new Date(run.at);
        if (!isNaN(d.getTime())) when = d.toLocaleString();
      } catch (err) { /* keep the placeholder */ }

      var row = el('div', 'recent-run');
      row.appendChild(el('span', 'recent-when', when + ': '));
      row.appendChild(el('span', null,
        'first slot given to ' + slotHits + ' of ' + slotTracked.length +
        ' tracked, first rest pair given to ' + restHits + ' of ' + restTracked.length + ' tracked.'));
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  function refreshFairness() {
    refreshOwed();
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
        logLine('Rotation history cleared.');
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

      var owedInfo = S.computeOwed(history, frozen);
      logLine('Rotation: ' + owedInfo.list.length + ' guarantee' +
        (owedInfo.list.length === 1 ? '' : 's') + ' owed going into this run.');

      var seedInput = document.getElementById('tie-seed');
      var seed = parseInt(seedInput.value, 10);
      if (isNaN(seed)) { seed = S.DEFAULT_TIE_SEED; seedInput.value = String(seed); }
      logLine('Tie-break rule: seeded random draw (mulberry32), seed ' + seed + '.');

      S.solveAsync(frozen, config, {
        tieSeed: seed,
        owed: owedInfo.owed,
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
          logLine('Best penalty score ' + result.score + '. Coverage ' +
            result.minCoverage + ' to ' + result.maxCoverage + '.');
          logLine('Checked ' + result.stats.innerPerms + ' slot arrangements and ' +
            result.stats.innerChecked + ' coverage checks across ' + result.stats.outers +
            ' outer arrangements.');
          if (result.tie) {
            logLine('Top-score schedules: ' + result.tie.count +
              (result.tie.count > 1
                ? ' (tied). Tie-break chose entry #' + (result.tie.chosenIndex + 1) +
                  ' using seed ' + result.tie.seed + '.'
                : ' (no tie).'));
          }
          if (result.guarantees) {
            logLine('Guarantees: ' + result.guarantees.owed.length + ' owed; ' +
              result.guarantees.satisfied.length + ' satisfied, ' +
              result.guarantees.dropped.length + ' dropped.');
          }
          var runRecord = S.buildRunRecord(result.assignment, frozen);
          history = S.appendHistory(history, runRecord);
          saveHistory();
          refreshFairness();
          logLine('Rotation history saved for the next run (' + history.runs.length +
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

  function coverageColor(count, min) {
    if (count < min) return { bg: '#c0392b', fg: '#ffffff' };
    if (count === min) return { bg: '#e8f2ea', fg: '#1a1a1a' };
    var extra = count - min;
    var shades = ['#c3e3cd', '#93cfac', '#63b98a', '#3a9d68', '#1f7d4c'];
    var bg = shades[Math.min(extra - 1, shades.length - 1)];
    return { bg: bg, fg: extra >= 3 ? '#ffffff' : '#1a1a1a' };
  }

  function renderResults(result) {
    document.getElementById('results-empty').hidden = true;
    document.getElementById('results').hidden = false;
    renderTie(result);
    renderSummary(result);
    renderSchedule(result);
    renderHeatmap(result);
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
        g.join(' and ') + ' listed identical preferences, so either could have been the one to miss out.'));
    });

    box.appendChild(el('p', null,
      'Tie-break rule: ' + t.ruleLabel + ', seed ' + t.seed + '. The tied schedules are sorted by who holds ' +
      'which slot (by name), and the draw picked entry #' + (t.chosenIndex + 1) + ' of ' + t.count + '. ' +
      'The same seed and the same preferences always give the same result; change the seed and press Run again to redraw.'));

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
      var met = result.assignment.filter(function (a) { return a.priorityMet; }).length;
      tiles.push({ label: 'Minimum coverage', value: String(result.minCoverage) });
      tiles.push({ label: 'Maximum coverage', value: String(result.maxCoverage) });
      tiles.push({ label: 'Hours at minimum', value: String(atMin) });
      tiles.push({ label: 'Hours above minimum', value: String(above) });
      tiles.push({ label: 'Total scheduled hours', value: String(result.totalPersonHours) });
      tiles.push({ label: 'Priority requirements met', value: met + ' / ' + result.assignment.length });
      tiles.push({ label: 'Outer arrangements', value: String(result.stats.outers) });
      tiles.push({ label: 'Coverage checks', value: String(result.stats.innerChecked) });
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
      if (!a.priorityMet) tr.className = 'row-missed';

      tr.appendChild(el('td', null, a.name));
      tr.appendChild(el('td', null, a.slotLetter + ' ' + fmtHour(a.slotStart)));
      var end = (a.slotStart + config.shiftLen) % 24;
      tr.appendChild(el('td', null, fmtHour(a.slotStart) + '\u2013' + fmtHour(end)));
      tr.appendChild(el('td', null, a.restDayNames.join('\u2013')));
      tr.appendChild(el('td', null, a.priority === 'rest' ? 'Rest days' : 'Work hours'));
      tr.appendChild(el('td', null, a.priorityMet ? '#' + (a.priorityRank + 1) : 'not on list'));
      tr.appendChild(el('td', null, '#' + (a.softRank + 1)));

      var status = el('td');
      status.appendChild(el('span', a.priorityMet ? 'met' : 'missed', a.priorityMet ? 'met' : 'missed'));
      tr.appendChild(status);

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

  function buildExplanation(result, people) {
    people = people || state;
    var out = [];

    if (!result.ok) {
      var msg;
      if (result.error === 'infeasible') {
        msg = 'The exhaustive search proved that no assignment can keep at least ' +
          config.minCoverage + ' people on duty in all 168 hours while respecting the ' +
          'no-work windows and any rotation guarantees. No valid schedule exists for these preferences.';
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
        tieText += ' ' + g.join(' and ') + ' listed identical preferences, so either could have been the one to miss out.';
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
          ' and ' + S.DAYS[w.endDay] + ' ' + fmtHour(w.endHour) + '. ' +
          p.name + ' is on slot ' + a.slotLetter + ' (starting ' + fmtHour(a.slotStart) +
          ') because that is the workable shift the rest of the team least wants. ' +
          'The rest days (' + a.restDayNames.join('\u2013') +
          ') still keep every working hour outside that window.']
      });
    });

    var met = result.assignment.filter(function (a) { return a.priorityMet; }).length;
    var unmet = result.assignment.filter(function (a) { return !a.priorityMet; });
    out.push({
      h: 'Priority requirements',
      text: [met + ' of ' + result.assignment.length +
        ' people received an option from their priority list. ' +
        (unmet.length ? 'Not satisfied: ' + unmet.map(function (a) { return a.name; }).join(', ') + '.'
                      : 'All were satisfied.')]
    });

    if (result.guarantees && result.guarantees.owed.length > 0) {
      var g = result.guarantees;
      var gText = [];
      g.satisfied.forEach(function (item) {
        var what = item.dimension === 'slot'
          ? 'slot ' + S.SLOT_LETTERS[item.value]
          : 'rest days ' + pairLabel(item.value);
        gText.push(item.name + ' got ' + what + ' because they missed their #1 ' +
          (item.dimension === 'slot' ? 'slot' : 'rest-day pair') +
          ' last run and it was guaranteed this run.');
      });
      g.dropped.forEach(function (item) {
        var what = item.dimension === 'slot'
          ? 'slot ' + S.SLOT_LETTERS[item.value]
          : 'rest days ' + pairLabel(item.value);
        gText.push('The guarantee for ' + item.name + ' (' + what +
          ') could not be satisfied: ' + item.reason + '.');
      });
      out.push({
        h: 'Guarantees carried over from the last run',
        text: gText.length ? gText : ['No guarantees were applied this run.']
      });
    }

    result.assignment.forEach(function (a) {
      var dim = a.priority === 'rest' ? 'rest-day pair' : 'shift slot';
      if (a.priorityMet && a.priorityRank > 0) {
        out.push({
          h: a.name + ' \u2014 priority choice #' + (a.priorityRank + 1),
          text: [a.name + ' received priority choice #' + (a.priorityRank + 1) + ' for their ' + dim +
            ', not their first pick, because a higher pick was already taken or would have broken the coverage minimum.']
        });
      } else if (!a.priorityMet) {
        out.push({
          h: a.name + ' \u2014 priority not met',
          text: [a.name + ' could not be given any listed ' + dim +
            '. The closest remaining option was assigned so the hard coverage minimum could still hold.']
        });
      }
    });

    result.assignment.forEach(function (a) {
      if (a.softRank > 0) {
        var dim = a.priority === 'rest' ? 'shift slot' : 'rest-day pair';
        out.push({
          h: a.name + ' \u2014 secondary preference',
          text: ['Because ' + a.name + ' marked ' + (a.priority === 'rest' ? 'rest days' : 'work hours') +
            ' as their priority, their ' + dim + ' is only a preference and was allowed to move to choice #' +
            (a.softRank + 1) + '.']
        });
      }
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

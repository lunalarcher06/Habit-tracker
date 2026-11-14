/* Habit Buddy: plain JavaScript, no framework, no build step.

   How this file is organised
     1. Settings and small helpers
     2. Talking to the two services (api, habitsApi, streaksApi)
     3. Small pieces of UI: toast, "waking up" banner, celebration, the cat
     4. Screens: login, today, new habit, habit detail, milestones
     5. Events and the hash router

   What the server answers (the brief does not spell out every field, so the
   "normalise" helpers below accept the usual spellings):
     /auth/login            -> { token, expires_in, user: { ..., outfit } }
     /habits, /groups       -> [ ... ]                 (or { habits: [...] })
     /history               -> [ { habit_id, date } ]  (or { history: [...] })
     /streaks               -> [ { habit_id, current_streak, longest_streak, completion_rate } ]
     /streaks/<id>          -> same fields + new_milestones: [ { days, item_unlocked } ]
     /milestones            -> [ { days, item_unlocked, earned_at, days_left } ]
     DELETE /habits/<id>/checkins?date=YYYY-MM-DD   (no date = today)
*/
(function () {
  'use strict';

  // ===================================================================
  // 1. Settings and small helpers
  // ===================================================================

  var CFG = window.CONFIG || {};                  // written by config.js
  var MILESTONE_DAYS = [3, 7, 14, 21, 30, 45, 60, 90, 100, 150, 200, 365];
  var returnGroup = null;                          // the group to show when Today opens again
  var STREAKS_DOWN = 'Streaks are unavailable right now, try again later';

  var main = document.getElementById('main');
  function $(selector, root) { return (root || document).querySelector(selector); }

  // Escape text before putting it into innerHTML
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtDate(s) { return parseISO(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function num(v) { return Number(v) || 0; }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function pick(obj, names, fallback) {           // first field that exists
    for (var i = 0; i < names.length; i++) { if (obj && obj[names[i]] != null) return obj[names[i]]; }
    return fallback;
  }
  function asList(data, key) {                    // [..] or { key: [..] }
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data[key]) ? data[key] : [];
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // Token and username live in sessionStorage; if storage is blocked we keep them in memory
  var memory = {};
  function saveItem(key, value) {
    memory[key] = value;
    try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function loadItem(key) {
    try { return sessionStorage.getItem(key) || memory[key] || null; } catch (e) { return memory[key] || null; }
  }
  function getToken() { return loadItem('hb_token'); }
  function getUser() { return loadItem('hb_user') || 'friend'; }

  // ===================================================================
  // 2. Talking to the two services
  // ===================================================================

  var pending = 0;      // requests in flight
  var wakeTimer = null; // fires after 3 s of waiting

  // Show the friendly "waking up the server" banner if we wait longer than 3 seconds
  function trackBusy(change) {
    pending += change;
    if (pending > 0 && !wakeTimer) {
      wakeTimer = setTimeout(function () { $('#wake').hidden = false; }, 3000);
    }
    if (pending <= 0) {
      pending = 0;
      clearTimeout(wakeTimer);
      wakeTimer = null;
      $('#wake').hidden = true;
    }
  }

  function makeError(status, body, fallback) {
    var e = (body && body.error) || {};
    var err = new Error(e.message || fallback);
    err.status = status;
    err.code = e.code || 'error';
    err.field = e.field || null;
    return err;
  }

  async function api(baseUrl, method, path, body) {
    var headers = {};
    var isAuth = path.indexOf('/auth/') === 0;
    if (!isAuth && getToken()) headers.Authorization = 'Bearer ' + getToken();
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    trackBusy(1);
    try {
      var res;
      try {
        res = await fetch(baseUrl + path, {
          method: method,
          headers: headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch (networkProblem) {
        throw makeError(0, null, "Can't reach the server. Check your connection and try again.");
      }
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (notJson) { /* leave null */ }

      if (!res.ok) {
        var err = makeError(res.status, data, 'Something went wrong (error ' + res.status + ').');
        if (res.status === 401 && !isAuth) sessionExpired();
        throw err;
      }
      return data;
    } finally {
      trackBusy(-1);
    }
  }
  function habitsApi(method, path, body) { return api(CFG.HABITS_URL, method, path, body); }
  function streaksApi(method, path, body) { return api(CFG.STREAKS_URL, method, path, body); }

  // 401 on any request: forget the token and go back to the login screen
  var flash = '';
  function sessionExpired() {
    saveItem('hb_token', null);
    flash = 'Your session has expired. Please log in again.';
    if (location.hash === '#/login') route(); else location.hash = '#/login';
  }

  // ----- turn server answers into simple objects -----

  function toHabit(h) {
    return { id: h.id, name: h.name, group_id: h.group_id == null ? null : h.group_id, archived: !!h.archived };
  }
  function toCheckins(data) {                     // -> [ { habit_id, date } ]
    var rows = asList(data, 'habits');
    if (!rows.length) rows = asList(data, 'history');
    var out = [];
    rows.forEach(function (r) {
      var inner = r.dates || r.checkins;          // grouped by habit
      if (Array.isArray(inner)) {
        inner.forEach(function (d) { out.push({ habit_id: r.habit_id || r.id, date: dateOf(d) }); });
      } else {
        out.push({ habit_id: r.habit_id, date: dateOf(r) });
      }
    });
    return out.filter(function (c) { return c.date; });
  }
  function dateOf(x) {
    var d = typeof x === 'string' ? x : pick(x, ['date', 'day', 'checked_on', 'checkin_date'], '');
    return String(d).slice(0, 10);
  }
  function toStreak(s) {
    var rate = pick(s, ['completion_rate_30d', 'completion_rate', 'rate'], null);
    if (rate != null && num(rate) <= 1) rate = num(rate) * 100;   // 0.8 -> 80
    return {
      current: num(pick(s, ['current_streak', 'current'], 0)),
      longest: num(pick(s, ['longest_streak', 'longest', 'best_streak'], 0)),
      rate: rate == null ? null : Math.round(num(rate)),
      fresh: asList(s, 'new_milestones').map(function (m) { return typeof m === 'number' ? { days: m } : m; })
    };
  }
  function toStreakMap(data) {                    // -> { habitId: {current, longest, rate} }
    var map = {};
    asList(data, 'streaks').forEach(function (s) { map[pick(s, ['habit_id', 'id'], '')] = toStreak(s); });
    return map;
  }
  function isEarned(m) {
    return m.earned === true || m.unlocked === true ||
      !!pick(m, ['achieved_on', 'earned_at', 'earned_on', 'date_earned', 'achieved_at', 'unlocked_at'], null);
  }
  // One card per milestone size (7, 14, 30 ...). Earned if the server says so for any habit.
  function toMilestones(data, bestNow) {
    var rows = asList(data, 'milestones');
    return MILESTONE_DAYS.map(function (days) {
      var same = rows.filter(function (r) { return num(pick(r, ['days', 'streak_length', 'threshold', 'milestone'], 0)) === days; });
      var r = same.filter(isEarned)[0] || same[0] || {};
      var earned = isEarned(r);
      var date = pick(r, ['achieved_on', 'earned_at', 'earned_on', 'date_earned', 'achieved_at', 'unlocked_at'], '');
      return {
        days: days,
        earned: earned,
        date: date ? String(date).slice(0, 10) : '',
        item: pick(r, ['item_unlocked', 'item', 'item_name'], DEFAULT_ITEM[days]),
        left: earned ? 0 : num(pick(r, ['days_left', 'days_remaining', 'remaining'], Math.max(0, days - bestNow)))
      };
    });
  }
  function itemName(text) { var t = String(text).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
  // ----- the outfits your cat unlocks: one per milestone, pictures in cat/outfits/ -----
  var OUTFITS = {
    3: { id: 'headphones', name: 'Headphones' },   7: { id: 'cool', name: 'Sunglasses & leather jacket' },
    14: { id: 'chef', name: 'Chef' },              21: { id: 'bookworm', name: 'Bookworm' },
    30: { id: 'wizard', name: 'Wizard hat' },      45: { id: 'aviator', name: 'Aviator' },
    60: { id: 'sheriff', name: 'Wild West sheriff' }, 90: { id: 'astronaut', name: 'Asteroid explorer' },
    100: { id: 'lucky', name: 'Lucky maneki-neko' }, 150: { id: 'ninja', name: 'Ninja' },
    200: { id: 'cyberpunk', name: 'Cyberpunk' },   365: { id: 'royal', name: 'Crown & cape' }
  };
  var DEFAULT_ITEM = {};
  Object.keys(OUTFITS).forEach(function (d) { DEFAULT_ITEM[d] = OUTFITS[d].name; });
  function outfitName(days, fallback) { return OUTFITS[days] ? OUTFITS[days].name : itemName(fallback); }
  // The outfit pictures on cards and in the unlock dialog: cat/stickers/<id>/<pose>.webp,
  // pose = walk | calm | happy | mean | sleep (one drawing set, the same style for all 12 outfits).
  function itemIcon(days, size, pose) {
    if (!OUTFITS[days]) return '';
    var id = OUTFITS[days].id;
    if (!pose) pose = id === 'cool' ? 'happy' : 'calm';             // the cool cat only has its sunglasses on when it smiles
    var src = 'cat/stickers/' + id + '/' + pose + '.webp';
    return '<img class="pix" src="' + src + '" alt="" style="height:' + size + 'px;width:auto">';
  }

  // The outfit the cat is wearing is saved on the user (Habits: PATCH /me). The server keeps the outfit's
  // name ("chef"); this page works with the milestone size (14), so these two helpers translate.
  function daysForOutfit(id) {
    return Object.keys(OUTFITS).filter(function (d) { return OUTFITS[d].id === id; })[0] || null;
  }
  function getWorn() { return daysForOutfit(loadItem('hb_outfit')); }
  function setWorn(days) {
    var id = days && OUTFITS[days] ? OUTFITS[days].id : 'none';
    saveItem('hb_outfit', id);
    habitsApi('PATCH', '/me', { outfit: id }).catch(function (err) {
      if (err.status !== 401) toast("Couldn't save the outfit: " + err.message, { error: true });
    });
  }
  function dressCat() {
    var cat = $('#cat'), w = getWorn();
    if (!cat) return;
    if (w && OUTFITS[w]) cat.setAttribute('outfit', OUTFITS[w].id); else cat.removeAttribute('outfit');
  }


  // ===================================================================
  // 3. Small pieces of UI
  // ===================================================================

  // ----- toast -----
  var toastTimer = null;
  var toastAction = null;
  function toast(message, options) {
    options = options || {};
    var el = $('#toast');
    toastAction = options.action || null;
    el.className = 'toast' + (options.error ? ' error' : '');
    el.innerHTML = '<span>' + esc(message) + '</span>' +
      (toastAction ? '<button type="button" data-action="toast-action">' + esc(toastAction.label) + '</button>' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, options.error ? 6000 : 4500);
  }

  // ----- the cat -----
  var cueCount = 0;
  function cue(name) {                            // plays celebrate / jump / alert / stretch / wake once
    var cat = $('#cat');
    if (!cat) return;
    cueCount += 1;
    cat.setAttribute('cue', name + ':' + cueCount);
  }
  function setCatMode(mode) {
    var cat = $('#cat');
    if (cat && cat.getAttribute('mode') !== mode) cat.setAttribute('mode', mode);
  }

  // ----- celebration when a check-in unlocks a milestone -----
  function celebrate(milestones) {
    if (!milestones || !milestones.length) return;
    var first = milestones[milestones.length - 1];   // several can arrive at once: show the biggest
    var days = num(pick(first, ['days', 'streak_length', 'threshold', 'milestone'], 0));
    var item = outfitName(days, pick(first, ['item_unlocked', 'item', 'item_name'], 'a new outfit'));
    var dlg = $('#celebrate');
    if (typeof dlg.showModal !== 'function') { toast(days + '-day streak! Your cat unlocked ' + item + '.'); return; }
    if (!dlg.open) dlg.showModal();               // open first so the cat can measure its stage
    dlg.innerHTML =
      '<div class="body">' +
        '<div class="gift">' + itemIcon(days, 220, 'happy') + '</div>' +
        '<p class="eyebrow">New milestone</p>' +
        '<h2 id="cel-title">' + days + ' days in a row!</h2>' +
        '<p>Your cat unlocked the <strong>' + esc(item) + '</strong> outfit.</p>' +
        (milestones.length > 1 ? '<p class="muted">Plus ' + (milestones.length - 1) + ' more.</p>' : '') +
        '<div class="row" style="justify-content:center"><button class="btn" type="button" data-action="wear-now" data-days="' + days + '" autofocus>Wear it now</button>' +
        '<button class="btn btn-ghost" type="button" data-action="celebrate-close">Later</button></div>' +
      '</div>';
    toast(days + '-day streak. New outfit: ' + item);
  }

  // ----- forms: errors next to the field, or under the form -----
  function clearErrors(form) {
    form.querySelectorAll('.field-err').forEach(function (p) { p.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(function (i) { i.removeAttribute('aria-invalid'); });
    var general = form.querySelector('.form-err');
    if (general) general.textContent = '';
  }
  function fieldError(form, name, message) {
    var input = form.elements[name];
    var p = form.querySelector('#err-' + name);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (p) p.textContent = message;
  }
  // 422 errors go next to the field they are about; everything else goes under the form
  function showFormError(form, err, fieldNames) {
    var text = String(err.message).toLowerCase();
    var name = err.field && fieldNames.indexOf(err.field) >= 0 ? err.field :
      fieldNames.filter(function (n) { return text.indexOf(n.replace('_', ' ')) >= 0; })[0];
    if (err.status === 422 && name) { fieldError(form, name, err.message); form.elements[name].focus(); return; }
    form.querySelector('.form-err').textContent = err.message;
  }
  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (label) button.textContent = label;
  }

  // ----- bits of markup used on several screens -----
  var ICON_FLAME = '<svg class="flame" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5-1.5 5-1.5 7.5 0 1.4 1 2.5 2.3 2.5 1.6 0 2.4-1.3 2.1-3 2 1.5 3.6 4 3.6 6.6C18.5 19.6 15.6 22 12 22s-6.5-2.4-6.5-6.4C5.5 10.9 10 8 12 2z"/></svg>';
  var ICON_CHECK = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3zM12 10v5M12 18h.01"/></svg>';
  var ICON_BOX = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h18v4H3zM5 11v9h14v-9M10 15h4"/></svg>';
  var ICON_BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

  function noticeStreaksDown() {
    return '<div class="notice" role="status">' + ICON_WARN + '<span>' + STREAKS_DOWN + '</span></div>';
  }
  function loadError(err) {
    return '<div class="page"><div class="card stack"><h2>Something went wrong</h2><p>' + esc(err.message) +
      '</p><button class="btn" type="button" data-action="reload">Try again</button></div></div>';
  }

  // ===================================================================
  // 4. Screens
  // ===================================================================

  var nav = 0;                                    // bumped on every route change
  function stale(token) { return token !== nav; } // true if the user already moved on

  // Everything the Today screen knows. Re-created each time you open the screen.
  var T = null;

  function isDone(habitId, date) { return !!(T && T.checks[habitId + '|' + date]); }
  function activeHabits() { return T.habits.filter(function (h) { return !h.archived; }); }
  function groupName(id) {
    var g = T.groups.filter(function (x) { return String(x.id) === String(id); })[0];
    return g ? g.name : '';
  }

  // ------------------------------------------------------------------
  // Screen 1: sign up / log in
  // ------------------------------------------------------------------

  function viewLogin() {
    main.innerHTML =
      '<section class="auth">' +
        '<div class="auth-intro">' +
          '<p class="eyebrow">Habit Buddy</p>' +
          '<h1>Small habits. <span>One very proud cat.</span></h1>' +
          '<ul class="perks">' +
            '<li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Check off your day</li>' +
            '<li>' + ICON_FLAME + 'Grow your streaks</li>' +
            '<li><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>Unlock gifts for your cat</li>' +
          '</ul>' +
        '</div>' +
        '<div class="auth-card card">' +
          '<h2 id="auth-title">Welcome back</h2>' +
          '<div class="seg" role="group" aria-label="Log in or sign up">' +
            '<button type="button" data-action="auth-mode" data-mode="login" aria-pressed="true">Log in</button>' +
            '<button type="button" data-action="auth-mode" data-mode="signup" aria-pressed="false">Sign up</button>' +
          '</div>' +
          '<form data-form="auth" novalidate class="stack">' +
            '<div class="field names" id="name-fields" hidden>' +
              '<label for="first_name">First name</label>' +
              '<input id="first_name" name="first_name" type="text" autocomplete="given-name" aria-describedby="err-first_name">' +
              '<p class="field-err" id="err-first_name"></p>' +
              '<label for="last_name">Last name</label>' +
              '<input id="last_name" name="last_name" type="text" autocomplete="family-name" aria-describedby="err-last_name">' +
              '<p class="field-err" id="err-last_name"></p></div>' +
            '<div class="field"><label for="username">Username</label>' +
              '<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="err-username">' +
              '<p class="field-err" id="err-username"></p><p class="hint" id="hint-username" hidden>At least 3 characters. Not case-sensitive.</p></div>' +
            '<div class="field"><label for="password">Password</label>' +
              '<input id="password" name="password" type="password" autocomplete="current-password" aria-describedby="err-password">' +
              '<p class="field-err" id="err-password"></p><p class="hint" id="hint-password" hidden>At least 8 characters.</p></div>' +
            '<p class="form-err" role="alert"></p>' +
            '<button class="btn" type="submit" id="auth-submit">Log in</button>' +
          '</form>' +
        '</div>' +
        '<div class="auth-stage" aria-hidden="false">' +
          '<span class="moon" aria-hidden="true"></span>' +
          '<buddy-cat id="cat" mode="auto" height="260" start="0.5"></buddy-cat>' +
        '</div>' +
      '</section>';
    if (flash) { main.querySelector('.form-err').textContent = flash; flash = ''; }
  }

  function setAuthMode(mode) {
    var signup = mode === 'signup';
    document.querySelectorAll('[data-action="auth-mode"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    $('#auth-title').textContent = signup ? 'Meet your buddy' : 'Welcome back';
    $('#auth-submit').textContent = signup ? 'Create account' : 'Log in';
    $('#password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('#hint-username').hidden = !signup;
    $('#name-fields').hidden = !signup;
    $('#hint-password').hidden = !signup;
    clearErrors($('[data-form="auth"]'));
  }

  async function submitAuth(form) {
    clearErrors(form);
    var signup = $('[data-action="auth-mode"][data-mode="signup"]').getAttribute('aria-pressed') === 'true';
    var username = form.elements.username.value.trim();
    var password = form.elements.password.value;

    // Only sign-up checks the lengths; for log in the server decides
    if (signup) {
      var bad = false;
      if (!form.elements.first_name.value.trim()) { fieldError(form, 'first_name', 'First name is required.'); bad = true; }
      if (!form.elements.last_name.value.trim()) { fieldError(form, 'last_name', 'Last name is required.'); bad = true; }
      if (username.length < 3) { fieldError(form, 'username', 'Username needs at least 3 characters.'); bad = true; }
      if (password.length < 8) { fieldError(form, 'password', 'Password needs at least 8 characters.'); bad = true; }
      if (bad) return;
    }

    var button = $('#auth-submit');
    var label = button.textContent;
    setBusy(button, true, signup ? 'Creating…' : 'Logging in…');
    try {
      if (signup) await habitsApi('POST', '/auth/signup', { first_name: form.elements.first_name.value.trim(), last_name: form.elements.last_name.value.trim(), username: username, password: password });
      var res = await habitsApi('POST', '/auth/login', { username: username, password: password });
      var token = pick(res, ['token', 'access_token', 'jwt'], null);
      if (!token) throw makeError(0, null, 'The server did not send a login token.');
      saveItem('hb_token', token);
      saveItem('hb_user', username);
      saveItem('hb_outfit', (res.user && res.user.outfit) || 'none');
      setCatMode('wave');                         // the cat waves, then we go in
      await wait(1600);
      location.hash = '#/today';
    } catch (err) {
      showFormError(form, err, ['first_name', 'last_name', 'username', 'password']);
      setBusy(button, false, label);
    }
  }

  // ------------------------------------------------------------------
  // Screen 2: Today
  // ------------------------------------------------------------------

  function weekDays() {                           // Monday .. Sunday of this week
    var t = new Date();
    var monday = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7));
    var out = [];
    for (var i = 0; i < 7; i++) out.push(iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
    return out;
  }

  async function viewToday() {
    var my = nav;
    var days = weekDays();
    var startGroup = returnGroup; returnGroup = null;
    T = {
      loading: true, habits: [], groups: [], checks: {}, streaks: null, milestones: null, streaksDown: false,
      today: iso(new Date()), week: days, filter: 'all', group: startGroup, addingGroup: false, busy: {}
    };

    main.innerHTML =
      '<div class="page">' +
        '<section class="hero card" aria-labelledby="hero-title">' +
          '<div class="hero-top">' +
            '<div class="hero-text"><p class="eyebrow" id="hero-date"></p><h1 id="hero-title"></h1><p class="hero-sub" id="hero-sub"></p></div>' +
            '<div class="hero-progress" id="hero-progress"></div>' +
          '</div>' +
          '<div class="auth-stage hero-stage"><span class="moon" aria-hidden="true"></span>' +
            '<buddy-cat id="cat" mode="auto" height="260" start="0.7"></buddy-cat></div>' +
        '</section>' +
        '<div class="cols">' +
          '<section class="main-col stack" aria-labelledby="habits-title">' +
            '<div class="list-head"><h2 id="habits-title">Today\'s habits</h2><div id="filters"></div></div>' +
            '<div id="notice"></div>' +
            '<div class="group-bar" id="groups"></div>' +
            '<div id="list"></div>' +
          '</section>' +
          '<aside class="stack" aria-label="Progress">' +
            '<section class="card" aria-labelledby="week-title" id="week"></section>' +
            '<section class="card" aria-labelledby="miles-title" id="miles"></section>' +
          '</aside>' +
        '</div>' +
      '</div>';
    paintToday();

    try {
      var results = await Promise.all([
        habitsApi('GET', '/habits'),
        habitsApi('GET', '/groups'),
        habitsApi('GET', '/history?from=' + days[0] + '&to=' + days[6])
      ]);
      if (stale(my)) return;
      T.habits = asList(results[0], 'habits').map(toHabit);
      T.groups = asList(results[1], 'groups');
      toCheckins(results[2]).forEach(function (c) { T.checks[c.habit_id + '|' + c.date] = true; });
    } catch (err) {
      if (stale(my) || err.status === 401) return;
      main.innerHTML = loadError(err);
      return;
    }
    T.loading = false;
    paintToday();

    await loadStreaks();                          // the streaks service may be slow or down
    if (stale(my)) return;
    paintToday();
  }

  // Ask the streaks service for streaks and milestones. If it is down, say so and carry on.
  async function loadStreaks() {
    try {
      var results = await Promise.all([streaksApi('GET', '/streaks'), streaksApi('GET', '/milestones')]);
      T.streaks = toStreakMap(results[0]);
      T.milestones = results[1];
      T.streaksDown = false;
    } catch (err) {
      if (err.status === 401) return;
      T.streaks = null;
      T.milestones = null;
      T.streaksDown = true;
    }
  }

  function paintToday() {
    paintHero();
    paintNotice();
    paintFilters();
    paintGroups();
    paintList();
    paintWeek();
    paintMilestonePanel();
  }

  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 19 ? 'Good afternoon' : 'Good evening';
  }

  function paintHero() {
    var active = T.loading ? [] : activeHabits();
    var done = active.filter(function (h) { return isDone(h.id, T.today); }).length;
    var left = active.length - done;

    $('#hero-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    $('#hero-title').textContent = T.loading ? 'Waking up the cat…' : greeting() + ', ' + getUser();
    $('#hero-sub').textContent =
      T.loading ? 'One moment, your buddy is stretching.' :
      !active.length ? 'No habits yet. Add your first one and your buddy will wake up.' :
      left === 0 ? 'All done for today. Your buddy is very proud of you.' :
      left === 1 ? 'Just one to go.' : left + ' habits to go today.';

    var segments = active.map(function (h) {
      return '<span class="' + (isDone(h.id, T.today) ? 'on' : '') + '"></span>';
    }).join('');
    $('#hero-progress').innerHTML = T.loading ? '<div class="skeleton line"></div>' :
      '<div class="hero-count"><span class="hero-pct" aria-hidden="true">' + (active.length ? Math.round(100 * done / active.length) : 0) + '%</span>' +
      '<span>' + done + ' of ' + active.length + ' done today</span></div>' +
      '<div class="segs" role="img" aria-label="' + done + ' of ' + active.length + ' habits done today">' + segments + '</div>';

    // The cat: asleep with no habits (or while loading). With a habit still missing today it scowls (the mean face
    // and a "!"); once everything is logged it is calm again.
    var missing = active.some(function (h) { return !isDone(h.id, T.today); });
    setCatMode(T.loading ? 'auto' : !active.length ? 'sleep' : missing ? 'nag' : 'auto');
  }

  function paintNotice() {
    $('#notice').innerHTML = T.streaksDown ? noticeStreaksDown() : '';
  }

  function paintFilters() {
    var inGroup = habitsInGroup();
    var done = inGroup.filter(function (h) { return isDone(h.id, T.today); }).length;
    var counts = { all: inGroup.length, todo: inGroup.length - done, done: done };
    var labels = { all: 'All', todo: 'To do', done: 'Done' };
    $('#filters').innerHTML = '<div class="tabs" role="group" aria-label="Show habits">' +
      ['all', 'todo', 'done'].map(function (key) {
        return '<button class="tab" type="button" data-action="filter" data-filter="' + key + '" aria-pressed="' + (T.filter === key) + '">' +
          labels[key] + ' <span class="n">' + counts[key] + '</span></button>';
      }).join('') + '</div>';
  }

  function habitsInGroup() {
    return activeHabits().filter(function (h) { return T.group == null || String(h.group_id) === String(T.group); });
  }

  function paintGroups() {
    var all = activeHabits();
    var html = '<button class="chip" type="button" data-action="group" data-id="" aria-pressed="' + (T.group == null) + '">All groups <span class="n">' + all.length + '</span></button>';
    T.groups.forEach(function (g) {
      var n = all.filter(function (h) { return String(h.group_id) === String(g.id); }).length;
      html += '<button class="chip" type="button" data-action="group" data-id="' + esc(g.id) + '" aria-pressed="' + (String(T.group) === String(g.id)) + '">' +
        esc(g.name) + ' <span class="n">' + n + '</span></button>';
    });
    html += T.addingGroup
      ? '<form class="group-form" data-form="group"><label class="sr-only" for="new-group">New group name</label>' +
        '<input id="new-group" name="name" type="text" placeholder="Name it…" maxlength="40" autocomplete="off">' +
        '<button class="btn btn-small" type="submit">Add</button>' +
        '<button class="btn btn-small btn-ghost" type="button" data-action="group-cancel">Cancel</button></form>'
      : '<button class="chip dashed" type="button" data-action="group-new">+ New group</button>';
    if (T.group != null) {
      html += '<a class="chip dashed" href="#/new/' + encodeURIComponent(T.group) + '">+ Add a habit here</a>' +
        '<button class="btn-link" type="button" data-action="group-delete">Delete group</button>';
    }
    $('#groups').innerHTML = html;
    if (T.addingGroup) $('#new-group').focus();
  }

  function streakBadge(habitId) {
    var s = T.streaks && T.streaks[habitId];
    if (T.streaksDown) return '<div class="streak off" title="' + STREAKS_DOWN + '"><span aria-hidden="true">–</span><span class="sr-only">Streak unavailable</span></div>';
    if (!s) return '<div class="streak off" aria-hidden="true">' + ICON_FLAME + '<span>…</span></div>';
    var lit = s.current > 0;
    return '<div class="streak ' + (lit ? 'lit' : 'off') + '" title="' + plural(s.current, 'day') + ' streak">' +
      ICON_FLAME + '<span aria-hidden="true">' + s.current + '</span><span class="sr-only">' + plural(s.current, 'day') + ' streak</span></div>';
  }

  function habitCard(h) {
    var done = isDone(h.id, T.today);
    var group = groupName(h.group_id);
    return '<li class="habit' + (done ? ' done' : '') + '">' +
      '<button class="check" type="button" data-action="check" data-id="' + esc(h.id) + '" aria-pressed="' + done + '"' +
        (T.busy[h.id] ? ' disabled' : '') + ' aria-label="' + esc(h.name) + ': ' + (done ? 'done today, press to undo' : 'mark as done today') + '">' +
        (done ? ICON_CHECK : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>') +
      '</button>' +
      '<div class="habit-main"><a class="habit-name" href="#/habit/' + encodeURIComponent(h.id) + '">' + esc(h.name) + '</a>' +
        '<span class="habit-group">' + (group ? esc(group) : 'No group') + ' &middot; ' + (done ? 'Done today' : 'Not yet today') + '</span></div>' +
      streakBadge(h.id) +
      '<button class="icon-btn" type="button" data-action="archive" data-id="' + esc(h.id) + '" aria-label="Archive ' + esc(h.name) + '" title="Archive">' + ICON_BOX + '</button>' +
    '</li>';
  }

  function paintList() {
    var el = $('#list');
    if (T.loading) { el.innerHTML = '<div class="stack"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'; return; }

    if (!activeHabits().length) {
      el.innerHTML = '<div class="empty"><p>Nothing here yet. Your buddy is napping until you add a habit.</p>' +
        '<a class="btn" href="#/new">Add your first habit</a></div>';
      return;
    }
    var shown = habitsInGroup().filter(function (h) {
      var done = isDone(h.id, T.today);
      return T.filter === 'all' || (T.filter === 'done' ? done : !done);
    });
    if (!shown.length) {
      var text = T.filter === 'done' ? 'Nothing done yet. The first one is the easiest.' :
        T.filter === 'todo' ? 'Nothing left to do. Your buddy approves.' : 'No habits in this group yet.';
      var addHere = T.group != null && T.filter === 'all'
        ? '<a class="btn" href="#/new/' + encodeURIComponent(T.group) + '">Add a habit to ' + esc(groupName(T.group)) + '</a>' : '';
      el.innerHTML = '<div class="empty"><p>' + text + '</p>' + addHere + '</div>';
      return;
    }
    el.innerHTML = '<ul class="habits">' + shown.map(habitCard).join('') + '</ul>';
  }

  // "This week": one row of seven dots per habit
  function paintWeek() {
    var el = $('#week');
    var active = T.loading ? [] : activeHabits();
    var past = T.week.filter(function (d) { return d <= T.today; }).length;
    var possible = active.length * past, kept = 0;
    var letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    var rows = active.map(function (h) {
      var dots = '', checked = [];
      T.week.forEach(function (d, i) {
        var on = isDone(h.id, d);
        if (on) { kept += 1; checked.push(names[i]); }
        dots += '<span class="dot' + (on ? ' on' : '') + (d === T.today ? ' today' : '') + (d > T.today ? ' future' : '') + '" aria-hidden="true"></span>';
      });
      return '<li><span class="week-name">' + esc(h.name) + '</span>' + dots +
        '<span class="sr-only">' + (checked.length ? 'Done on ' + checked.join(', ') : 'Not done yet this week') + '</span></li>';
    }).join('');

    var head = letters.map(function (l, i) { return '<span class="' + (T.week[i] === T.today ? 'today' : '') + '" aria-hidden="true">' + l + '</span>'; }).join('');
    el.innerHTML =
      '<div class="panel-head"><h2 id="week-title">This week</h2>' +
        '<span class="muted">' + (possible ? Math.round(100 * kept / possible) + '% kept' : '') + '</span></div>' +
      (active.length
        ? '<div class="week-head" style="margin-top:14px"><span></span>' + head + '</div><ul class="week">' + rows + '</ul>'
        : '<p class="muted" style="margin-top:10px">' + (T.loading ? 'Loading…' : 'Your week will show up here.') + '</p>');
  }

  function paintMilestonePanel() {
    var el = $('#miles');
    var body;
    if (T.streaksDown) {
      body = noticeStreaksDown();
    } else if (!T.milestones) {
      body = '<div class="skeleton line"></div>';
    } else {
      var best = bestStreak(T.streaks);
      var list = toMilestones(T.milestones, best);
      var earned = list.filter(function (m) { return m.earned; }).reverse().slice(0, 3);
      var next = list.filter(function (m) { return !m.earned; })[0];
      body = '<ul class="badges">' +
        earned.map(function (m) {
          return '<li class="badge"><span class="badge-n">' + itemIcon(m.days, 36) + '</span>' +
            '<span class="badge-t">' + esc(outfitName(m.days, m.item)) + '<small>' + m.days + ' days' + (m.date ? ' &middot; earned ' + fmtDate(m.date) : '') + '</small></span></li>';
        }).join('') +
        (next ? '<li class="badge locked"><span class="badge-n">' + itemIcon(next.days, 36) + '</span>' +
          '<span class="badge-t">Next: ' + esc(outfitName(next.days, next.item)) + '<small>' + plural(next.left, 'day') + ' to go</small></span></li>' : '') +
        '</ul>' + (earned.length || next ? '' : '<p class="muted">Nothing yet.</p>') +
        '<a href="#/milestones" style="display:inline-block;margin-top:12px;font-size:14px">See all milestones</a>';
    }
    el.innerHTML = '<h2 id="miles-title">Milestones</h2><div style="margin-top:4px">' + body + '</div>';
  }

  function bestStreak(map) {
    var best = 0;
    Object.keys(map || {}).forEach(function (id) { best = Math.max(best, map[id].current); });
    return best;
  }

  // ----- Today: actions -----

  // Check in (or undo) a habit for today
  async function toggleToday(id) {
    var active = activeHabits();
    var wasAllDone = active.every(function (h) { return isDone(h.id, T.today); });
    var wasDone = isDone(id, T.today);
    T.busy[id] = true;
    paintList();
    try {
      if (wasDone) {
        await habitsApi('DELETE', '/habits/' + id + '/checkins');
        delete T.checks[id + '|' + T.today];
      } else {
        await habitsApi('POST', '/habits/' + id + '/checkins');
        T.checks[id + '|' + T.today] = true;
      }
    } catch (err) {
      T.busy[id] = false;
      paintList();
      if (err.status !== 401) toast(err.message, { error: true });
      return;
    }
    T.busy[id] = false;

    var allDone = active.every(function (h) { return isDone(h.id, T.today); });
    if (!wasDone) cue('celebrate');                // once: confetti, a paw up, then back to normal
    paintToday();

    // Refresh streaks. For a new check-in, ask this habit's streak for new_milestones.
    var fresh = [];
    try {
      // Ask this habit first: Streaks awards a milestone the first time it computes the streak,
      // so the call that sees it first is the only one that reports it in new_milestones.
      if (!wasDone) fresh = toStreak(await streaksApi('GET', '/streaks/' + id)).fresh;
      T.streaks = toStreakMap(await streaksApi('GET', '/streaks'));
      T.streaksDown = false;
      var m = await streaksApi('GET', '/milestones');
      T.milestones = m;
    } catch (err) {
      if (err.status === 401) return;
      T.streaksDown = true;
    }
    paintToday();
    if (fresh.length) celebrate(fresh);             // the dialog has its own picture; the cat already celebrated
  }

  async function archiveHabit(id) {
    var h = T.habits.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!h) return;
    try {
      await habitsApi('PATCH', '/habits/' + id, { archived: true });
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
      return;
    }
    h.archived = true;
    paintToday();
    toast(h.name + ' archived', {
      action: { label: 'Undo', run: async function () {
        try { await habitsApi('PATCH', '/habits/' + id, { archived: false }); h.archived = false; if (T) paintToday(); }
        catch (err) { if (err.status !== 401) toast(err.message, { error: true }); }
      } }
    });
  }

  async function createGroup(form) {
    var name = form.elements.name.value.trim();
    if (!name) { T.addingGroup = false; paintGroups(); return; }
    try {
      var g = await habitsApi('POST', '/groups', { name: name });
      T.groups.push(g.group || g);
      T.group = (g.group || g).id;
      T.addingGroup = false;
      paintToday();
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
    }
  }

  async function deleteGroup() {
    if (T.group == null) return;
    var name = groupName(T.group);
    if (!window.confirm('Delete the group "' + name + '"?')) return;
    try {
      await habitsApi('DELETE', '/groups/' + T.group);
      T.groups = T.groups.filter(function (g) { return String(g.id) !== String(T.group); });
      T.group = null;
      // The server decides what happens to the habits in that group, so ask it again
      T.habits = asList(await habitsApi('GET', '/habits'), 'habits').map(toHabit);
      paintToday();
      toast('Group "' + name + '" deleted');
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
    }
  }

  // ------------------------------------------------------------------
  // Screen 3: New habit
  // ------------------------------------------------------------------

  async function viewNew(groupId) {
    var my = nav;
    main.innerHTML =
      '<div class="page narrow">' +
        '<a class="back" href="#/today">' + ICON_BACK + 'Back to today</a>' +
        '<h1>New habit</h1>' +
        '<div class="split">' +
          '<form class="card stack" data-form="newhabit" novalidate>' +
            '<div class="field"><label for="name">What do you want to do?</label>' +
              '<input id="name" name="name" type="text" maxlength="80" placeholder="e.g. Read for 10 minutes" autocomplete="off" aria-describedby="err-name">' +
              '<p class="field-err" id="err-name"></p></div>' +
            '<div class="field"><label for="group">Group <span class="muted">(optional)</span></label>' +
              '<select id="group" name="group"><option value="">No group</option></select></div>' +
            '<div class="field"><label for="newgroup">Or create a new group <span class="muted">(optional)</span></label>' +
              '<input id="newgroup" name="newgroup" type="text" maxlength="40" placeholder="e.g. Morning" autocomplete="off" aria-describedby="err-newgroup">' +
              '<p class="field-err" id="err-newgroup"></p></div>' +
            '<p class="form-err" role="alert"></p>' +
            '<button class="btn" type="submit" id="save-habit">Save habit</button>' +
          '</form>' +
          '<div class="cat-stage auth-stage"><span class="moon" aria-hidden="true"></span><buddy-cat id="cat" mode="auto" height="230" start="0.5"></buddy-cat></div>' +
        '</div>' +
      '</div>';
    try {
      var groups = asList(await habitsApi('GET', '/groups'), 'groups');
      if (stale(my)) return;
      $('#group').insertAdjacentHTML('beforeend', groups.map(function (g) {
        return '<option value="' + esc(g.id) + '">' + esc(g.name) + '</option>';
      }).join(''));
      if (groupId != null) {                                                  // opened from a group: that group is already chosen
        var chosen = groups.filter(function (g) { return String(g.id) === String(groupId); })[0];
        if (chosen) { $('#group').value = String(chosen.id); $('h1').textContent = 'New habit in ' + chosen.name; }
      }
    } catch (err) {
      if (!stale(my) && err.status !== 401) toast(err.message, { error: true });
    }
    $('#name').focus();
  }

  async function submitNewHabit(form) {
    clearErrors(form);
    var name = form.elements.name.value.trim();
    var newGroup = form.elements.newgroup.value.trim();
    if (!name) { fieldError(form, 'name', 'Give your habit a name.'); form.elements.name.focus(); return; }

    var button = $('#save-habit');
    setBusy(button, true, 'Saving…');
    try {
      var groupId = form.elements.group.value || null;
      if (newGroup) {
        var g = await habitsApi('POST', '/groups', { name: newGroup });
        groupId = (g.group || g).id;
      }
      await habitsApi('POST', '/habits', { name: name, group_id: groupId });
      returnGroup = groupId;                      // back on Today, that group is still the one shown
      cue('stretch');
      toast('"' + name + '" added');
      await wait(1300);                           // let the cat finish its stretch
      location.hash = '#/today';
    } catch (err) {
      showFormError(form, err, ['name', 'newgroup']);
      setBusy(button, false, 'Save habit');
    }
  }

  // ------------------------------------------------------------------
  // Screen 4: Habit detail
  // ------------------------------------------------------------------

  var D = null;     // the habit detail screen's data

  async function viewHabit(id) {
    var my = nav;
    var now = new Date();
    D = { id: id, habit: null, groups: [], stats: null, statsDown: false, checks: {}, month: new Date(now.getFullYear(), now.getMonth(), 1), today: iso(now) };
    main.innerHTML = '<div class="page narrow"><a class="back" href="#/today">' + ICON_BACK + 'Back to today</a>' +
      '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="height:300px"></div></div>';

    try {
      var results = await Promise.all([habitsApi('GET', '/habits/' + id), habitsApi('GET', '/groups')]);
      if (stale(my)) return;
      D.habit = toHabit(results[0].habit || results[0]);
      D.groups = asList(results[1], 'groups');
    } catch (err) {
      if (stale(my) || err.status === 401) return;
      main.innerHTML = loadError(err);
      return;
    }
    paintHabit();
    await Promise.all([loadMonth(my), loadStats(my)]);
  }

  async function loadMonth(my) {
    var first = D.month, last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    try {
      var data = await habitsApi('GET', '/history?habit_id=' + D.id + '&from=' + iso(first) + '&to=' + iso(last) + '&include_archived=true');
      if (my != null && stale(my)) return;
      D.checks = {};
      toCheckins(data).forEach(function (c) { D.checks[c.date] = true; });
      paintCalendar();
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
    }
  }

  async function loadStats(my, logged) {
    try {
      var data = await streaksApi('GET', '/streaks/' + D.id);
      if (my != null && stale(my)) return;
      D.stats = toStreak(data);
      D.statsDown = false;
      if (D.stats.fresh.length && logged) { celebrate(D.stats.fresh); }   // only right after a day was logged, not on opening the page
    } catch (err) {
      if (err.status === 401 || (my != null && stale(my))) return;
      D.statsDown = true;
    }
    paintStats();
    setCatMode('auto');
  }

  function paintHabit() {
    var h = D.habit;
    var options = '<option value="">No group</option>' + D.groups.map(function (g) {
      return '<option value="' + esc(g.id) + '"' + (String(g.id) === String(h.group_id) ? ' selected' : '') + '>' + esc(g.name) + '</option>';
    }).join('');
    main.innerHTML =
      '<div class="page narrow">' +
        '<a class="back" href="#/today">' + ICON_BACK + 'Back to today</a>' +
        '<div class="split"><div class="stack" style="flex:1;min-width:0">' +
          '<div><p class="eyebrow">' + (h.archived ? 'Archived habit' : 'Habit') + '</p><h1 id="habit-title">' + esc(h.name) + '</h1></div>' +
          '<div id="stats"></div>' +
          '<section class="card" aria-labelledby="cal-title"><div class="cal-head">' +
            '<button class="icon-btn" type="button" data-action="cal-prev" aria-label="Previous month">' + ICON_BACK + '</button>' +
            '<h2 id="cal-title"></h2>' +
            '<button class="icon-btn" type="button" data-action="cal-next" aria-label="Next month" style="transform:scaleX(-1)">' + ICON_BACK + '</button>' +
          '</div><div id="calendar"></div><p class="hint" style="margin-top:10px">Tap a day to add or remove a check-in. Future days are not allowed.</p></section>' +
          '<form class="card stack" data-form="edit" novalidate>' +
            '<h2>Edit habit</h2>' +
            '<div class="field"><label for="edit-name">Name</label><input id="edit-name" name="name" type="text" maxlength="80" value="' + esc(h.name) + '" aria-describedby="err-name"><p class="field-err" id="err-name"></p></div>' +
            '<div class="field"><label for="edit-group">Group</label><select id="edit-group" name="group">' + options + '</select></div>' +
            '<p class="form-err" role="alert"></p>' +
            '<div class="row"><button class="btn" type="submit" id="edit-save">Save changes</button>' +
            '<button class="btn btn-ghost" type="button" data-action="toggle-archive">' + (h.archived ? 'Restore habit' : 'Archive habit') + '</button></div>' +
          '</form>' +
        '</div>' +
        '<div class="cat-stage auth-stage"><span class="moon" aria-hidden="true"></span><buddy-cat id="cat" mode="auto" height="230" start="0.5"></buddy-cat></div></div>' +
      '</div>';
    paintStats();
    paintCalendar();
  }

  function paintStats() {
    var el = $('#stats');
    if (!el) return;
    if (D.statsDown) { el.innerHTML = noticeStreaksDown(); return; }
    var s = D.stats;
    el.innerHTML = '<div class="stats">' +
      stat(s ? s.current : '…', 'Current streak') +
      stat(s ? s.longest : '…', 'Longest streak') +
      stat(s ? (s.rate == null ? rateFromChecks() : s.rate + '%') : '…', 'Completion rate') + '</div>';
  }
  function stat(value, label) { return '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>'; }
  function rateFromChecks() { return '–'; }       // only shown if the server sends no rate

  function paintCalendar() {
    var title = $('#cal-title');
    if (!title) return;
    var year = D.month.getFullYear(), month = D.month.getMonth();
    title.textContent = D.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var lead = (new Date(year, month, 1).getDay() + 6) % 7;   // blank cells before the 1st (weeks start on Monday)
    var count = new Date(year, month + 1, 0).getDate();
    var html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return '<div class="dow" aria-hidden="true">' + d + '</div>'; }).join('');
    for (var i = 0; i < lead; i++) html += '<div></div>';
    for (var day = 1; day <= count; day++) {
      var date = year + '-' + pad(month + 1) + '-' + pad(day);
      var on = !!D.checks[date];
      var label = parseISO(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      html += '<button type="button" data-action="cal-day" data-date="' + date + '" aria-pressed="' + on + '"' +
        ' class="' + (date > D.today ? 'future ' : '') + (date === D.today ? 'today' : '') + '"' +
        ' aria-label="' + label + (on ? ', checked in' : '') + '">' + day + '</button>';
    }
    $('#calendar').innerHTML = '<div class="cal">' + html + '</div>';
  }

  async function toggleDate(date) {
    var on = !!D.checks[date];
    try {
      if (on) await habitsApi('DELETE', '/habits/' + D.id + '/checkins?date=' + date);
      else await habitsApi('POST', '/habits/' + D.id + '/checkins', { date: date });   // server rejects future dates
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });   // e.g. "can't check in on a future date"
      return;
    }
    if (on) delete D.checks[date]; else D.checks[date] = true;
    paintCalendar();
    if (!on) cue('celebrate');
    loadStats(null, !on);
  }

  async function saveEdit(form) {
    clearErrors(form);
    var name = form.elements.name.value.trim();
    if (!name) { fieldError(form, 'name', 'The name cannot be empty.'); return; }
    var button = $('#edit-save');
    setBusy(button, true, 'Saving…');
    try {
      var updated = await habitsApi('PATCH', '/habits/' + D.id, { name: name, group_id: form.elements.group.value || null });
      D.habit = toHabit(Object.assign({}, D.habit, updated && (updated.habit || updated)));
      $('#habit-title').textContent = D.habit.name;
      toast('Saved');
    } catch (err) {
      showFormError(form, err, ['name']);
    }
    setBusy(button, false, 'Save changes');
  }

  async function toggleArchive() {
    var archived = !D.habit.archived;
    try {
      await habitsApi('PATCH', '/habits/' + D.id, { archived: archived });
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
      return;
    }
    toast(D.habit.name + (archived ? ' archived' : ' restored'));
    location.hash = '#/today';
  }

  // ------------------------------------------------------------------
  // Screen 5: Milestones
  // ------------------------------------------------------------------

  var lastMilestones = [];
  function paintMilestoneCards() {
    var worn = getWorn();
    $('#mbody').innerHTML = '<ul class="mgrid">' + lastMilestones.map(function (m) {
      var on = String(m.days) === String(worn);
      return '<li class="mcard ' + (m.earned ? 'earned' : 'locked') + (on ? ' worn' : '') + '">' +
        '<span class="art">' + itemIcon(m.days, 100) + '</span>' +
        '<span class="big">' + m.days + '<small>days</small></span>' +
        '<strong>' + esc(outfitName(m.days, m.item)) + '</strong>' +
        (m.earned
          ? '<span class="tag">Earned' + (m.date ? ' ' + esc(fmtDate(m.date)) : '') + '</span>' +
            '<button class="btn btn-small' + (on ? '' : ' btn-ghost') + '" type="button" data-action="wear" data-days="' + m.days + '" aria-pressed="' + on + '">' + (on ? 'Wearing' : 'Wear') + '</button>'
          : '<span class="tag lock">' + plural(m.left, 'day') + ' to go</span>') +
        '</li>';
    }).join('') + '</ul>';
  }

  async function viewMilestones() {
    var my = nav;
    main.innerHTML =
      '<div class="page">' +
        '<div><p class="eyebrow">Keep going</p><h1>Milestones</h1>' +
        '<p class="muted" style="margin-top:6px">Keep a streak alive and your cat unlocks something new.</p></div>' +
        '<section class="auth-stage milestone-stage" aria-label="Your cat">' +
          '<span class="moon" aria-hidden="true"></span>' +
          '<p class="stage-chip" id="mchip" hidden></p>' +
          '<buddy-cat id="cat" mode="auto" height="320" start="0.5"></buddy-cat>' +
        '</section>' +
        '<div id="mbody"><ul class="mgrid">' + [1, 2, 3, 4, 5, 6].map(function () { return '<li class="skeleton" style="height:220px"></li>'; }).join('') + '</ul></div>' +
      '</div>';
    try {
      var results = await Promise.all([streaksApi('GET', '/milestones'), streaksApi('GET', '/streaks')]);
      if (stale(my)) return;
      var best = bestStreak(toStreakMap(results[1]));
      var list = toMilestones(results[0], best);
      var nextM = list.filter(function (m) { return !m.earned; })[0];
      $('#mchip').textContent = 'Best streak: ' + plural(best, 'day') + (nextM ? ' \u00b7 next milestone at ' + nextM.days : '');
      $('#mchip').hidden = false;
      lastMilestones = list;
      paintMilestoneCards();
      setCatMode('auto');
    } catch (err) {
      if (stale(my) || err.status === 401) return;
      $('#mbody').innerHTML = err.status === 0 || err.status >= 500 ? noticeStreaksDown() :
        '<div class="notice error">' + ICON_WARN + '<span>' + esc(err.message) + '</span></div>';
      setCatMode('auto');
    }
  }

  // ===================================================================
  // 5. Events and the router
  // ===================================================================

  // Every button has a data-action. This table says what each one does.
  var actions = {
    'auth-mode':     function (b) { setAuthMode(b.dataset.mode); },
    'logout':        function () { saveItem('hb_token', null); saveItem('hb_user', null); saveItem('hb_outfit', null); location.hash = '#/login'; },
    'toast-action':  function () { var a = toastAction; $('#toast').hidden = true; if (a) a.run(); },
    'celebrate-close': function () { $('#celebrate').close(); },
    'wear-now':      function (b) { setWorn(b.dataset.days); $('#celebrate').close(); dressCat(); toast('Your cat is wearing the ' + outfitName(+b.dataset.days) + ' outfit'); },
    'wear':          function (b) { var on = String(getWorn()) === b.dataset.days; setWorn(on ? null : b.dataset.days); dressCat(); paintMilestoneCards(); },
    'reload':        function () { route(); },
    'skip':          function (b, e) { e.preventDefault(); main.focus(); },

    'check':         function (b) { toggleToday(b.dataset.id); },
    'archive':       function (b) { archiveHabit(b.dataset.id); },
    'filter':        function (b) { T.filter = b.dataset.filter; paintFilters(); paintList(); },
    'group':         function (b) { T.group = b.dataset.id === '' ? null : b.dataset.id; paintFilters(); paintGroups(); paintList(); },
    'group-new':     function () { T.addingGroup = true; paintGroups(); },
    'group-cancel':  function () { T.addingGroup = false; paintGroups(); },
    'group-delete':  function () { deleteGroup(); },

    'cal-prev':      function () { D.month = new Date(D.month.getFullYear(), D.month.getMonth() - 1, 1); loadMonth(nav); },
    'cal-next':      function () { D.month = new Date(D.month.getFullYear(), D.month.getMonth() + 1, 1); loadMonth(nav); },
    'cal-day':       function (b) { toggleDate(b.dataset.date); },
    'toggle-archive': function () { toggleArchive(); }
  };
  var forms = { auth: submitAuth, group: createGroup, newhabit: submitNewHabit, edit: saveEdit };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });
  document.addEventListener('submit', function (e) {
    var handler = forms[e.target.dataset.form];
    if (handler) { e.preventDefault(); handler(e.target); }
  });

  var routes = { login: viewLogin, today: viewToday, new: viewNew, habit: viewHabit, milestones: viewMilestones };

  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var name = parts[0] || 'today';
    if (!routes[name]) name = 'today';

    if (!getToken() && name !== 'login') { location.hash = '#/login'; return; }
    if (getToken() && name === 'login') { location.hash = '#/today'; return; }

    nav += 1;
    if ($('#celebrate').open) $('#celebrate').close();
    var loggedIn = name !== 'login';
    $('#topbar').hidden = !loggedIn;
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var current = a.dataset.nav === name || (name === 'habit' && a.dataset.nav === 'today');
      if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    routes[name](parts[1] ? decodeURIComponent(parts[1]) : undefined);
    if (name !== 'login') dressCat();
    window.scrollTo(0, 0);
    if (name !== 'login') main.focus({ preventScroll: true });
  }

  window.addEventListener('hashchange', route);
  route();
})();

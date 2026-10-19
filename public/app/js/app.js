/* =========================================================================
 * app.js - 饮食记录 demo (single-page app running inside the Android WebView)
 *
 * Scope of this demo
 *   - multi-record per day across 7 meal slots (早/午/晚/加餐/练前/练后/夜宵)
 *   - custom foods: create once in 我的食物, reuse forever from the picker
 *   - weight input with unit conversion; carbs/protein/fat/kcal auto computed
 *   - 8 color themes + light/dark mode
 *   - social: friend feed, likes, comments  (local mock data in the demo)
 *   - persistence through the native bridge, localStorage, or memory
 * ========================================================================= */
(function () {
  'use strict';

  var STORE_KEY = 'dietdiary.v1';
  var APP_NAME = '食刻';
  var APP_VERSION = '0.7.6';
  var APP_VERSION_CODE = 1000015;
  // 已部署的社交后端（Turso + Render）。填进「我的 → 社交服务器」即可用，
  // 不填也能用 App：所有记录都存在本机，社交只是额外能力。
  var DEFAULT_SERVER = 'https://shike-api.onrender.com';
  // 检查更新兜底用的接口。这个接口不需要登录，所以没连服务器 / 没登录时
  // 直接从它那里问版本就行。
  // 之前这里指向 raw.githubusercontent.com/dietdiary/app —— 那个仓库根本不存在，
  // 请求永远 404，于是没登录的用户点「检查更新」只会看到「拿不到数据清单」。
  var VERSION_MANIFEST_URL = 'https://shike-api.onrender.com/api/version?platform=android';
  var bridge = (typeof window.Android !== 'undefined' && window.Android) ? window.Android : null;

  /** 有没有原生壳。没有就是网页版（Safari / Chrome 直接打开）。 */
  function isWebApp() { return !bridge; }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  var api = window.dietApi;

  /* ------------------------------------------------------------ utilities */
  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function r0(v) { return Math.round(v || 0); }
  function r1(v) { return Math.round((v || 0) * 10) / 10; }
  function f1(v) { var x = r1(v); return (x % 1 === 0 ? String(x) : x.toFixed(1)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function parseYmd(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  var DOW = ['日', '一', '二', '三', '四', '五', '六'];
  function dowShort(s) { return '周' + DOW[parseYmd(s).getDay()]; }
  function shiftDay(s, delta) { var d = parseYmd(s); d.setDate(d.getDate() + delta); return ymd(d); }
  function prettyDate(s) {
    if (s === today()) return '今天';
    if (s === shiftDay(today(), -1)) return '昨天';
    if (s === shiftDay(today(), 1)) return '明天';
    var d = parseYmd(s);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + dowShort(s);
  }

  /* ---------------------------------------------------------------- icons */
  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-5.5h5V20"/>',
    chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    bowl: '<path d="M3 11h18"/><path d="M4.5 11a7.5 7.5 0 0 0 15 0"/><path d="M9 7c0-1.5 1.5-2 1.5-3.5"/><path d="M14 7c0-1.2 1.2-1.7 1.2-3"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c0-3.4 2.8-5.6 6.2-5.6s6.2 2.2 6.2 5.6"/><path d="M16.5 5.4a3 3 0 0 1 0 5.4"/><path d="M18 14.8c2 .7 3.4 2.4 3.4 4.6"/>',
    user: '<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20.2c0-3.6 3.2-5.9 7.2-5.9s7.2 2.3 7.2 5.9"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    heart: '<path d="M12 20s-7.5-4.7-7.5-9.8A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.8C19.5 15.3 12 20 12 20z"/>',
    comment: '<path d="M21 11.5c0 4.1-4 7.4-9 7.4-1 0-2-.1-2.9-.4L4 20.5l1.2-3.4A7.2 7.2 0 0 1 3 11.5C3 7.4 7 4.2 12 4.2s9 3.2 9 7.3z"/>',
    trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 12.5h9L17.5 7"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14.5 5.5 18.5 9.5"/>',
    star: '<path d="m12 3.6 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.8l5.9-.9z"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v3.5"/><path d="M16 3v3.5"/>',
    scale: '<path d="M12 3v3"/><path d="M5 20h14"/><path d="M7.5 20a4.5 4.5 0 0 1 9 0"/><path d="M12 6 9 14"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="12" cy="15" r="1.3" fill="currentColor"/>',
    bell: '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 21h4"/>',
    logout: '<path d="M15 5H6.5v14H15"/><path d="M12 12h9"/><path d="m18 8.5 3.5 3.5L18 15.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.5 3.9 5.5 3.9 9S14.6 18.5 12 21c-2.6-2.5-3.9-5.5-3.9-9S9.4 5.5 12 3z"/>',
    download: '<path d="M12 4v11"/><path d="m8 11.5 4 4 4-4"/><path d="M5 20h14"/>',
    cloud: '<path d="M7 18h9.5a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.6 1.3A3.4 3.4 0 0 0 7 18z"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.1 14.6a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1.03z"/>'
  };
  function svg(name, cls) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      (ICON[name] || '') + '</svg>';
  }
  function avatarColor(seed) {
    var palette = ['#5C8D5A', '#3B82F6', '#F0763B', '#E0559B', '#7C6BF2', '#0EA5A4', '#E8503A', '#8FA86B', '#B4772E'];
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
    return palette[h % palette.length];
  }

  /* ------------------------------------------------------- food + records */
  // 图标表在 js/icons.js 里：174 种内置食物一名一图，自定义食物走关键词规则。
  function foodEmoji(name, cat) {
    if (typeof window.foodIcon === 'function') return window.foodIcon(name, cat);
    return '🍽️';
  }
  function catEmoji(cat) {
    if (typeof window.catIcon === 'function') return window.catIcon(cat);
    return '🍽️';
  }

  /* ---------------------------------------------------------------- state */

  var state = {
    theme: 'forest',
    mode: 'light',
    goals: { kcal: 2000, p: 110, f: 65, c: 250 },
    // 身体档案：每日目标默认由它算出来（米夫林-斯蒂尔杰尔公式）。
    // sex: 'm' | 'f'；activity 见 ACTIVITY；goal 见 GOAL_TYPES。
    body: { sex: 'f', age: 25, height: 165, weight: 60, activity: 'light', goal: 'keep' },
    // 体重记录 [{ d: '2026-10-17', kg: 60.2 }]，同一天只留一条
    weights: [],
    // 本机最后一次改身体档案的时间 / 服务器已确认的时间（整块按时间戳比新旧）
    profileUpdatedAt: 0,
    profileSyncedAt: 0,
    // 手动改过目标就置 true，之后不再被身体档案自动覆盖
    goalsManual: false,
    // 填过一次身体档案（或记过一次体重）才置 true：在那之前不擅自改老用户的目标
    bodyConfirmed: false,
    entries: [],
    custom: [],
    // 食物库里的「我的自定义食物」展开状态，默认收起
    customOpen: false,
    favorites: [],
    recent: [],
    view: 'today',
    date: today(),
    month: today().slice(0, 7),
    trendMode: 'week',
    feedTab: 'feed',
    expanded: {},
    friends: [],
    // 待处理的好友请求：incoming 是别人发给我的（要在好友页弹出来给人点接受），
    // outgoing 是我发出去还没被接受的（用来提示「已发送，等对方同意」）。
    friendReqs: { incoming: [], outgoing: [] },
    posts: [],
    profile: { name: '我', letter: '我', goalText: '保持', streak: 0 },
    onboarded: false,
    // 登录后默认开启「记录就自动上传」。关了也能记，只是手动点同步。
    autoSync: true,
    // 社交后端（Turso + Render）。baseUrl 为空 = 纯本地，不发任何请求。
    server: { baseUrl: DEFAULT_SERVER, token: '', userId: null, displayName: '' },
    // 饮食记录同步：diaryStamps[date] = 本机最后改动时间；
    // diarySynced[date] = 服务器已确认的时间。两者比较决定推还是拉。
    diaryStamps: {},
    diarySynced: {},
    update: { checkedAt: 0, latest: null, dismissed: 0 }
  };

  /**
   * 全新用户：什么都没有。真正意义上的空 App —— 不动 friends / posts /
   * favorites / recent / entries，这些全部保持 state 里的空数组。
   * 老版本这里会铺 30 天的假记录当演示数据，已按用户要求彻底去掉。
   */
  function emptyState() {
    state.entries = [];
    state.custom = [];
    state.favorites = [];
    state.recent = [];
    state.friends = [];
    state.friendReqs = { incoming: [], outgoing: [] };
    state.posts = [];
    state.profile.streak = 0;
  }

  /**
   * 历史演示数据（30 天假记录）已按用户要求整段删除。
   * 新用户装完 App 后今日页是空的，记录完全由自己产生。
   */

  function gramsPerUnit(foodName, unit) {
    var f = allFoods()[foodName];
    if (f && f.u === unit) return f.w;
    return window.SERVINGS[unit] || 100;
  }

  function allFoods() {
    if (allFoods._dirty || !allFoods._cache) {
      var m = {};
      for (var i = 0; i < window.FOODS.length; i++) m[window.FOODS[i].n] = window.FOODS[i];
      for (var j = 0; j < state.custom.length; j++) m[state.custom[j].n] = state.custom[j];
      allFoods._cache = m;
      allFoods._dirty = false;
    }
    return allFoods._cache;
  }
  function invalidateFoods() { allFoods._dirty = true; allFoods(); }

  // Display order for the library, so the "全部" tab opens on everyday food
  // (肉蛋/主食/蔬菜/水果) instead of whatever sorts first alphabetically.
  var CAT_ORDER = ['肉蛋', '主食', '蔬菜', '水果', '水产', '乳品', '豆类坚果',
    '家常菜', '快餐外卖', '零食甜点', '饮品', '油脂调味'];

  function foodList() {
    var out = window.FOODS.slice();
    for (var i = 0; i < state.custom.length; i++) out.push(state.custom[i]);
    out.sort(function (a, b) {
      var ca = CAT_ORDER.indexOf(a.c), cb = CAT_ORDER.indexOf(b.c);
      if (ca < 0) ca = CAT_ORDER.length;
      if (cb < 0) cb = CAT_ORDER.length;
      if (ca !== cb) return ca - cb;
      // custom foods first inside their category, then keep the curated order
      if (!!a.custom !== !!b.custom) return a.custom ? -1 : 1;
      return 0;
    });
    return out;
  }

  /* 「吃了多少」是个 0–1 的比例，缺省 1。
   * 为什么不干脆让用户把克数改小：点了一份 500 g 的外卖只吃一半的时候，
   * 「这份有 500 g」和「我吃了 250 g」是两条不同的信息 —— 前者配上价格才
   * 对得上“花了多少钱”，后者才是真实摄入。老记录没有 eat 字段，一律当全吃了。 */
  function eatenOf(e) {
    var v = Number(e && e.eat);
    return (isFinite(v) && v > 0 && v <= 1) ? v : 1;
  }
  /* 「吃了多少」的人话说法，给列表和面板共用 */
  function eatLabel(v) {
    if (v >= 1) return '全部';
    if (Math.abs(v - 0.5) < 0.02) return '一半';
    if (Math.abs(v - 1 / 3) < 0.02) return '三分之一';
    if (Math.abs(v - 0.25) < 0.02) return '四分之一';
    return Math.round(v * 100) + '%';
  }
  function recalc(entry) {
    /* 热量按「实际吃进去的克数」算：分量 × 吃了多少 */
    var k = ((entry.grams || 0) * eatenOf(entry)) / 100;
    entry.kcal = r0(entry.per100.e * k);
    entry.p = r1(entry.per100.p * k);
    entry.f = r1(entry.per100.f * k);
    entry.ch = r1(entry.per100.ch * k);
    return entry;
  }
  /* 一顿/一天花了多少钱。只统计填了价格的条目，没填的不算 0 元。 */
  function spentOf(list) {
    var total = 0, counted = 0;
    for (var i = 0; i < list.length; i++) {
      var p = Number(list[i] && list[i].price);
      if (isFinite(p) && p > 0) { total += p; counted++; }
    }
    return { total: r1(total), counted: counted };
  }
  /* 钱的写法：18 不写成 18.00，18.5 写成 18.5，18.55 写成 18.55 */
  function money(v) {
    var n = Math.round((Number(v) || 0) * 100) / 100;
    return (n % 1 === 0) ? String(n) : String(n).replace(/0+$/, '');
  }
  function makeEntry(date, food, meal, grams, unit, qty) {
    var e = {
      id: uid(), date: date, meal: meal, foodId: food.n, name: food.n, cat: food.c,
      unit: unit || '克', qty: qty == null ? grams : qty, grams: grams,
      per100: { e: food.e, p: food.p, f: food.f, ch: food.ch },
      kcal: 0, p: 0, f: 0, ch: 0, ts: Date.now(),
      eat: 1, price: 0, note: ''
    };
    return recalc(e);
  }
  function sumEntries(list) {
    var t = { kcal: 0, p: 0, f: 0, ch: 0 };
    for (var i = 0; i < list.length; i++) {
      t.kcal += list[i].kcal || 0; t.p += list[i].p || 0;
      t.f += list[i].f || 0; t.ch += list[i].ch || 0;
    }
    return { kcal: r0(t.kcal), p: r1(t.p), f: r1(t.f), ch: r1(t.ch) };
  }
  function dayEntries(date) {
    return state.entries.filter(function (e) { return e.date === date; })
      .sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  }
  function mealEntries(date, meal) {
    return dayEntries(date).filter(function (e) { return e.meal === meal; });
  }

  /* ----------------------------------------------------------- persistence */
  /* save() 原来每改一点就整体 JSON.stringify + 落盘一次。记录攒到几百条以后，
   * 切主题、点两下数字这种连击会连着写好几遍。改成合并到下一帧再写，
   * 真正要离开页面前 flushSave() 强制补上，不会丢。
   */
  var saveTimer = 0;

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; saveNow(); }
  }

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = 0; saveNow(); }, 120);
  }

  function saveNow() {
    var payload = {
      v: 1, theme: state.theme, mode: state.mode, goals: state.goals,
      entries: state.entries, custom: state.custom,
      favorites: state.favorites,
      recent: state.recent, profile: state.profile, onboarded: state.onboarded,
      friends: state.friends, friendReqs: state.friendReqs, time: Date.now(),
      // token 只在这台手机上存着，用来访问自己配的那台服务器
      server: state.server, update: state.update,
      diaryStamps: state.diaryStamps, diarySynced: state.diarySynced,
      // 身体档案 / 体重 / 目标是否手改过
      body: state.body, weights: state.weights,
      goalsManual: state.goalsManual, bodyConfirmed: state.bodyConfirmed,
      profileUpdatedAt: state.profileUpdatedAt, profileSyncedAt: state.profileSyncedAt
    };
    var json = JSON.stringify(payload);
    try {
      if (bridge && bridge.save) { bridge.save(json); }
      else { localStorage.setItem(STORE_KEY, json); }
    } catch (err) { /* memory only */ }
    // 记录一落盘就安排一次后台同步。本地永远是第一位的：网络失败不影响
    // 记录，只是这次没推上去，下次有改动或开 App 时会自动补。
    scheduleSync();
  }
  function load() {
    var json = null;
    try {
      if (bridge && bridge.load) json = bridge.load();
      if (!json) json = localStorage.getItem(STORE_KEY);
    } catch (err) { json = null; }
    // 第一次装 App：什么都不预置。没有示例记录、没有假好友、没有收藏。
    if (!json) { emptyState(); return; }
    try {
      var p = JSON.parse(json);
      state.theme = p.theme || state.theme;
      state.mode = p.mode || state.mode;
      state.goals = p.goals || state.goals;
      // 老存档没有 body/weights：保留默认值，别把 state.body 变成 undefined
      if (p.body) {
        for (var bk in state.body) {
          if (p.body[bk] !== undefined && p.body[bk] !== null) state.body[bk] = p.body[bk];
        }
      }
      state.weights = p.weights || [];
      state.goalsManual = !!p.goalsManual;
      state.bodyConfirmed = !!p.bodyConfirmed;
      state.profileUpdatedAt = Number(p.profileUpdatedAt) || 0;
      state.profileSyncedAt = Number(p.profileSyncedAt) || 0;
      state.entries = p.entries || [];
      state.custom = p.custom || [];
      state.favorites = p.favorites || [];
      state.recent = p.recent || [];
      state.profile = p.profile || state.profile;
      state.friends = p.friends || [];
      if (p.friendReqs && p.friendReqs.incoming) state.friendReqs = p.friendReqs;
      state.onboarded = !!p.onboarded;
      if (p.server) state.server = p.server;
      if (p.update) state.update = p.update;
      if (p.diaryStamps) state.diaryStamps = p.diaryStamps;
      if (p.diarySynced) state.diarySynced = p.diarySynced;
      if (typeof p.autoSync === 'boolean') state.autoSync = p.autoSync;
      // 好友动态永远从服务器拉，本机不再缓存假动态
      state.posts = [];
    } catch (err) {
      // 存档坏了：当新用户处理，别把半截数据留在内存里
      emptyState();
    }
  }

  /* -------------------------------------------------------------- chrome */
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 1700);
  }

  var sheetOpen = null;
  var sheetCloseTimer = null;
  function openSheet(title, bodyHtml, footHtml, opts) {
    opts = opts || {};
    var sheet = $('#sheet'), scrim = $('#scrim');
    if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
    sheet.innerHTML =
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><h2>' + esc(title) + '</h2>' +
      (opts.noClose ? '' : '<button class="icon-btn" data-close="1">' + svg('close') + '</button>') + '</div>' +
      '<div class="sheet-body">' + bodyHtml + '</div>' +
      (footHtml ? '<div class="sheet-foot">' + footHtml + '</div>' : '');
    scrim.classList.remove('hidden');
    setTimeout(function () { scrim.classList.add('show'); sheet.classList.add('show'); }, 10);
    document.body.classList.add('no-scroll');
    sheetOpen = opts;
    $$('[data-close]', sheet).forEach(function (b) {
      b.addEventListener('click', closeSheet);
    });
    return sheet;
  }
  function closeSheet() {
    // 引导页（modal）不允许被划掉：没注册/登录就关掉的话，用户会卡在一个
    // 空荡荡还没法同步的 App 里，不如直接拦住。
    if (sheetOpen && sheetOpen.modal) {
      if (!closeSheet._hinted || Date.now() - closeSheet._hinted > 2500) {
        closeSheet._hinted = Date.now();
        toast('先注册或登录，或者点「先随便看看」');
      }
      return;
    }
    var sheet = $('#sheet'), scrim = $('#scrim');
    sheet.classList.remove('show');
    scrim.classList.remove('show');
    document.body.classList.remove('no-scroll');
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(function () {
      scrim.classList.add('hidden');
      sheet.innerHTML = '';
      sheetCloseTimer = null;
    }, 280);
    sheetOpen = null;
  }

  /* #sheet 是常驻 DOM 节点：innerHTML 换掉、节点本身不变。所以每次打开面板都
     addEventListener 的话，监听器会一直累加——份量面板的加号点一次却加了 5，
     就是前面开过 5 次留下的 5 个监听都在跑。这里改挂到「每次新生成」的
     .sheet-body / .sheet-foot 上，旧节点被 innerHTML 换掉时监听随之消失。 */
  function bindSheet(type, fn) {
    var sheet = $('#sheet');
    var body = sheet.querySelector('.sheet-body');
    var foot = sheet.querySelector('.sheet-foot');
    if (body) body.addEventListener(type, fn);
    if (foot) foot.addEventListener(type, fn);
  }

  /* ------------------------------------------------------------ views */
  function render() {
    var v = state.view;
    var html = '';
    if (v === 'today') html = viewToday();
    else if (v === 'trend') html = viewTrend();
    else if (v === 'foods') html = viewFoods();
    else if (v === 'social') html = viewSocial();
    else if (v === 'me') html = viewMe();
    var view = $('#view');
    view.innerHTML = html;
    // 换页/换日期才播入场动画并回到顶部；同页刷新（加一条记录、切主题）不播，
    // 否则每点一下整屏都晃一遍。
    var key = state.view + '|' + state.date;
    if (key !== render._key) {
      render._key = key;
      view.classList.remove('v-enter');
      void view.offsetWidth;          // 强制重排，让动画能重播
      view.classList.add('v-enter');
      window.scrollTo(0, 0);
    }
    renderTabbar();
    // 日期条是横向滚动的，重建 DOM 后 scrollLeft 会回到 0，
    // 结果今天是 17 号却只看到 11–15，得往右滑才找得到今天。
    // 每次渲染完都把选中那天滚到可视区最右边。
    scrollDateStripToSelected();
    var fab = $('#fab');
    if (v === 'today' || v === 'foods') { fab.classList.remove('hidden'); }
    else fab.classList.add('hidden');
    if (v === 'social' && state.socialFocus) {
      var el = document.getElementById(state.socialFocus);
      if (el) { el.scrollIntoView({ block: 'start' }); }
      state.socialFocus = null;
    }
  }

  function topbar(title, sub, rightHtml) {
    return '<div class="topbar"><div class="topbar-row"><div>' +
      '<h1>' + esc(title) + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') +
      '</div><div style="display:flex;gap:8px">' + (rightHtml || '') + '</div></div></div>';
  }

  /* -------- 今日 ------------------------------------------------------- */
  function viewToday() {
    var list = dayEntries(state.date);
    var t = sumEntries(list);
    var g = state.goals;
    var left = g.kcal - t.kcal;

    var html = topbar(prettyDate(state.date), state.date + ' · ' + dowShort(state.date),
      '<button class="icon-btn" data-act="pick-date">' + svg('calendar') + '</button>');

    html += '<div class="screen has-topbar">';
    html += '<div class="date-strip">' + dateStrip() + '</div>';

    if (!list.length) html += emptyHint();

    html += '<div class="card">';
    html += '<div class="ring-grid">' +
      goalRing('热量', t.kcal, g.kcal, 'kcal', 'k-kcal') +
      goalRing('蛋白', t.p, g.p, 'g', 'k-pro') +
      goalRing('碳水', t.ch, g.c, 'g', 'k-carb') +
      goalRing('脂肪', t.f, g.f, 'g', 'k-fat') +
      '</div>';
    html += '<div class="kcal-left">' + (left >= 0
      ? '还可摄入 <b>' + left + '</b> kcal'
      : '已超出 <b>' + Math.abs(left) + '</b> kcal') + '</div>';
    html += '</div>';

    for (var i = 0; i < window.MEALS.length; i++) {
      html += mealBlock(window.MEALS[i]);
    }
    html += '</div>';
    return html;
  }

  /**
   * 新用户（一条记录都没有）时今日页顶部的引导卡。老版本这里靠预置的假
   * 记录撑场面，现在什么都没了，得明确告诉用户下一步点哪里。
   */
  function emptyHint() {
    return '<div class="card empty-hint">' +
      '<div class="eh-emoji">🍽️</div>' +
      '<div class="eh-title">还没有记录</div>' +
      '<div class="eh-text">点下面任意一餐的「添加」，或右下角的 + 号，' +
      '从 174 种食物里挑 —— 找不到的可以自己建一个，填一次以后永久复用。</div>' +
      '<div class="eh-actions">' +
      '<button class="btn small" data-act="add-food" data-meal="breakfast">记录早餐</button>' +
      '<button class="btn ghost small" data-act="new-food">新建食物</button>' +
      '</div></div>';
  }

  /**
   * 一个圆圈进度：中间是当前值，下面写目标。
   * cls 决定颜色（k-kcal 用主题色，其余用三大营养素各自的颜色）。
   */
  function goalRing(label, val, goal, unit, cls) {
    var pct = Math.min(100, (val / (goal || 1)) * 100);
    var R = 25, C = 2 * Math.PI * R;
    // 四位数（热量常是 1800-2500）在小圆圈里会顶到描边，字号收一档
    var sm = String(r0(val)).length >= 4 ? ' class="sm"' : '';
    return '<div class="mring ' + cls + '">' +
      '<div class="mring-c">' +
      '<svg viewBox="0 0 64 64">' +
      '<circle class="rg-bg" cx="32" cy="32" r="' + R + '"/>' +
      '<circle class="rg-fg" cx="32" cy="32" r="' + R + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C - C * pct / 100).toFixed(1) + '"/>' +
      '</svg>' +
      '<div class="mring-mid"><b' + sm + '>' + r0(val) + '</b><span>' + unit + '</span></div>' +
      '</div>' +
      '<div class="mring-l">' + label + '</div>' +
      '<div class="mring-g">目标 ' + r0(goal) + '</div>' +
      '</div>';
  }

  function macroRow(label, val, goal, cls) {
    var pct = Math.min(100, (val / (goal || 1)) * 100);
    return '<div class="macro-row"><span class="k">' + label + '</span>' +
      '<span class="track"><i class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></i></span>' +
      '<span class="v">' + r0(val) + '/' + r0(goal) + 'g</span></div>';
  }

  function dateStrip() {
    var out = '';
    // 只到「今天」为止：以前多发一个明天，导致今天被挤到倒数第二格、
    // 一进来还得往右滑才看得到。
    for (var i = 6; i >= 0; i--) {
      var d = shiftDay(today(), -i);
      var has = dayEntries(d).length > 0;
      var cls = 'date-chip' + (d === state.date ? ' on' : '') + (d === today() ? ' today' : '');
      out += '<button class="' + cls + '" data-act="pick-date" data-date="' + d + '">' +
        '<div class="dow">' + (i === 0 ? '今天' : dowShort(d)) + '</div>' +
        '<div class="dom">' + parseYmd(d).getDate() + '</div>' +
        (has ? '<div class="dot"></div>' : '<div style="height:7px"></div>') +
        '</button>';
    }
    return out;
  }

  /**
   * 把日期条滚到「选中的那一天贴在右边缘」。
   * 一开始没滚动时只看得到最左边 5 个格子，今天压根在屏幕外，
   * 所以每次 render 之后都要调一次。
   */
  function scrollDateStripToSelected() {
    var strip = $('.date-strip');
    if (!strip) return;
    var chip = strip.querySelector('.date-chip.on') || strip.querySelector('.date-chip.today');
    if (!chip) return;
    // 用两个 rect 相减算相对位置，别用 offsetLeft —— 它相对的是最近的定位祖先，
    // 而 .date-strip 没有 position: relative，算出来的值会偏。
    var sr = strip.getBoundingClientRect();
    var cr = chip.getBoundingClientRect();
    // 右边留一点空：贴死在边缘时那片绿色高亮看着像被切掉一角。
    var pad = 14;
    var target = strip.scrollLeft + (cr.left - sr.left) + cr.width - strip.clientWidth + pad;
    if (target < 0) target = 0;
    strip.scrollLeft = target;
  }

  function mealBlock(meal) {
    var list = mealEntries(state.date, meal.id);
    var t = sumEntries(list);
    var html = '<div class="meal"><div class="meal-head">' +
      '<span class="meal-emoji">' + meal.emoji + '</span>' +
      '<span class="meal-name">' + meal.name + '</span>' +
      '<span class="meal-kcal">' + (list.length ? '<b>' + t.kcal + '</b> kcal' : '<span class="muted small">未记录</span>') + '</span>' +
      '</div>';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var ate = eatenOf(e);
      html += '<div class="entry anim" data-act="edit-entry" data-id="' + e.id + '">' +
        '<div class="thumb">' + foodEmoji(e.name, e.cat) + '</div>' +
        '<div class="body"><div class="title">' + esc(e.name) + '</div>' +
        '<div class="meta">' + f1(e.qty) + e.unit + ' · ' + r0(e.grams) + 'g' +
        (ate < 1 ? ' · 吃了' + eatLabel(ate) : '') +
        ' · 碳' + f1(e.ch) + ' 蛋' + f1(e.p) + ' 脂' + f1(e.f) +
        (Number(e.price) > 0 ? ' · ¥' + money(e.price) : '') +
        '</div>' +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
        '</div>' +
        '<div class="kcal">' + e.kcal + '<span>kcal</span></div></div>';
    }
    html += '<button class="add-line" data-act="add-food" data-meal="' + meal.id + '">' + svg('plus') + ' 添加到' + meal.name + '</button>';
    html += '</div>';
    return html;
  }

  /* -------- 总览 ------------------------------------------------------- */
  function viewTrend() {
    var html = topbar('总览', state.trendMode === 'month' ? '月视图 · ' + monthLabel(state.month) : '最近 7 天');
    html += '<div class="screen has-topbar">';
    html += '<div class="segmented mode-seg">' +
      '<button class="' + (state.trendMode === 'week' ? 'on' : '') + '" data-act="trend-mode" data-mode="week">周视图</button>' +
      '<button class="' + (state.trendMode === 'month' ? 'on' : '') + '" data-act="trend-mode" data-mode="month">月视图</button>' +
      '</div>';
    html += (state.trendMode === 'month') ? monthView() : weekView();
    html += '</div>';
    return html;
  }

  /* -------- 周视图 ----------------------------------------------------- */
  function weekView() {
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(shiftDay(today(), -i));
    var sums = days.map(function (d) { return sumEntries(dayEntries(d)); });
    var max = 1;
    sums.forEach(function (s) { max = Math.max(max, s.kcal); });
    max = Math.max(max, state.goals.kcal) * 1.12;
    var week = sumEntries(state.entries.filter(function (e) { return days.indexOf(e.date) >= 0; }));
    var avg = week.kcal / 7;

    var html = '';
    html += '<div class="card"><div class="card-head"><h2>每日热量</h2><span class="hint">目标 ' + state.goals.kcal + ' kcal</span></div>';
    html += '<div class="barchart">';
    for (var k = 0; k < days.length; k++) {
      var s = sums[k];
      var hpct = Math.max(1.5, (s.kcal / max) * 100);
      html += '<div class="col" data-act="day-detail" data-date="' + days[k] + '"><div class="val">' + (s.kcal ? s.kcal : '') + '</div>' +
        '<div class="bar' + (s.kcal > state.goals.kcal * 1.05 ? ' over' : '') + '" style="height:' + hpct + '%"></div>' +
        '<div class="lbl">' + dowShort(days[k]) + '</div></div>';
    }
    html += '</div><div class="small muted mt12">点任意一根柱子看那天的详情</div></div>';

    html += '<div class="stat-grid">' +
      stat('7 天日均', r0(avg), 'kcal') +
      stat('记录天数', days.filter(function (d) { return dayEntries(d).length; }).length, '/ 7 天') +
      stat('日均蛋白', r0(week.p / 7), 'g') +
      stat('记录条数', state.entries.filter(function (e) { return days.indexOf(e.date) >= 0; }).length, '条') +
      '</div>';

    html += '<div class="card mt12"><div class="card-head"><h2>三大营养素占比</h2><span class="hint">7 天合计</span></div>';
    var total = week.p * 4 + week.ch * 4 + week.f * 9 || 1;
    html += `<div class="macro-row"><span class="k">蛋白</span><span class="track"><i class="k-pro" style="width:${(week.p * 4 / total * 100).toFixed(1)}%"></i></span><span class="v">${(week.p * 4 / total * 100).toFixed(0)}%</span></div>`;
    html += `<div class="macro-row"><span class="k">碳水</span><span class="track"><i class="k-carb" style="width:${(week.ch * 4 / total * 100).toFixed(1)}%"></i></span><span class="v">${(week.ch * 4 / total * 100).toFixed(0)}%</span></div>`;
    html += `<div class="macro-row"><span class="k">脂肪</span><span class="track"><i class="k-fat" style="width:${(week.f * 9 / total * 100).toFixed(1)}%"></i></span><span class="v">${(week.f * 9 / total * 100).toFixed(0)}%</span></div>`;
    html += '<div class="small muted mt12">建议区间：蛋白 15~25% · 碳水 45~60% · 脂肪 20~30%</div>';
    html += '</div>';
    return html;
  }

  /* -------- 月视图 ----------------------------------------------------- */
  function monthLabel(ym) {
    var a = ym.split('-');
    return a[0] + ' 年 ' + (+a[1]) + ' 月';
  }
  function shiftMonth(ym, delta) {
    var a = ym.split('-');
    var d = new Date(+a[0], +a[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  // 三种目标值都用同一套判定，减脂/增肌界线放在 2400。
  function goalKind(kcal) {
    if (!kcal) return 'keep';
    if (kcal <= 1900) return 'cut';
    if (kcal >= 2400) return 'bulk';
    return 'keep';
  }
  function goalKindText(kind) {
    return kind === 'cut' ? '减脂热量' : (kind === 'bulk' ? '增肌热量' : '维持热量');
  }

  /**
   * 把当天热量换算成「状态色」。返回 null 表示没记录。
   * 超出目标 10% 以上算严重过多；低于 70% 算严重过少；
   * 其余落在 ±10% 内（或 70%~110%）算摄入接近，再按减脂/维持/增肌上色。
   */
  function monthStatus(kcal, goal) {
    if (!kcal) return null;
    var g = goal || 2000;
    var r = kcal / g;
    if (r > 1.1) return 'over';
    if (r < 0.7) return 'low';
    return goalKind(g);
  }
  var STATUS_TEXT = {
    over: '严重过多', low: '严重过少',
    cut: '减脂达标', bulk: '增肌达标', keep: '摄入接近'
  };
  var STATUS_COLOR = {
    over: '#E8503A', low: '#F2B33D',
    cut: '#3F9E63', bulk: '#4C7DF0', keep: '#8A9AA8'
  };

  function monthView() {
    var a = state.month.split('-');
    var y = +a[0], m = +a[1];
    var first = new Date(y, m - 1, 1);
    var daysInMonth = new Date(y, m, 0).getDate();
    var lead = first.getDay();               // 周日开头
    var g = state.goals.kcal || 2000;

    var sums = {}, listed = 0, sumKcal = 0, overDays = 0, lowDays = 0, goodDays = 0, targetDays = 0;
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = state.month + '-' + pad(d);
      var s = sumEntries(dayEntries(ds));
      sums[ds] = s.kcal;
      if (s.kcal > 0) {
        listed++;
        sumKcal += s.kcal;
        var st = monthStatus(s.kcal, g);
        if (st === 'over') overDays++;
        else if (st === 'low') lowDays++;
        else { goodDays++; if (s.kcal >= g * 0.9 && s.kcal <= g * 1.1) targetDays++; }
      }
    }
    var todayYm = today().slice(0, 7);
    var canPrev = state.month > '2000-01';

    var html = '';
    html += '<div class="card"><div class="row-between mb12">' +
      '<button class="icon-btn" data-act="month-shift" data-d="-1">' + svg('back') + '</button>' +
      '<div class="month-title">' + monthLabel(state.month) + '</div>' +
      '<button class="icon-btn flip' + (state.month >= todayYm ? ' hidden' : '') + '" data-act="month-shift" data-d="1">' + svg('back') + '</button>' +
      '</div>';

    html += '<div class="month-head">' + ['日', '一', '二', '三', '四', '五', '六']
      .map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="month-grid">';
    for (var b = 0; b < lead; b++) html += '<span class="mday blank"></span>';
    for (var d2 = 1; d2 <= daysInMonth; d2++) {
      var ds2 = state.month + '-' + pad(d2);
      var kc = sums[ds2];
      var st2 = monthStatus(kc, g);
      var cls = 'mday' + (st2 ? ' s-' + st2 : '') + (ds2 === today() ? ' today' : '');
      html += '<button class="' + cls + '" data-act="day-detail" data-date="' + ds2 + '">' +
        '<span class="d">' + d2 + '</span>' +
        '<span class="k">' + (kc ? r0(kc) : '·') + '</span></button>';
    }
    html += '</div>';

    html += '<div class="legend">' +
      legendItem(STATUS_COLOR.cut, '减脂达标') +
      legendItem(STATUS_COLOR.bulk, '增肌达标') +
      legendItem(STATUS_COLOR.keep, '摄入接近') +
      legendItem(STATUS_COLOR.over, '严重过多') +
      legendItem(STATUS_COLOR.low, '严重过少') +
      legendItem('var(--surface-2)', '无记录') +
      '</div>';
    html += '<div class="small muted mt12">色块按当天热量与该目标比对：超出目标 10% 以上算严重过多，低于 70% 算严重过少，其余按减脂 / 维持 / 增肌上色。</div>';
    html += '</div>';

    html += '<div class="card mt12"><div class="card-head"><h2>本月概览</h2><span class="hint">目标 ' + g + ' kcal / 天</span></div>' +
      '<div class="stat-grid">' +
      stat('日均热量', listed ? r0(sumKcal / listed) : 0, 'kcal') +
      stat('记录天数', listed, '/ ' + daysInMonth + ' 天') +
      stat('踩到目标', targetDays, '天') +
      stat('超标天数', overDays, '天') +
      '</div>' +
      '<div class="small muted mt12">达标 ' + goodDays + ' 天 · 超标 ' + overDays + ' 天 · 吃太少 ' + lowDays + ' 天 · 没记录 ' + (daysInMonth - listed) + ' 天</div>' +
      '<div class="small muted mt8">' + monthSpendText() + '</div>' +
      '</div>';
    return html;
  }

  /* 本月在吃上花了多少（只统计填了价格的条目） */
  function monthSpendText() {
    var ym = state.month;
    var list = state.entries.filter(function (e) { return String(e.date || '').slice(0, 7) === ym; });
    var sp = spentOf(list);
    if (!sp.counted) return '这月还没记过价格 —— 在份量面板填「花了多少钱」，这里就能统计。';
    return '这月吃饭花了 ¥' + money(sp.total) + '（' + sp.counted + ' 条记了价格）';
  }

  function legendItem(color, label) {
    return '<span class="lg"><i style="background:' + color + '"></i>' + label + '</span>';
  }

  /**
   * 点某一天弹出的详情浮层：概览 + 分餐次清单，可直接改某一笔或去那天。
   */
  function openDayDetail(date) {
    var list = dayEntries(date);
    var t = sumEntries(list);
    var g = state.goals;
    var st = monthStatus(t.kcal, g.kcal);
    var left = g.kcal - t.kcal;

    var body = '';
    if (st) {
      body += '<div class="status-pill" style="background:' + STATUS_COLOR[st] + '">' +
        STATUS_TEXT[st] + '</div>';
    }
    body += '<div class="preview"><div class="cell"><div class="v">' + t.kcal + '</div><div class="k">热量 kcal</div></div>' +
      '<div class="cell"><div class="v" style="color:var(--c-pro)">' + f1(t.p) + '</div><div class="k">蛋白 g</div></div>' +
      '<div class="cell"><div class="v" style="color:#B08900">' + f1(t.ch) + '</div><div class="k">碳水 g</div></div>' +
      '<div class="cell"><div class="v" style="color:var(--c-fat)">' + f1(t.f) + '</div><div class="k">脂肪 g</div></div></div>';

    body += '<div class="row-between mt12"><span class="small muted">目标 ' + g.kcal + ' kcal</span>' +
      '<span class="small ' + (left >= 0 ? 'muted' : 'warn-text') + '">' +
      (left >= 0 ? '还可摄入 ' + left + ' kcal' : '超出 ' + Math.abs(left) + ' kcal') + '</span></div>';

    /* 花了多少钱：只算填了价格的条目，没填的不当作 0 元 */
    var sp = spentOf(list);
    if (sp.counted) {
      var noPrice = list.length - sp.counted;
      body += '<div class="row-between mt8"><span class="small muted">这天花了</span>' +
        '<span class="small"><b>¥' + money(sp.total) + '</b>' +
        (noPrice > 0 ? '<span class="muted"> · ' + noPrice + ' 条没填价格</span>' : '') + '</span></div>';
    }

    if (!list.length) {
      body += '<div class="card center muted mt12">这天还没有记录</div>';
    } else {
      for (var i = 0; i < window.MEALS.length; i++) {
        var meal = window.MEALS[i];
        var items = list.filter(function (e) { return e.meal === meal.id; });
        if (!items.length) continue;
        var sub = sumEntries(items);
        body += '<div class="day-meal"><div class="dm-head"><span>' + meal.emoji + ' ' + esc(meal.name) + '</span>' +
          '<b>' + sub.kcal + ' kcal</b></div>';
        for (var j = 0; j < items.length; j++) {
          var e2 = items[j];
          var ate2 = eatenOf(e2);
          var am = (ate2 < 1 ? '吃' + eatLabel(ate2) + ' ' : '') +
            (Number(e2.price) > 0 ? '¥' + money(e2.price) : '');
          body += '<div class="dm-row" data-act="edit-entry" data-id="' + e2.id + '">' +
            '<span class="ic">' + foodEmoji(e2.name, e2.cat) + '</span>' +
            '<span class="nm">' + esc(e2.name) + '</span>' +
            '<span class="am">' + am + '</span>' +
            '<span class="kc">' + r0(e2.kcal) + '</span></div>';
        }
        body += '</div>';
      }
    }

    openSheet(prettyDate(date), body,
      '<button class="btn ghost" data-act="goto-day" data-date="' + date + '">去这天记录</button>' +
      '<button class="btn" data-act="cancel">关闭</button>');
  }
  function stat(k, v, unit) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '<small>' + unit + '</small></div></div>';
  }

  /* -------- 食物库 ----------------------------------------------------- */
  var foodsFilter = { q: '', cat: '全部' };
  var favOnly = false;

  function viewFoods() {
    var list = foodList();

    var html = topbar('食物库', list.length + ' 种食物 · 每份热量',
      '<button class="icon-btn" data-act="fav-toggle">' + svg('star') + '</button>');

    html += '<div class="screen has-topbar">';
    html += '<div class="search">' + svg('search') +
      '<input id="food-search" placeholder="搜索食物，如 鸡胸肉 / 苹果" autocomplete="off" value="' + esc(foodsFilter.q) + '"></div>';
    html += '<div class="chips">' +
      chip('全部', foodsFilter.cat === '全部') +
      window.CATEGORIES.map(function (c) { return chip(c.emoji + ' ' + c.id, foodsFilter.cat === c.id, c.id); }).join('') +
      '</div>';

    // 只重绘这块：打字时不重绘输入框，焦点和光标才不会跳走
    html += '<div id="foods-body">' + foodsBodyHtml() + '</div>';
    html += '</div>';

    return html;
  }

  function foodsBodyHtml() {
    var list = foodList();
    var q = foodsFilter.q.trim();
    var lower = q.toLowerCase();
    function hit(f) {
      if (!q) return true;
      return String(f.n).toLowerCase().indexOf(lower) >= 0 ||
        String(f.c || '').toLowerCase().indexOf(lower) >= 0;
    }
    var matched = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!hit(f)) continue;
      if (foodsFilter.cat !== '全部' && f.c !== foodsFilter.cat) continue;
      if (favOnly && state.favorites.indexOf(f.n) < 0) continue;
      matched.push(f);
    }
    // Category first (CAT_ORDER), favourites floating to the top of their own
    // category. Sorting by favourite alone would interleave categories and make
    // the group headers in the "全部" list look shuffled.
    function rank(c) { var i = CAT_ORDER.indexOf(c); return i < 0 ? CAT_ORDER.length : i; }
    var out = matched.slice().sort(function (a, b) {
      var ra = rank(a.c), rb = rank(b.c);
      if (ra !== rb) return ra - rb;
      var fa = state.favorites.indexOf(a.n) >= 0 ? 0 : 1;
      var fb = state.favorites.indexOf(b.n) >= 0 ? 0 : 1;
      return fa - fb;
    });
    if (favOnly) out = out.filter(function (f) { return state.favorites.indexOf(f.n) >= 0; });

    var html = '';

    // 自定义食物单独一块，默认收起：攒多了会把下面整张表挤到很下面。
    // 搜索时强制展开 —— 否则搜出来的东西藏在折起来的地方，等于搜不到。
    var mine = state.custom.filter(hit);
    if (mine.length) {
      var openCustom = q ? true : !!state.customOpen;
      html += '<div class="card-head fold" data-act="toggle-custom">' +
        '<h2>我的自定义食物</h2>' +
        '<span class="hint">' + mine.length + ' 种 · ' + (openCustom ? '收起' : '展开') + '</span></div>';
      if (openCustom) {
        html += '<div class="list mb12">' +
          mine.map(function (f) { return foodRow(f, true); }).join('') + '</div>';
      }
    }

    // 标题跟着筛选走：点了「主食 / 肉蛋」还写「全部食物」会让人以为筛选没生效。
    var secTitle = favOnly ? '常吃 / 收藏'
      : (foodsFilter.cat === '全部' ? '全部食物' : foodsFilter.cat);
    html += '<div class="card-head"><h2>' + esc(secTitle) + '</h2><span class="hint">' + out.length + ' 条</span></div>';
    if (out.length) {
      // Group headers only make sense for the flat "全部" list.
      var lastCat = null;
      var rows = [];
      for (var k = 0; k < out.length; k++) {
        if (foodsFilter.cat === '全部' && !q && out[k].c !== lastCat) {
          lastCat = out[k].c;
          rows.push('<div class="cat-label">' + esc(lastCat) + '</div>');
        }
        rows.push(foodRow(out[k], false));
      }
      html += '<div class="list">' + rows.join('') + '</div>';
    } else {
      html += '<div class="card center muted">没有匹配的食物，换个关键词试试</div>';
    }
    return html;
  }
  function chip(label, on, cat) {
    return '<button class="chip' + (on ? ' on' : '') + '" data-act="cat" data-cat="' + esc(cat || label) + '">' + esc(label) + '</button>';
  }
  // 一条食物该怎么报数：有自然单位（个/袋/桶/份…）而且不是 100 克一份的，
  // 直接给「整份多少千卡」，省得用户对着「每 100g 491 kcal」自己乘 105 克。
  // 没有自然单位（鸡胸肉、米饭这种按克称的）还是按 100g 报。
  // 一条食物该怎么报数：食物库里的条目都带自然单位（个/碗/份/片/袋/桶…），
  // 直接给「整份多少千卡」，省得用户对着「每 100g 491 kcal」自己乘 105 克。
  // 只有「克」这种没有自然单位的（现在没有）才回落到每 100g。
  function servingOf(f) {
    if (f.ps) return { kcal: f.e, unit: '', grams: 0, perServing: true };
    var w = Number(f.w) || 100;
    if (!f.u || f.u === '克') return null;
    return { kcal: f.e * w / 100, unit: f.u, grams: w, perServing: false };
  }
  // 元信息只有一行的地方（食物库列表），别把「219g」也塞进去 ——
  // 多一个字就会折行，折在「脂 / 11.9」中间，比不写还难看。克数点开就有。
  function foodRow(f, mine) {
    var fav = state.favorites.indexOf(f.n) >= 0;
    var srv = servingOf(f);
    var nut = '碳' + f1(f.ch) + ' 蛋' + f1(f.p) + ' 脂' + f1(f.f);
    var meta, tail;
    if (srv && srv.perServing) {
      meta = esc(f.c) + ' · 整份 · ' + nut;
      tail = '<b>' + r0(srv.kcal) + '</b>kcal';
    } else if (srv) {
      meta = esc(f.c) + ' · 1' + esc(srv.unit) + ' · ' + nut;
      tail = '<b>' + r0(srv.kcal) + '</b>kcal<span class="per">/' + esc(srv.unit) + '</span>';
    } else {
      meta = esc(f.c) + ' · 每100g ' + nut;
      tail = '<b>' + r0(f.e) + '</b>kcal';
    }
    return '<div class="row" data-act="food-detail" data-name="' + esc(f.n) + '">' +
      '<div class="thumb">' + foodEmoji(f.n, f.c) + '</div>' +
      '<div class="body"><div class="title">' + (fav ? '<span class="star">★</span> ' : '') + esc(f.n) + (mine ? ' <span class="small muted">自定义</span>' : '') + '</div>' +
      '<div class="meta">' + meta + '</div></div>' +
      '<div class="tail">' + tail + '</div></div>';
  }

  /* -------- 好友 ------------------------------------------------------- */
  function viewSocial() {
    var sub = serverOn()
      ? (state.server.token ? state.friends.length + ' 位好友 · 已连接服务器' : '已配置服务器 · 还没登录')
      : state.friends.length + ' 位好友 · 本机示例数据';
    var html = topbar('好友', sub,
      '<button class="icon-btn" data-act="refresh-social">' + svg('refresh') + '</button>' +
      '<button class="icon-btn" data-act="add-friend">' + svg('plus') + '</button>');
    html += '<div class="screen has-topbar">';

    html += pendingRequests();

    html += '<div class="story">';
    html += '<div class="story-item" data-act="profile"><div class="avatar me" style="background:' + avatarColor('me') + '">我</div><div class="nm">我的主页</div></div>';
    for (var i = 0; i < state.friends.length; i++) {
      var f = state.friends[i];
      var unread = state.posts.filter(function (p) { return p.friendId === f.id && p.likes > 0 && p.date === today(); }).length;
      html += '<div class="story-item" data-act="open-friend" data-id="' + f.id + '">' +
        '<div class="avatar" style="background:' + avatarColor(f.id) + '">' + esc(f.letter) +
        (unread ? '<span class="badge">' + unread + '</span>' : '') + '</div>' +
        '<div class="nm">' + esc(f.name) + '</div></div>';
    }
    html += '<div class="story-item" data-act="add-friend"><div class="avatar plain" style="background:var(--surface-2);color:var(--text-3)">+</div><div class="nm">添加</div></div>';
    html += '</div>';

    html += '<div class="segmented">' +
      seg('feed', '动态') + seg('photos', '照片') + seg('friends', '好友') +
      '</div>';

    if (state.feedTab === 'friends') html += friendList();
    else if (state.feedTab === 'photos') html += photoWallHtml();
    else html += feedList();

    html += '</div>';
    return html;
  }
  /**
   * 好友页最上面的「待处理请求」。以前这块完全没有，所以别人加你，
   * 你这边是静音的。现在有请求就直接列出来，带接受/拒绝两个按钮。
   */
  function pendingRequests() {
    var inc = state.friendReqs.incoming || [];
    var out = state.friendReqs.outgoing || [];
    var html = '';
    if (inc.length) {
      html += '<div class="card req-card"><div class="card-head"><h2>好友请求</h2>' +
        '<span class="hint">' + inc.length + ' 条待处理</span></div>';
      html += inc.map(function (r) {
        return '<div class="req-row">' +
          '<div class="avatar" style="background:' + avatarColor(r.name) + ';width:36px;height:36px;font-size:14px;box-shadow:none">' +
          esc(r.letter) + '</div>' +
          '<div class="req-who"><div class="req-n">' + esc(r.name) + '</div>' +
          '<div class="small muted">' + (r.uid ? 'ID ' + esc(r.uid) : '想加你为好友') + '</div></div>' +
          '<div class="req-act">' +
          '<button class="btn small ghost" data-act="reject-friend" data-id="' + r.id + '">拒绝</button>' +
          '<button class="btn small" data-act="accept-friend" data-id="' + r.id + '">接受</button>' +
          '</div></div>';
      }).join('');
      html += '</div>';
    }
    if (out.length) {
      html += '<div class="card req-card"><div class="card-head"><h2>已发送的请求</h2>' +
        '<span class="hint">等对方同意</span></div>';
      html += out.map(function (r) {
        return '<div class="req-row">' +
          '<div class="avatar" style="background:' + avatarColor(r.name) + ';width:36px;height:36px;font-size:14px;box-shadow:none">' +
          esc(r.letter) + '</div>' +
          '<div class="req-who"><div class="req-n">' + esc(r.name) + '</div>' +
          '<div class="small muted">' + (r.uid ? 'ID ' + esc(r.uid) : '') + ' · 还没被接受</div></div>' +
          '<div class="req-act"><span class="hint">等待中</span></div>' +
          '</div>';
      }).join('');
      html += '</div>';
    }
    return html;
  }

  function seg(id, label) {
    return '<button class="' + (state.feedTab === id ? 'on' : '') + '" data-act="feed-tab" data-tab="' + id + '">' + label + '</button>';
  }

  function feedList() {
    var posts = state.posts.slice().sort(function (a, b) {
      return (a.date === b.date) ? a.seq - b.seq : (a.date < b.date ? 1 : -1);
    });
    if (!posts.length) return '<div class="card center muted">还没有好友动态</div>';
    return posts.map(function (p) { return feedCard(p); }).join('');
  }

  function feedCard(p) {
    var open = !!state.expanded[p.id];
    var mine = false;
    var html = '<div class="feed-card" id="post-' + p.id + '">';
    html += '<div class="feed-head">' +
      '<div class="avatar" style="background:' + avatarColor(p.friendId) + '">' + esc(p.letter) + '</div>' +
      '<div class="who"><div class="n">' + esc(p.name) + ' <span class="small muted">· ' + esc(p.goalText) + '</span></div>' +
      '<div class="t">' + prettyDate(p.date) + ' · 连续记录 ' + p.streak + ' 天</div></div>' +
      '<div class="sum"><b>' + p.total + '</b>kcal</div></div>';

    html += '<div class="feed-meals">';
    var posts = state.posts.filter(function (x) { return x.id === p.id; })[0];
    var rows = mealSummary(p);
    html += rows;
    html += '</div>';
    if (p.photos && p.photos.length) html += photoStrip(p.photos);

    html += '<div class="feed-actions">' +
      '<button class="' + (p.likedByMe ? 'on' : '') + '" data-act="like" data-id="' + p.id + '">' + svg('heart') + (p.likedByMe ? '已赞' : '点赞') + ' ' + p.likes + '</button>' +
      '<button class="' + (open ? 'on' : '') + '" data-act="toggle-comments" data-id="' + p.id + '">' + svg('comment') + '评论 ' + p.comments.length + '</button>' +
      rateButton(p) +
      '<button data-act="cheer" data-id="' + p.id + '">' + svg('check') + '催更</button>' +
      '</div>';

    if (open) {
      html += '<div class="comments">';
      if (!p.comments.length) html += '<div class="small muted mb8">还没有评论，来抢沙发～</div>';
      html += p.comments.map(function (c) {
        return '<div class="comment"><span class="cn">' + esc(c.who) + '</span><span class="ct">' + esc(c.text) +
          '<div class="cd">' + esc(c.ts) + '</div></span></div>';
      }).join('');
      html += '<div class="comment-input"><input id="cmt-' + p.id + '" placeholder="说点什么…" maxlength="80">' +
        '<button data-act="send-comment" data-id="' + p.id + '">发送</button></div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  /* 动态里的照片：最多铺 3 张，多的用「+N」收起来，点开看大图。
     不用 <a>，因为 WebView 里点链接会把页面顶走；统一走 data-act。 */
  function photoStrip(list) {
    var out = '<div class="feed-photos">';
    var show = Math.min(list.length, 3);
    for (var i = 0; i < show; i++) {
      var ph = list[i] || {};
      out += '<button class="feed-photo" data-act="open-photo" data-url="' + esc(ph.url || '') +
        '" data-cap="' + esc(ph.caption || '') + '">' +
        (ph.url ? '<img src="' + esc(ph.url) + '" alt="">' : '<span class="small muted">图片没存上</span>') +
        '</button>';
    }
    if (list.length > show) {
      var rest = list[show] || {};
      out += '<button class="feed-photo more" data-act="open-photo" data-url="' + esc(rest.url || '') +
        '" data-cap="' + esc(rest.caption || '') + '">+' + (list.length - show) + '</button>';
    }
    out += '</div>';
    return out;
  }

  function rateButton(p) {
    var r = p.rating || { avg: 0, count: 0, mine: 0 };
    var label;
    if (r.mine) label = r.mine + ' 星';
    else if (r.count) label = r.avg + ' 分';
    else label = '打分';
    return '<button class="' + (r.mine ? 'on' : '') + '" data-act="rate" data-id="' + p.id + '">' +
      svg('star') + label + (r.count > 1 ? '（' + r.count + '）' : '') + '</button>';
  }

  function openRateSheet(p) {
    var r = p.rating || { avg: 0, count: 0, mine: 0 };
    var body = '<div class="field"><label>给 ' + esc(p.name) + ' 这顿饭打分</label>' +
      '<div class="quick">';
    for (var s = 1; s <= 5; s++) {
      var on = r.mine >= s;
      body += '<button data-act="rate-set" data-id="' + p.id + '" data-s="' + s + '" class="' + (on ? 'on' : '') + '"' +
        (on ? ' style="background:var(--brand);color:var(--brand-ink);border-color:var(--brand)"' : '') +
        '>' + s + ' 星</button>';
    }
    body += '</div><div class="small muted mt8">' +
      (r.count ? '现在平均 ' + r.avg + ' 分（' + r.count + ' 人打过分）' : '还没有人打分') +
      '。打分只看照片和这三餐，不参与热量计算。</div></div>';
    if (r.mine) {
      body += '<div class="field"><button class="btn ghost" data-act="rate-set" data-id="' + p.id + '" data-s="0">取消我的打分</button></div>';
    }
    openSheet('打分', body, '<button class="btn ghost" data-act="cancel">关闭</button>');
  }

  function openPhotoView(url, caption) {
    if (!url) { toast('这张图没存下来'); return; }
    openSheet('照片', '<div class="photo-full"><img src="' + esc(url) + '" alt=""></div>' +
      (caption ? '<div class="small muted mt8">' + esc(caption) + '</div>' : ''),
      '<button class="btn ghost" data-act="cancel">关闭</button>');
  }

  function mealSummary(p) {
    // 来自服务器的动态：直接用后端发过来的条目，不猜。
    if (p.entries && p.entries.length) {
      var out0 = '';
      for (var mi = 0; mi < window.MEALS.length; mi++) {
        var meal0 = window.MEALS[mi];
        var items0 = p.entries.filter(function (e) { return e.meal === meal0.id; });
        if (!items0.length) continue;
        var kc0 = 0;
        var names0 = [];
        for (var ii = 0; ii < items0.length; ii++) { kc0 += items0[ii].kcal || 0; names0.push(items0[ii].name); }
        out0 += '<div class="feed-meal"><span class="mn">' + meal0.name + '</span>' +
          '<span class="items">' + esc(names0.join('、')) + '</span>' +
          '<span class="kc">' + r0(kc0) + '</span></div>';
      }
      return out0 || '<div class="feed-meal"><span class="mn">明细</span><span class="items muted">对方只同步了合计</span><span class="kc">' + r0(p.total) + '</span></div>';
    }
    /* 对方只同步了合计、没带明细时的兜底（不再有本机假动态配方） */
    return '<div class="feed-meal"><span class="mn">明细</span>' +
      '<span class="items muted">对方只同步了合计</span>' +
      '<span class="kc">' + r0(p.total) + '</span></div>';
  }

  function friendList() {
    var html = '<div class="list">';
    for (var i = 0; i < state.friends.length; i++) {
      var f = state.friends[i];
      html += '<div class="row" data-act="open-friend" data-id="' + f.id + '">' +
        '<div class="avatar" style="background:' + avatarColor(f.id) + ';width:36px;height:36px;font-size:14px;box-shadow:none">' + esc(f.letter) + '</div>' +
        '<div class="body"><div class="title">' + esc(f.name) + '</div>' +
        '<div class="meta">' + esc(f.goalText) + ' · 连续 ' + f.streak + ' 天</div></div>' +
        '<div class="tail">' + (f.online ? '<span style="color:var(--brand)">在线</span>' : '<span class="muted">离线</span>') + '</div></div>';
    }
    html += '</div>';
    html += '<div class="card mt12"><div class="card-head"><h2>邀请好友</h2></div>' +
      '<div class="small muted mb12">demo 版本使用本地模拟数据。正式版接入后端后，这里会生成邀请码 / 分享链接，好友通过后用手机号或二维码互相添加。</div>' +
      '<button class="btn" data-act="invite">生成邀请链接</button></div>';
    return html;
  }

  /* -------- 我的 ------------------------------------------------------- */
  function viewMe() {
    var g = state.goals;
    var html = topbar('我的', '第 ' + state.profile.streak + ' 天记录中',
      '<button class="icon-btn" data-act="settings">' + svg('gear') + '</button>');
    html += '<div class="screen has-topbar">';

    html += '<div class="card"><div class="row-between">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
      '<div class="avatar" style="background:' + avatarColor('me') + ';box-shadow:none">我</div>' +
      '<div><div style="font-size:16px;font-weight:700">' + esc(state.profile.name) + '</div>' +
      '<div class="small muted">' + esc(state.profile.goalText) + ' · 自定义食物 ' + state.custom.length + ' 种</div></div></div>' +
      '<button class="icon-btn" data-act="edit-profile">' + svg('edit') + '</button>' +
      '</div></div>';

    // 我的 ID：注册后由服务器分配的 6 位永久短号，加好友只认它
    var myUid = state.server.uid || '';
    html += '<div class="card" data-act="copy-uid" style="cursor:pointer">' +
      '<div class="row-between">' +
      '<div><div class="small muted">我的 ID' + (myUid ? ' · 加好友用这个' : '') + '</div>' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:2px;margin-top:2px">' +
      (myUid ? esc(myUid) : '<span class="muted" style="font-size:15px;letter-spacing:0">登录后自动分配</span>') +
      '</div></div>' +
      (myUid ? '<span class="hint">点一下复制</span>' : '') +
      '</div></div>';

    html += '<div class="card"><div class="card-head"><h2>每日目标</h2>' +
      '<button class="btn small ghost" data-act="edit-goals">修改</button></div>' +
      '<div class="stat-grid">' +
      stat('热量', g.kcal, 'kcal') + stat('蛋白', g.p, 'g') +
      stat('碳水', g.c, 'g') + stat('脂肪', g.f, 'g') +
      '</div>' +
      '<div class="small muted mt8">' + (state.goalsManual
        ? '当前是手动改的目标。想按身体档案重算，去下面「身体档案」保存一次。'
        : (state.bodyConfirmed
          ? '由下面的身体档案自动算出：米夫林-斯蒂尔杰尔 × 活动系数 × 目标调整。'
          : '现在是默认值。填一次下面的「身体档案」，之后会按你的身高体重自动算。')) +
      '</div></div>';

    // 身体档案：身高体重和目标是算每日热量的输入
    var b = state.body, act = activityById(b.activity), gt = goalTypeById(b.goal);
    var pctText = gt.pct === 0 ? '不增不减' : ((gt.pct > 0 ? '+' : '') + Math.round(gt.pct * 100) + '%');
    html += '<div class="card"><div class="card-head"><h2>身体档案</h2>' +
      '<button class="btn small ghost" data-act="edit-body">修改</button></div>' +
      '<div class="brow"><span>性别 / 年龄</span><b>' + (b.sex === 'm' ? '男' : '女') + ' · ' + b.age + ' 岁</b></div>' +
      '<div class="brow"><span>身高 / 体重</span><b>' + b.height + ' cm · ' + b.weight + ' kg</b></div>' +
      '<div class="brow"><span>活动水平</span><b>' + act.name + '</b></div>' +
      '<div class="brow"><span>目标</span><b>' + gt.name + '（' + pctText + '）</b></div>' +
      '<div class="brow"><span>基础代谢 / 每日消耗</span><b>' + Math.round(bmr()) + ' / ' + Math.round(tdee()) + ' kcal</b></div>' +
      '<div class="small muted mt8">目标热量 <b>' + goalKcal() + '</b> kcal。蛋白按 ' +
      goalTypeById(b.goal).pro + ' g/kg 体重、脂肪 0.9 g/kg，剩下的给碳水。</div></div>';

    // 体重：记录 + 折线
    var delta = state.weights.length >= 2
      ? (state.weights[state.weights.length - 1].kg - state.weights[0].kg) : null;
    html += '<div class="card"><div class="card-head"><h2>体重</h2>' +
      '<button class="btn small ghost" data-act="log-weight">记录</button></div>' +
      '<div class="row-between" style="align-items:baseline">' +
      '<div style="font-size:23px;font-weight:800;letter-spacing:-.4px">' + (b.weight || '—') +
      '<span class="small muted" style="font-weight:600"> kg</span></div>' +
      '<div class="small ' + (delta === null ? 'muted' : (delta < 0 ? 'down' : (delta > 0 ? 'up' : 'muted'))) + '">' +
      (delta === null ? '还没有变化可看'
        : (delta > 0 ? '+' : '') + delta.toFixed(1) + ' kg（' + state.weights.length + ' 次记录）') +
      '</div></div>' + weightCurve() + '</div>';

    // 账号：换手机、换服务器、换人都要从这里出去。以前只有「设置 → 社交服务器
    // → 退出登录」这一条路，藏三层，换账号等于玩寻宝。
    html += '<div class="card"><div class="card-head"><h2>账号</h2></div>';
    if (serverOn()) {
      html += '<div class="brow"><span>当前账号</span><b>' +
        esc(state.server.displayName || state.server.uid || '已登录') + '</b></div>' +
        '<div class="brow"><span>数据存在</span><b>' +
        esc(state.server.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) + '</b></div>' +
        '<div class="row-between" style="margin-top:10px;gap:8px">' +
        '<button class="btn small ghost" data-act="switch-account">切换账号</button>' +
        '<button class="btn small danger" data-act="logout-account">退出登录</button>' +
        '</div>';
    } else {
      html += '<div class="small muted">还没登录。登录后记录会同步到服务器，换手机能找回来。</div>' +
        '<button class="btn small" data-act="server" style="margin-top:10px">登录 / 注册</button>';
    }
    html += '</div>';

    // 主题色、深色模式、服务器、导出、更新、关于这些低频项全部收进右上角「设置」，
    // 主页面只留「我是谁 / 目标多少 / 身体什么情况」这三件事。
    html += '<div class="center small muted" style="padding:6px 0 4px">' + APP_NAME + ' v' + APP_VERSION +
      ' · 记录、身体档案、自定义食物都存在服务器</div>';
    html += '</div>';
    return html;
  }

  /** 设置：把原来摊在「我的」页上的低频功能都收进来 */
  function openSettings() {
    var curTheme = '默认';
    for (var i = 0; i < window.ACCENTS.length; i++) {
      if (window.ACCENTS[i].id === state.theme) curTheme = window.ACCENTS[i].name;
    }
    var body = '';

    body += '<div class="card-head"><h2>账号与数据</h2></div>';
    body += '<div class="list mb12">' +
      '<div class="row" data-act="server"><div class="thumb" style="background:' +
      (serverOn() ? 'var(--brand-soft)' : 'var(--surface-2)') + '">' + (serverOn() ? '🟢' : '⚪') + '</div>' +
      '<div class="body"><div class="title">社交服务器</div><div class="meta">' +
      (serverOn() ? esc(state.server.baseUrl.replace(/^https?:\/\//, '')) + ' · 已连接'
        : '还没有连接服务器') + '</div></div><span class="chev">›</span></div>' +
      rowItem('star', '我的收藏', state.favorites.length + ' 种常吃食物', 'fav') +
      rowItem('cloud', '导出数据', '复制全部记录为 JSON', 'export') +
      '</div>';

    body += '<div class="card-head"><h2>外观</h2></div>';
    body += '<div class="list mb12">' +
      rowItem('palette', '主题色', curTheme + ' · ' + window.ACCENTS.length + ' 套方案', 'open-theme') +
      '</div>';
    body += '<div class="list mb12">' +
      themeRow('dark', '深色模式', state.mode === 'dark') +
      themeRow('goal', '记录多餐（练前/练后/夜宵）', true) +
      '</div>';

    body += '<div class="card-head"><h2>关于与更新</h2></div>';
    body += '<div class="list mb12">' +
      rowItem('logout', '检查更新', '当前 v' + appVersionName() + '（' + appVersionCode() + '）', 'update-check') +
      rowItem('about', '关于' + APP_NAME, '版本 v' + appVersionName() + ' · 应用图标与命名说明', 'about') +
      rowItem('bell', '提醒设置', '三餐定时提醒（demo 未启用）') +
      '</div>';

    // 网页版（PWA）：没有安装器，改成告诉他怎么把它变成主屏图标
    if (isWebApp()) {
      body += '<div class="card mt12"><div class="card-head"><h2>装到手机上</h2></div>' +
        '<div class="small muted" style="line-height:1.7">' +
        (isIOS()
          ? 'iPhone / iPad：点底部的「分享」→ 往下找「添加到主屏幕」→ 添加。<br>之后就像 App 一样有图标、全屏打开，数据仍然跟着账号走。'
          : '安卓 / 桌面浏览器：菜单里找「安装应用」或「添加到主屏幕」。<br>想要相册、通知这类系统能力，还是装安卓安装包更完整。') +
        '</div>' +
        '<button class="btn ghost mt12" data-act="open-apk">下载安卓安装包</button></div>';
    }

    body += '<div class="list mb12">' +
      '<div class="row" data-act="reset"><div class="thumb">🧹</div><div class="body">' +
      '<div class="title" style="color:#B42318">清空并重新开始</div>' +
      '<div class="meta">清记录和登录状态，自定义食物保留</div></div><span class="chev">›</span></div>' +
      '</div>';

    openSheet('设置', body);
  }

  /** 主题色选择（从设置里进） */
  function openThemeSheet() {
    var body = '<div class="theme-grid">';
    for (var i = 0; i < window.ACCENTS.length; i++) {
      var a = window.ACCENTS[i];
      var on = state.theme === a.id;
      body += '<div class="theme-card' + (on ? ' on' : '') + '" data-act="set-theme" data-id="' + a.id + '">' +
        '<div class="swatches">' +
        '<span class="swatch" style="background:' + a.light.brand + '"></span>' +
        '<span class="swatch" style="background:' + a.dark.brand + '"></span>' +
        '<span class="swatch" style="background:' + a.light.soft + '"></span>' +
        '</div><div class="nm">' + esc(a.name) + '</div></div>';
    }
    body += '</div>';
    openSheet('主题色', body,
      '<button class="btn" data-act="close-sheet">好了</button>');
  }
  function themeRow(id, label, on) {
    return '<div class="row" data-act="toggle" data-key="' + id + '"><div class="body"><div class="title">' + label + '</div></div>' +
      '<label class="switch"><input type="checkbox" ' + (on ? 'checked' : '') + ' data-act="toggle" data-key="' + id + '"><span class="slider"></span></label></div>';
  }
  function rowItem(icon, title, meta, act) {
    return '<div class="row" data-act="' + (act || 'noop') + '"><div class="thumb">' + svg(icon) + '</div>' +
      '<div class="body"><div class="title">' + title + '</div><div class="meta">' + meta + '</div></div><span class="chev">›</span></div>';
  }

  var TABS = [
    ['today', 'home', '今日'],
    ['trend', 'chart', '总览'],
    ['foods', 'bowl', '食物库'],
    ['social', 'users', '好友'],
    ['me', 'user', '我的']
  ];

  function renderTabbar() {
    var tabs = TABS;
    var pending = (state.friendReqs.incoming || []).length;
    $('#tabbar').innerHTML = tabs.map(function (t) {
      return '<button class="' + (state.view === t[0] ? 'on' : '') + '" data-act="tab" data-tab="' + t[0] + '">' +
        svg(t[1]) + '<span>' + t[2] + '</span>' +
        (t[0] === 'social' && pending ? '<i class="tab-dot"></i>' : '') + '</button>';
    }).join('');
  }

  /* --------------------------------------------------------- food picker */
  var picker = { meal: 'lunch', draft: null };

  function openAddFood(meal, editEntry) {
    picker.meal = meal || 'lunch';
    if (editEntry) {
      picker.draft = JSON.parse(JSON.stringify(editEntry));
      openPortionSheet(true);
    } else {
      openPickerSheet();
    }
  }

  function openPickerSheet() {
    var favs = state.favorites.length ? state.favorites : [];
    var body = '';
    if (favs.length) {
      body += '<div class="field"><label>常吃 / 收藏</label><div class="quick">' +
        favs.map(function (n) { return '<button data-act="pick" data-name="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') +
        '</div></div>';
    }
    if (state.recent.length) {
      body += '<div class="field"><label>最近记录</label><div class="quick">' +
        state.recent.slice(0, 8).map(function (n) { return '<button data-act="pick" data-name="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') +
        '</div></div>';
    }
    body += '<div class="search" style="box-shadow:none;background:var(--surface-2)">' + svg('search') +
      '<input id="pick-search" placeholder="搜索食物名称" autocomplete="off"></div>';
    body += '<div class="chips">' + chip('全部', true, '全部') +
      window.CATEGORIES.map(function (c) { return chip(c.emoji + ' ' + c.id, false, c.id); }).join('') + '</div>';
    body += '<div class="list" id="pick-list">' + pickListHtml('', '全部') + '</div>';

    var foot = '<button class="btn ghost" data-act="recognize">📷 拍照识别</button>' +
      '<button class="btn ghost" data-act="new-food">' + '＋ 新建自定义食物</button>';
    var sheet = openSheet('选择食物 · 加入' + mealName(picker.meal), body, foot);

    var input = $('#pick-search', sheet);
    input.addEventListener('input', function () {
      var q = this.value;
      $('#pick-list', sheet).innerHTML = pickListHtml(q, foodsFilter.pickCat || '全部');
    });
    input.addEventListener('focus', function () { this.scrollIntoView({ block: 'center' }); });
  }

  function pickListHtml(q, cat) {
    var list = foodList().filter(function (f) {
      if (cat && cat !== '全部' && f.c !== cat) return false;
      if (q && f.n.indexOf(q) < 0) return false;
      return true;
    });
    list.sort(function (a, b) {
      var fa = state.favorites.indexOf(a.n) >= 0 ? 0 : 1;
      var fb = state.favorites.indexOf(b.n) >= 0 ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return a.n.length - b.n.length;
    });
    if (!list.length) return '<div class="row"><div class="body muted">没有找到，试试「新建自定义食物」</div></div>';
    return list.slice(0, 200).map(function (f) {
      var srv = servingOf(f);
      var kcalTxt = srv ? r0(srv.kcal) + ' kcal' + (srv.unit ? '/' + esc(srv.unit) : '') : '每100g ' + r0(f.e) + 'kcal';
      return '<div class="row" data-act="pick" data-name="' + esc(f.n) + '">' +
        '<div class="thumb">' + foodEmoji(f.n, f.c) + '</div>' +
        '<div class="body"><div class="title">' + esc(f.n) + '</div>' +
        '<div class="meta">' + esc(f.c) + ' · ' + kcalTxt + '</div></div>' +
        '<div class="tail">' + svg('plus') + '</div></div>';
    }).join('');
  }

  function mealName(id) {
    for (var i = 0; i < window.MEALS.length; i++) if (window.MEALS[i].id === id) return window.MEALS[i].name;
    return '餐次';
  }

  /* -------------------------------------------------------- portion sheet */
  function openPortionSheet(isEdit) {
    var d = picker.draft;
    var food0 = allFoods()[d.name];
    // 「按份记」的自定义食物：整份就是 1 份，没有「每 100 克」这回事，
    // 所以把折算重量换掉，免得让人以为自己得称克数。
    var byServing = !!(food0 && food0.ps);
    var food = { n: d.name, c: d.cat, e: d.per100.e, p: d.per100.p, f: d.per100.f, ch: d.per100.ch, u: d.unit, w: d.grams / (d.qty || 1) };
    // 单位从 SERVINGS 来，别再手写一份 —— 手写那份漏了 桶/袋/对/笼/罐/包/条，
    // 选「桶装面」时一个高亮都没有。
    var units = ['克'].concat(Object.keys(window.SERVINGS).filter(function (u) { return u !== '克'; }));
    var body =
      '<div class="preview">' +
      '<div class="cell"><div class="v" id="pv-kcal">0</div><div class="k">热量 kcal</div></div>' +
      '<div class="cell"><div class="v" id="pv-p" style="color:var(--c-pro)">0</div><div class="k">蛋白 g</div></div>' +
      '<div class="cell"><div class="v" id="pv-ch" style="color:#B08900">0</div><div class="k">碳水 g</div></div>' +
      '<div class="cell"><div class="v" id="pv-f" style="color:var(--c-fat)">0</div><div class="k">脂肪 g</div></div>' +
      '</div>' +
      '<div class="field"><label>数量</label><div class="stepper">' +
      '<button data-act="qty" data-d="-1">−</button>' +
      '<input class="input" id="in-qty" type="number" inputmode="decimal" step="0.5" value="' + d.qty + '">' +
      '<button data-act="qty" data-d="1">＋</button>' +
      '</div><div class="quick">' +
      [0.5, 1, 1.5, 2, 3].map(function (n) { return '<button data-act="qset" data-v="' + n + '">' + n + '</button>'; }).join('') +
      '</div></div>' +
      '<div class="field"><label>单位</label><div class="quick">' +
      units.map(function (u) { return '<button data-act="unit" data-u="' + u + '" class="' + (d.unit === u ? 'chip on' : '') + '" style="' + (d.unit === u ? 'background:var(--brand);color:var(--brand-ink);border-color:var(--brand)' : '') + '">' + u + '</button>'; }).join('') +
      '</div></div>' +
      (byServing
        ? '<div class="field"><div class="small muted">按份记的食物：1 ' + esc(d.unit) + ' = 整份。' +
          '数量填 0.5 就是半份，不用称克数。</div>' +
          '<div class="small muted mt8">整份：' + r0(d.per100.e) + ' kcal · 碳 ' + f1(d.per100.ch) + ' · 蛋 ' + f1(d.per100.p) + ' · 脂 ' + f1(d.per100.f) + '</div></div>'
        : '<div class="field"><label>折算重量（克）</label>' +
          '<input class="input" id="in-grams" type="number" inputmode="decimal" value="' + Math.round(d.grams) + '">' +
          '<div class="small muted mt8">每 100g：' + r0(d.per100.e) + ' kcal · 碳 ' + f1(d.per100.ch) + ' · 蛋 ' + f1(d.per100.p) + ' · 脂 ' + f1(d.per100.f) + '</div></div>') +
      (d.recog
        ? '<div class="field"><div class="small muted">' +
          (d.recog === 'db'
            ? '✓ 这项是按菜名在食物库里对上的，营养值来自成分表。'
            : '⚠️ 食物库里没有这道菜，数值是模型估的，误差可能不小。') +
          '</div></div>'
        : '') +
      '<div class="field"><label>吃了多少</label><div class="quick">' +
      [[1, '全部'], [0.5, '一半'], [1 / 3, '三分之一'], [0.25, '四分之一']].map(function (p) {
        var on = Math.abs(eatenOf(picker.draft) - p[0]) < 0.02;
        return '<button data-act="eat" data-v="' + p[0] + '" class="' + (on ? 'on' : '') + '" style="' +
          (on ? 'background:var(--brand);color:var(--brand-ink);border-color:var(--brand)' : '') + '">' + p[1] + '</button>';
      }).join('') +
      '</div><div class="small muted mt8" id="eat-hint"></div></div>' +
      '<div class="field"><label>花了多少钱（元，可不填）</label>' +
      '<input class="input" id="in-price" type="number" inputmode="decimal" step="0.5" placeholder="比如 18" value="' +
      (Number(d.price) > 0 ? Number(d.price) : '') + '">' +
      '<div class="small muted mt8">填了才能统计「今天/这月吃了多少钱」。自己做的饭留空就行。</div></div>' +
      '<div class="field"><label>备注（可不填）</label>' +
      '<input class="input" id="in-note" type="text" maxlength="120" placeholder="在哪买的、和谁吃、味道怎么样…" value="' +
      esc(d.note || '') + '"></div>' +
      '<div class="field"><label>餐次</label><div class="quick">' +
      window.MEALS.map(function (m) { return '<button data-act="meal" data-m="' + m.id + '" style="' + (d.meal === m.id ? 'background:var(--brand);color:var(--brand-ink);border-color:var(--brand)' : '') + '">' + m.emoji + m.name + '</button>'; }).join('') +
      '</div></div>';

    var foot = (isEdit
      ? '<button class="btn danger" data-act="delete-entry">删除</button>'
      : '') +
      '<button class="btn" data-act="confirm-entry">' + (isEdit ? '保存修改' : '加入记录') + '</button>';

    var sheet = openSheet(isEdit ? '编辑记录' : '填写份量', body, foot);

    function syncFromQtyUnit() {
      var qty = parseFloat($('#in-qty', sheet).value) || 0;
      var unit = picker.draft.unit;
      var per = (unit === '克') ? 1 : gramsPerUnit(picker.draft.name, unit);
      picker.draft.qty = qty;
      picker.draft.grams = Math.max(0, qty * per);
      var gi = $('#in-grams', sheet);
      if (gi) gi.value = Math.round(picker.draft.grams);
      preview();
    }
    function preview() {
      var eat = eatenOf(picker.draft);
      var k = (picker.draft.grams * eat) / 100;
      $('#pv-kcal', sheet).textContent = r0(picker.draft.per100.e * k);
      $('#pv-p', sheet).textContent = f1(picker.draft.per100.p * k);
      $('#pv-ch', sheet).textContent = f1(picker.draft.per100.ch * k);
      $('#pv-f', sheet).textContent = f1(picker.draft.per100.f * k);
      var hint = $('#eat-hint', sheet);
      if (hint) {
        hint.textContent = eat >= 1
          ? '整份都吃了。剩下了就选一半或更少，热量会跟着打折。'
          : '这份 ' + Math.round(picker.draft.grams) + ' g，吃了 ' + eatLabel(eat) +
            '（约 ' + Math.round(picker.draft.grams * eat) + ' g），上面的热量已经按吃了的量算。';
      }
    }
    preview();

    bindSheet('input', function (ev) {
      var t = ev.target;
      if (t.id === 'in-qty') syncFromQtyUnit();
      else if (t.id === 'in-grams') {
        picker.draft.grams = Math.max(0, parseFloat(t.value) || 0);
        var per = (picker.draft.unit === '克') ? 1 : gramsPerUnit(picker.draft.name, picker.draft.unit);
        picker.draft.qty = Math.round((picker.draft.grams / per) * 100) / 100;
        $('#in-qty', sheet).value = picker.draft.qty;
        preview();
      }
    });
    bindSheet('click', function (ev) {
      var t = ev.target.closest('[data-act]');
      if (!t) return;
      var act = t.getAttribute('data-act');
      if (act === 'qty') {
        var d2 = parseFloat(t.getAttribute('data-d'));
        $('#in-qty', sheet).value = Math.max(0, (parseFloat($('#in-qty', sheet).value) || 0) + d2);
        syncFromQtyUnit();
      } else if (act === 'qset') {
        $('#in-qty', sheet).value = t.getAttribute('data-v');
        syncFromQtyUnit();
      } else if (act === 'unit') {
        picker.draft.unit = t.getAttribute('data-u');
        $$('[data-act="unit"]', sheet).forEach(function (b) {
          var on = b.getAttribute('data-u') === picker.draft.unit;
          b.style.background = on ? 'var(--brand)' : '';
          b.style.color = on ? 'var(--brand-ink)' : '';
          b.style.borderColor = on ? 'var(--brand)' : '';
        });
        syncFromQtyUnit();
      } else if (act === 'eat') {
        picker.draft.eat = parseFloat(t.getAttribute('data-v')) || 1;
        $$('[data-act="eat"]', sheet).forEach(function (b) {
          var on = Math.abs((parseFloat(b.getAttribute('data-v')) || 1) - eatenOf(picker.draft)) < 0.02;
          b.style.background = on ? 'var(--brand)' : '';
          b.style.color = on ? 'var(--brand-ink)' : '';
          b.style.borderColor = on ? 'var(--brand)' : '';
        });
        preview();
      } else if (act === 'meal') {
        picker.draft.meal = t.getAttribute('data-m');
        $$('[data-act="meal"]', sheet).forEach(function (b) {
          var on = b.getAttribute('data-m') === picker.draft.meal;
          b.style.background = on ? 'var(--brand)' : '';
          b.style.color = on ? 'var(--brand-ink)' : '';
          b.style.borderColor = on ? 'var(--brand)' : '';
        });
      }
    });
  }

  function beginEntry(foodName) {
    var f = allFoods()[foodName];
    if (!f) { toast('找不到该食物'); return; }
    var unit = f.u || '克';
    var grams = unit === '克' ? 100 : f.w;
    picker.draft = {
      id: uid(), date: state.date, meal: picker.meal, foodId: f.n, name: f.n, cat: f.c,
      unit: unit, qty: 1, grams: grams,
      per100: { e: f.e, p: f.p, f: f.f, ch: f.ch },
      kcal: 0, p: 0, f: 0, ch: 0, ts: Date.now(),
      eat: 1, price: 0, note: ''
    };
    recalc(picker.draft);
    openPortionSheet(false);
  }

  function confirmEntry() {
    var d = picker.draft;
    if (!d || !(d.grams > 0)) { toast('请输入有效的重量'); return; }
    /* 价格和备注只在点确认时读一次：在面板里打字不该触发重算热量。 */
    var priceEl = $('#in-price');
    var noteEl = $('#in-note');
    if (priceEl) {
      var pv = parseFloat(priceEl.value);
      d.price = (isFinite(pv) && pv > 0) ? Math.round(pv * 100) / 100 : 0;
    }
    if (noteEl) d.note = String(noteEl.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    d.eat = eatenOf(d);
    recalc(d);
    var idx = -1;
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === d.id) idx = i;
    if (idx >= 0) {
      d.date = state.entries[idx].date;
      state.entries[idx] = d;
      toast('已保存修改');
    } else {
      state.entries.push(d);
      var nm = d.name;
      state.recent = [nm].concat(state.recent.filter(function (x) { return x !== nm; })).slice(0, 20);
      toast('已加入' + mealName(d.meal));
    }
    markDiaryDirty(d.date);
    save();
    closeSheet();
    render();
  }

  function deleteEntry(id) {
    var gone = null;
    for (var i = 0; i < state.entries.length; i++) if (state.entries[i].id === id) gone = state.entries[i];
    if (gone) markDiaryDirty(gone.date);
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    save();
    closeSheet();
    render();
    toast('已删除');
  }

  /* ---------------------------------------------------- 拍照识别（AI） */
  /* 流程：拍照 → 本地压到长边 896px → POST /api/recognize（图片只发给自己的
   * 服务器，Key 在服务器上）→ 服务端回「这是什么 + 大概多少克 + 每 100g 营养」
   * → 这里再按菜名回本地 238 种食物库找精确值。
   *
   * 为什么不让模型直接给热量：它给的是「估计」，同一道番茄炒蛋能报出 90 和
   * 160 kcal/100g 两个数，误差 ±30% 很常见。食物库里的数是抄成分表的。所以
   * 能对上就用库里的，对不上才退回模型的数，并且明确标「AI 估算」。
   */
  var RECOG_EDGE = 896;        // 长边上限。再大只是多花 token，认菜没变准
  var RECOG_QUALITY = 0.72;    // JPEG 质量：896px@0.72 大约 100–200 KB
  /* 图打不开时统一说这一句。iPhone 的 HEIC、微信存的 .dat、被截断的文件都会走到这里：
   * 浏览器自己都解不出来，服务端也只会按魔数拒掉，先说清楚才不会让人以为「网络不好」。 */
  var BAD_IMAGE_TEXT = '这张图打不开，可能不是 JPG/PNG（iPhone 的 HEIC 就属于这种），' +
    '或者文件已经损坏。在相册里点「导出为 JPG」再试，或者直接换一张。';
  var recogOut = null;         // 最近一次识别结果 { items, note, model }
  var recogBusy = false;
  var recogPending = null;     // 图糊/太暗时先攒着，等用户点「就这样识别」

  /* 断了网的那张图先存起来，用户不用重新翻相册重拍。
   * 只放一张（新的盖掉旧的），data URL 一百多 KB，localStorage 放得下。 */
  var RECOG_STORE = 'shike_recog_pending';

  function loadPendingPhoto() {
    try { return window.localStorage.getItem(RECOG_STORE) || ''; } catch (e) { return ''; }
  }
  function savePendingPhoto(url) {
    try {
      if (url) window.localStorage.setItem(RECOG_STORE, url);
      else window.localStorage.removeItem(RECOG_STORE);
    } catch (e) { /* 隐私模式写不进去，不影响主流程 */ }
  }
  /* 幂等键：服务端认它，同一张图重发不会扣两次次数。 */
  function newClientId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* 模型说的是人话（「白米饭」「西红柿炒鸡蛋」「听装可乐」），食物库里是规范名。
   * 不先映射的话这些最常见的菜一律进「AI 估算」，白白丢掉精确值。
   * 键必须已经过 normName（无括号、无空格）；值对不上就自然退化成模糊匹配。 */
  var FOOD_ALIASES = {
    '白米饭': '米饭（熟）', '米饭': '米饭（熟）', '大米饭': '米饭（熟）', '白饭': '米饭（熟）', '蒸米饭': '米饭（熟）',
    '肉包': '包子（肉馅）', '包子': '包子（肉馅）', '水饺': '饺子（猪肉白菜）', '饺子': '饺子（猪肉白菜）',
    '面条': '面条（熟）', '煮面': '面条（熟）', '汤面': '面条（熟）', '挂面': '挂面（干）',
    '米粉': '米粉（干）', '白粥': '米粥', '大米粥': '米粥', '稀饭': '米粥', '小米': '小米粥',
    '燕麦': '燕麦片（干）', '麦片': '燕麦片（干）', '燕麦片': '燕麦片（干）',
    '面包': '全麦面包', '吐司': '全麦面包', '全麦吐司': '全麦面包', '烤面包': '全麦面包',
    '玉米': '玉米（鲜）', '甜玉米': '玉米（鲜）', '水煮玉米': '玉米（鲜）',
    '地瓜': '红薯', '烤红薯': '红薯', '马铃薯': '土豆', '土豆块': '土豆',
    '意面': '意大利面（熟）', '意大利面': '意大利面（熟）', '藜麦': '藜麦（熟）', '煎饼果子': '煎饼',

    '鸡胸': '鸡胸肉', '鸡脯肉': '鸡胸肉', '鸡腿': '鸡腿肉', '烤鸡腿': '鸡腿肉',
    '鸡翅': '鸡翅', '烤翅': '鸡翅', '可乐鸡翅': '鸡翅', '鸡爪': '鸡爪', '凤爪': '鸡爪',
    '蛋': '鸡蛋', '煮蛋': '鸡蛋', '水煮蛋': '鸡蛋', '白煮蛋': '鸡蛋', '煎蛋': '鸡蛋',
    '荷包蛋': '鸡蛋', '炒蛋': '鸡蛋', '蒸蛋': '鸡蛋', '鸡蛋羹': '鸡蛋',
    '蛋白': '鸡蛋白', '蛋清': '鸡蛋白', '蛋黄': '鸡蛋黄',
    '松花蛋': '皮蛋', '猪肉': '猪肉（瘦）', '瘦肉': '猪肉（瘦）', '炒猪肉': '猪肉（瘦）',
    '五花肉': '猪肉（五花肉）', '排骨': '猪排骨', '糖醋排骨': '猪排骨', '炖排骨': '猪排骨',
    '牛肉': '牛肉（瘦）', '炒牛肉': '牛肉（瘦）', '牛排': '牛肉（瘦）',
    '羊肉': '羊肉（瘦）', '烤羊肉': '羊肉（瘦）', '火腿': '火腿肠', '香肠': '香肠（腊肠）', '腊肠': '香肠（腊肠）',

    '清蒸鱼': '鲈鱼', '蒸鱼': '鲈鱼', '清蒸鲈鱼': '鲈鱼', '烤鱼': '草鱼',
    '虾': '基围虾', '大虾': '基围虾', '白灼虾': '基围虾', '水煮虾': '基围虾',
    '蟹': '螃蟹', '生蚝': '牡蛎', '扇贝肉': '扇贝', '鱿鱼须': '鱿鱼',

    '白菜': '白菜', '大白菜': '大白菜', '炒白菜': '大白菜', '青菜': '油菜', '小青菜': '油菜',
    '西蓝花': '西兰花', '炒西兰花': '西兰花', '花菜': '菜花', '拍黄瓜': '黄瓜',
    '西红柿': '番茄', '番茄块': '番茄', '红烧茄子': '茄子', '青椒丝': '青椒',
    '洋葱丝': '洋葱', '四季豆': '豆角', '蘑菇': '香菇（鲜）', '香菇': '香菇（鲜）',
    '小番茄': '圣女果', '圣女果': '圣女果', '鲜枣': '枣（鲜）',

    '牛奶': '牛奶（全脂）', '纯牛奶': '牛奶（全脂）', '全脂牛奶': '牛奶（全脂）',
    '脱脂牛奶': '牛奶（脱脂）', '酸奶': '酸奶（原味）', '原味酸奶': '酸奶（原味）',
    '芝士': '奶酪（切达）', '奶酪': '奶酪（切达）', '奶粉': '奶粉（全脂）',

    '豆腐': '豆腐（南豆腐）', '嫩豆腐': '豆腐（南豆腐）', '南豆腐': '豆腐（南豆腐）',
    '豆干': '豆腐干', '豆腐干': '豆腐干', '豆浆': '豆浆（无糖）',
    '花生': '花生（炒）', '炒花生': '花生（炒）', '核桃': '核桃仁', '瓜子': '瓜子（葵花籽）',
    '葵花籽': '瓜子（葵花籽）',

    '可口可乐': '可乐', '百事可乐': '可乐', '一听可乐': '可乐（听装 330 ml）',
    '罐装可乐': '可乐（听装 330 ml）', '零度可乐': '无糖可乐（零度，听装 330 ml）',
    '无糖可乐': '无糖可乐（零度，听装 330 ml）', '橙汁': '橙汁（鲜榨）',
    '美式': '咖啡（美式）', '美式咖啡': '咖啡（美式）', '黑咖啡': '咖啡（美式）',
    '咖啡': '咖啡（美式）', '拿铁': '拿铁咖啡', '咖啡拿铁': '拿铁咖啡',
    '奶茶': '奶茶（珍珠）', '珍珠奶茶': '奶茶（珍珠）', '波霸奶茶': '奶茶（珍珠）',
    '功能饮料': '运动饮料',

    '饼干': '饼干（消化饼）', '曲奇': '曲奇饼干', '巧克力': '巧克力（牛奶）',
    '雪糕': '冰淇淋', '蛋糕': '蛋糕（奶油）',

    '汉堡': '汉堡包', '巨无霸': '巨无霸（麦当劳）', '炸鸡腿': '炸鸡（带皮）',
    '炸鸡块': '炸鸡（带皮）', '炸鸡': '炸鸡（带皮）', '比萨': '披萨', '泡面': '方便面',
    '蛋挞': '葡式蛋挞（肯德基）', '薯条': '薯条',

    '西红柿炒蛋': '番茄炒蛋', '西红柿炒鸡蛋': '番茄炒蛋', '番茄炒鸡蛋': '番茄炒蛋',
    '土豆丝': '酸辣土豆丝', '炒土豆丝': '酸辣土豆丝', '炒青菜': '清炒时蔬',
    '宫爆鸡丁': '宫保鸡丁', '炒饭': '蛋炒饭'
  };

  // 「米饭（熟）」→「米饭」：括号里通常是做法/规格，比对时两边都去一次
  function bareName(s) { return String(s || '').replace(/[（(].*$/, ''); }

  function normName(s) {
    return String(s || '')
      .replace(/[（()）【】\[\]·・,，。、\s]/g, '')
      .replace(/^(一份|一碗|一盘|一个|一只|一杯|一盒|约|大概|适量)/, '');
  }

  // 「清蒸鲈鱼」剥成「鲈鱼」再比。做法前缀是最常见的一层壳，不剥的话
  // 模型说「清蒸鲈鱼」就永远对不上库里的「鲈鱼」。
  var RECOG_METHODS = /^(清蒸|清炒|清炖|水煮|红烧|凉拌|爆炒|干煸|干锅|香煎|油炸|糖醋|蒜蓉|麻辣|白灼|小炒|铁板|炭烤|烧烤|炝|汆|蒸|煮|炒|炸|煎|炖|焖|拌|烤|烧|卤)/;

  function stripMethod(s) {
    var out = s, t;
    for (var i = 0; i < 3; i++) {
      t = out.replace(RECOG_METHODS, '');
      if (t === out || t.length < 2) break;
      out = t;
    }
    return out;
  }

  // 刀工后缀：「番茄丁」「牛肉片」「红薯条」——模型爱这么写，库里是「番茄」。
  // 只剥形态词（丁丝块片末粒泥段条碎），不剥「酱汁干粉汤水油」这类会改变
  // 食物本身的字：番茄酱不能当成番茄，橙汁也不能当成橙子。
  var RECOG_MORPH = /(丁|丝|块|片|末|粒|泥|段|条|碎)$/;

  function stripMorph(s) {
    var t = String(s || '').replace(RECOG_MORPH, '');
    return t.length >= 2 ? t : s;
  }

  // 两个字以上、至少命中一半才算像。宁可返回 null 走 AI 估算，
  // 也不要把「清炒芥蓝」硬塞给「清炒时蔬」——那比没有更误导人。
  function overlapScore(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    var pool = {}, i;
    for (i = 0; i < b.length; i++) pool[b.charAt(i)] = (pool[b.charAt(i)] || 0) + 1;
    var hit = 0;
    for (i = 0; i < a.length; i++) {
      var ch = a.charAt(i);
      if (pool[ch]) { pool[ch]--; hit++; }
    }
    if (hit < 2) return 0;
    return (hit / Math.max(a.length, b.length)) * 70;
  }

  function matchFood(rawName) {
    var q = normName(rawName);
    if (!q) return null;
    var map = allFoods();
    var qb = bareName(q);
    var qm = stripMethod(qb);

    // 查询的几种写法：原文 / 去括号 / 剥做法 / 再剥刀工后缀
    var variants = [];
    function addVariant(x) {
      if (x && x.length >= 2 && variants.indexOf(x) < 0) variants.push(x);
    }
    addVariant(qb);
    addVariant(qm);
    addVariant(stripMorph(qm));
    addVariant(stripMorph(qb));

    var alias = FOOD_ALIASES[q], k;
    for (k = 0; k < variants.length && !alias; k++) alias = FOOD_ALIASES[variants[k]];
    if (alias && map[alias]) return map[alias];

    var list = foodList();
    var best = null, bestScore = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var fn = normName(f.n);
      // 先按原始名去掉括号里的规格，再规整：normName 会把括号直接删掉，
      // 先规整的话「猪肉（五花肉）」会变成「猪肉五花肉」，括号就白留了。
      var fb = normName(bareName(f.n));
      for (var v = 0; v < variants.length; v++) {
        var s = 0;
        var vi = variants[v];
        if (fb === vi) s = 92;                                   // 规范名一致（忽略括号里的规格）
        else if (fn === vi) s = 91;                              // 连括号一起对上
        // 库名以查询开头：可乐 → 可乐（听装 330 ml）
        else if (fb.indexOf(vi) === 0 && fb.length - vi.length <= 6) s = 84;
        // 查询以库名结尾，且只多一两个字：清蒸鲈鱼 → 鲈鱼
        // （fb 比 vi 长时 lastIndexOf 是 -1，vi.length - fb.length 也是负数，
        //   不挡住的话任何长名字都会白捡 80 分——菠萝炒饭曾因此匹配上猪肉）
        else if (fb.length >= 2 && fb.length <= vi.length &&
          vi.length - fb.length <= 2 && vi.lastIndexOf(fb) === vi.length - fb.length) s = 80;
        else s = overlapScore(vi, fb);
        if (s > bestScore) { bestScore = s; best = f; }
      }
    }
    return bestScore >= 55 ? best : null;
  }

  // 把一条识别结果变成一条待确认的记录（形状必须和 beginEntry 里的一致，
  // 否则份量面板上的单位/折算重量会算错）
  function aiDraft(it) {
    var m = matchFood(it.name);
    var grams = Math.max(1, Math.round(Number(it.grams) || 100));
    var d;
    if (m) {
      var unit = m.u || '克';
      var per = unit === '克' ? 1 : (gramsPerUnit(m.n, unit) || m.w || 100);
      d = {
        id: uid(), date: state.date, meal: picker.meal,
        foodId: m.n, name: m.n, cat: m.c,
        unit: unit, qty: Math.max(0.5, Math.round((grams / (per || 100)) * 100) / 100), grams: grams,
        per100: { e: m.e, p: m.p, f: m.f, ch: m.ch },
        kcal: 0, p: 0, f: 0, ch: 0, ts: Date.now(), recog: 'db',
        eat: 1, price: 0, note: ''
      };
    } else {
      d = {
        id: uid(), date: state.date, meal: picker.meal,
        foodId: '', name: String(it.name || '识别到的菜'), cat: '家常菜',
        unit: '克', qty: grams, grams: grams,
        per100: {
          e: Number(it.kcal100) || 0, p: Number(it.protein100) || 0,
          f: Number(it.fat100) || 0, ch: Number(it.carbs100) || 0
        },
        kcal: 0, p: 0, f: 0, ch: 0, ts: Date.now(), recog: 'ai',
        eat: 1, price: 0, note: ''
      };
    }
    recalc(d);
    return d;
  }

  function recogRowHtml(it, i) {
    var m = matchFood(it.name);
    var grams = Math.max(1, Math.round(Number(it.grams) || 100));
    var name = m ? m.n : String(it.name || '识别到的菜');
    var cat = m ? m.c : '家常菜';
    var per100 = m ? m.e : (Number(it.kcal100) || 0);
    var tag = m
      ? '<span class="recog-tag db">库</span>'
      : '<span class="recog-tag ai">AI 估算</span>';
    return '<div class="row" data-act="recog-item" data-i="' + i + '">' +
      '<div class="thumb">' + foodEmoji(name, cat) + '</div>' +
      '<div class="body"><div class="title">' + esc(name) + ' ' + tag + '</div>' +
      '<div class="meta">' + esc(cat) + ' · 约 ' + grams + ' g · ' + r0(per100 * grams / 100) + ' kcal</div></div>' +
      '<div class="tail">' + svg('plus') + '</div></div>';
  }

  function recogListHtml(res, secs) {
    var items = res.items || [];
    if (!items.length) {
      return '<div class="field"><div class="small muted">这张照片没认出能吃的菜。' +
        '凑近一点、把盘子拍全一点，或者光线亮些再试。</div>' +
        '<div class="small muted mt8">这次不算次数，放心重拍。</div>' +
        '<div class="quick mt12"><button class="btn ghost" data-act="recognize">重拍一张</button>' +
        '<button class="btn ghost" data-act="recog-manual">手动记一条</button></div></div>';
    }
    return '<div class="field"><label>认出 ' + items.length + ' 样' + (secs ? ' · ' + secs + ' 秒' : '') + '</label>' +
      '<div class="list">' + items.map(recogRowHtml).join('') + '</div>' +
      (res.note ? '<div class="small muted mt8">' + esc(res.note) + '</div>' : '') +
      '<div class="small muted mt8">点一条可以改份量。「AI 估算」的是食物库里没有的，' +
      '误差会大一些，能改就改成自己熟悉的菜。</div></div>' +
      '<div class="field"><label>加到哪一餐</label><div class="quick">' +
      window.MEALS.map(function (m) { return '<button data-act="recog-meal" data-m="' + m.id + '" class="' +
        (picker.meal === m.id ? 'on' : '') + '" style="' + (picker.meal === m.id ? 'background:var(--brand);color:var(--brand-ink);border-color:var(--brand)' : '') + '">' +
        m.emoji + m.name + '</button>'; }).join('') +
      '</div></div>' +
      '<div class="field"><label>顺手存到动态</label>' +
      '<div class="small muted">把这张照片存进今天的记录，好友在动态里能看到、点赞、打分。' +
      '不愿意给看不点就行，识别结果照样能记。</div>' +
      '<button class="btn ghost mt8" data-act="recog-photo">' +
      (photoBusy ? '正在上传…' : '📷 存到今天的动态') + '</button></div>' +
      '<div class="field"><button class="btn" data-act="recog-all">全部加进' + mealName(picker.meal) + '</button></div>';
  }

  /* 出错了别只留一句「再试试」。三条路给全：
   * 重拍（次数还够时最好使）、稍后重试（网络问题，图已经存下来了）、
   * 手动记一条（次数用完或者连不上，总不能饿着不记）。 */
  function recogErrHtml(r) {
    var hint;
    if (r.status === 503) hint = '服务器上还没配视觉模型的 Key，配好再试（见 README 的「拍照识别」一节）。';
    else if (r.status === 413) hint = '图片太大了，换一张再试。';
    else if (r.status === 415) hint = BAD_IMAGE_TEXT;
    else if (r.status === 401) hint = '登录过期了，去「我的」重新登录。';
    else if (r.status === 429) hint = '今天的次数用完了（每人每天 5 次），明天再来；也可以用下面第二个按钮手动记。';
    else if (!r.status) hint = '连不上服务器。这张图已经留在手机上了，等有网再点「稍后重试」就行。';
    else hint = '识别失败，换一张清楚一点的再试。这次没扣次数。';
    /* 网络类失败（超时/断网/网关 5xx）才值得存图重试；
       401/429/413 存了也没用，重试只会再错一遍。 */
    var retryable = !r.status || r.status === 502 || r.status === 504;
    var btns = '<div class="quick mt12">' +
      '<button class="btn ghost" data-act="recognize">重新拍一张</button>' +
      (retryable ? '<button class="btn" data-act="recog-retry">稍后重试</button>' : '') +
      '<button class="btn ghost" data-act="recog-manual">手动记一条</button></div>';
    return '<div class="field"><div class="small muted">' + esc(r.error || '出错了') + '</div>' +
      '<div class="small muted mt8">' + hint + '</div>' + btns + '</div>';
  }

  function readFileAsDataUrl(file, cb) {
    try {
      var reader = new FileReader();
      reader.onload = function () { cb(String(reader.result || '')); };
      reader.onerror = function () { cb(''); };
      reader.readAsDataURL(file);
    } catch (e) { cb(''); }
  }

  /* 读 JPEG 的 EXIF 方向标记（1–8）。为什么要自己读：
   * 安卓 7/8 的 WebView 内核是 Chrome 5x，浏览器自动按 EXIF 转正是 Chrome 81 才有的事。
   * 竖着拍的一盘菜，在那些机器上交给我们的 img 是躺着的，模型看图会认错。
   * 只扫 data URL 开头 192 KB —— EXIF 段一定紧跟在文件头后面。 */
  function exifOrientation(dataUrl) {
    try {
      var comma = String(dataUrl).indexOf(',');
      if (comma < 0) return 1;
      var bin = window.atob(String(dataUrl).slice(comma + 1, comma + 1 + 192 * 1024));
      var n = bin.length;
      if (n < 4 || bin.charCodeAt(0) !== 0xFF || bin.charCodeAt(1) !== 0xD8) return 1;  // 不是 JPEG
      var p = 2;
      while (p + 4 < n) {
        if (bin.charCodeAt(p) !== 0xFF) return 1;
        var marker = bin.charCodeAt(p + 1);
        if (marker === 0xDA || marker === 0xD9) return 1;   // 到了图像数据，不该再有 EXIF
        var len = (bin.charCodeAt(p + 2) << 8) | bin.charCodeAt(p + 3);
        if (marker === 0xE1 && bin.substr(p + 4, 6) === 'Exif\u0000\u0000') {
          return readExifOrientation(bin, p + 10, n);
        }
        p += 2 + len;
      }
    } catch (e) { /* atob 挂了就当没有 EXIF */ }
    return 1;
  }

  function readExifOrientation(bin, tiff, n) {
    if (tiff + 8 > n) return 1;
    var little = bin.charCodeAt(tiff) === 0x49 && bin.charCodeAt(tiff + 1) === 0x49;
    function u16(o) {
      var a = bin.charCodeAt(o), b = bin.charCodeAt(o + 1);
      return little ? ((b << 8) | a) : ((a << 8) | b);
    }
    function u32(o) {
      if (little) {
        return (bin.charCodeAt(o + 3) << 24 | bin.charCodeAt(o + 2) << 16 |
          bin.charCodeAt(o + 1) << 8 | bin.charCodeAt(o)) >>> 0;
      }
      return (bin.charCodeAt(o) << 24 | bin.charCodeAt(o + 1) << 16 |
        bin.charCodeAt(o + 2) << 8 | bin.charCodeAt(o + 3)) >>> 0;
    }
    if (u16(tiff + 2) !== 0x002A) return 1;      // TIFF magic 不对
    var ifd = tiff + u32(tiff + 4);
    if (ifd + 2 > n) return 1;
    var count = u16(ifd);
    for (var i = 0; i < count; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > n) return 1;
      if (u16(e) === 0x0112) {                   // Orientation
        var v = u16(e + 8);
        return (v >= 1 && v <= 8) ? v : 1;
      }
    }
    return 1;
  }

  /* 按 EXIF 方向摆正坐标系再画图。画布尺寸已经按「转完以后的宽高」建好，
   * 所以这里只负责把坐标系转过去。w/h 是原图（未转）的宽高。 */
  function applyExifTransform(ctx, ori, w, h) {
    if (ori === 2) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    else if (ori === 3) { ctx.translate(w, h); ctx.rotate(Math.PI); }
    else if (ori === 4) { ctx.translate(0, h); ctx.scale(1, -1); }
    else if (ori === 5) { ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); }
    else if (ori === 6) { ctx.rotate(0.5 * Math.PI); ctx.translate(0, -h); }
    else if (ori === 7) { ctx.rotate(0.5 * Math.PI); ctx.translate(w, -h); ctx.scale(-1, 1); }
    else if (ori === 8) { ctx.rotate(-0.5 * Math.PI); ctx.translate(-w, 0); }
  }

  /* 糊了或者太暗的照片，发上去只有两种结果：认错菜，或者白扣一次额度（每天 5 次）。
   * 送出去之前先在本地量两个数：平均亮度、拉普拉斯方差（越小越糊）。
   * 阈值故意放得很松 —— 只有明显不能看的时候才拦一下，不让它变成新的麻烦。 */
  function photoMetrics(canvas, w, h) {
    try {
      var s = Math.min(1, 192 / Math.max(w, h));
      var mw = Math.max(8, Math.round(w * s)), mh = Math.max(8, Math.round(h * s));
      var tmp = document.createElement('canvas');
      tmp.width = mw; tmp.height = mh;
      var tctx = tmp.getContext ? tmp.getContext('2d') : null;
      if (!tctx) return null;
      tctx.drawImage(canvas, 0, 0, mw, mh);
      var d = tctx.getImageData(0, 0, mw, mh).data;
      var gray = [], sum = 0, j = 0;
      for (var i = 0; i < d.length; i += 4) {
        var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        gray[j++] = g; sum += g;
      }
      var bright = sum / (gray.length || 1);
      var lap = [], mean = 0;
      for (var y = 1; y < mh - 1; y++) {
        for (var x = 1; x < mw - 1; x++) {
          var k = y * mw + x;
          var v = 4 * gray[k] - gray[k - 1] - gray[k + 1] - gray[k - mw] - gray[k + mw];
          lap.push(v); mean += v;
        }
      }
      mean = mean / (lap.length || 1);
      var vs = 0;
      for (var q = 0; q < lap.length; q++) { var dv = lap[q] - mean; vs += dv * dv; }
      return { brightness: bright, sharpness: vs / (lap.length || 1) };
    } catch (e) {
      return null;   // 取不到像素就当测不了，不拦用户
    }
  }

  function qualityHint(m) {
    if (!m) return '';
    if (m.brightness < 42) return '这张太暗了，模型多半看不清。开个灯、或者到窗边重拍一张会准很多。';
    if (m.sharpness < 30) return '这张有点糊（手抖或没对上焦），模型容易认错菜。建议重拍一张。';
    return '';
  }

  /* 压图在本地做：原图动辄 3–5 MB，直接 base64 传上去既慢又费流量，
   * 服务端还要为它多吃内存。视觉模型反正会把图缩到 ~1.3 兆像素，
   * 提前缩到 896px 基本不损失识别率。 */
  function shrinkImage(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var w = img.width || 1, h = img.height || 1;
      var ori = exifOrientation(dataUrl);
      var swap = ori >= 5 && ori <= 8;            // 5–8 带 90° 旋转
      var scale = Math.min(1, RECOG_EDGE / Math.max(swap ? h : w, swap ? w : h));
      // 够小、方向也对、本身不大 —— 原样发，省一次重新编码
      if (scale >= 1 && ori === 1 && dataUrl.length < 400 * 1024) { cb(dataUrl, null); return; }
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var dw = swap ? ch : cw, dh = swap ? cw : ch;
      var cv = document.createElement('canvas');
      cv.width = dw; cv.height = dh;
      var ctx = cv.getContext ? cv.getContext('2d') : null;
      if (!ctx) { cb(dataUrl, null); return; }
      // 先铺白底：PNG 透明区转 JPEG 会变成黑块
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, dw, dh);
      ctx.save();
      applyExifTransform(ctx, ori, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      ctx.restore();
      var out = dataUrl;
      try { out = cv.toDataURL('image/jpeg', RECOG_QUALITY) || dataUrl; } catch (e) { /* 保持原图 */ }
      cb(out, photoMetrics(cv, dw, dh));
    };
    /* 解不开（HEIC / 损坏 / 不是图片）就回 null，**不要**把原图递上去：
     * 原图 WebView 自己都画不出来（预览是一片空白），服务端也会按魔数拒掉 415，
     * 用户只能看到一句「稍后再试」，根本猜不到是格式问题。 */
    img.onerror = function () { cb(null, null); };
    img.src = dataUrl;
  }

  /* 每天只给 5 次，所以把剩余次数写在按钮下面 —— 让人先知道还剩多少，
   * 而不是拍到第 6 张才被服务端 429 顶回来。查不到就整行不显示。 */
  function recogQuotaText(s) {
    if (!s || !s.enabled) return '';
    var left = Number(s.remainingToday);
    if (!isFinite(left)) return '';
    var lim = Number(s.dailyLimit) || 0;
    if (left <= 0) return '今天的次数用完了（每天 ' + (lim || 5) + ' 次），明天再来。也可以手动记一条。';
    return '今天还能识别 ' + left + ' 次' + (lim ? '（每天 ' + lim + ' 次）' : '');
  }

  function fillRecogQuota(sheet) {
    var el = $('#recog-quota', sheet);
    if (!el) return;
    api.recognizeStatus(serverCfg()).then(function (r) {
      if (!r || r.error || !r.data) return;
      if (!el.parentNode) return;   // 面板已经关了
      el.textContent = recogQuotaText(r.data);
    });
  }

  function openRecognizeSheet() {
    recogOut = null;
    recogBusy = false;
    var body =
      '<div class="field"><div class="small muted">拍一张饭菜的照片，一次能认出桌上几样。' +
      '重量是估的，加进记录之前都能改。</div>' +
      '<div class="small muted mt8">拍得准一点：光线足、整盘都框进去、从上往下斜着拍；' +
      '别用手或筷子挡住主要的菜。</div>' +
      '<button class="btn mt12" data-act="recog-pick">📷 拍照 / 从相册选</button>' +
      '<input type="file" id="recog-file" accept="image/*" class="recog-file">' +
      '<div class="small muted mt8" id="recog-quota"></div>' +
      '</div>' +
      '<div id="recog-out"></div>';
    /* 上次因为断网/超时没发出去的那张，别让用户再翻一遍相册。 */
    if (loadPendingPhoto()) {
      body += '<div class="field"><label>上次那张还没发出去</label>' +
        '<div class="small muted">照片还留在手机上，不用重拍。</div>' +
        '<div class="quick mt12"><button class="btn" data-act="recog-retry">重新发送</button>' +
        '<button class="btn ghost" data-act="recog-drop">丢掉</button></div></div>';
    }
    var sheet = openSheet('拍照识别', body,
      '<button class="btn ghost" data-act="cancel">关闭</button>');
    var input = $('#recog-file', sheet);
    if (input) input.addEventListener('change', function () { onPickPhoto(this, sheet); });
    fillRecogQuota(sheet);
  }

  function onPickPhoto(input, sheet) {
    var file = input.files && input.files[0];
    var out = $('#recog-out', sheet);
    if (!file || !out) return;
    if (recogBusy) { toast('上一张还在识别'); return; }
    // 手机直出 HEIC 也能有 8 MB，压图前先挡一道，别把内存吃爆
    if (file.size > 25 * 1024 * 1024) { out.innerHTML = '<div class="field"><div class="small muted">这张图太大了（>25 MB）。</div></div>'; return; }
    // 0 字节：相机建了文件却没写内容（某些 ROM 会这样），说清楚原因
    if (!file.size) { out.innerHTML = '<div class="field"><div class="small muted">这个文件是空的：相机没把照片存下来。换一张，或者从相册里选。</div></div>'; return; }
    recogPending = null;
    out.innerHTML = '<div class="field"><div class="small muted">正在压缩图片…</div></div>';
    readFileAsDataUrl(file, function (raw) {
      if (!raw) {
        out.innerHTML = '<div class="field"><div class="small muted">这张图读不出来，换一张（JPG / PNG）试试。</div></div>';
        return;
      }
      shrinkImage(raw, function (small, m) {
        if (!small) {
          out.innerHTML = '<div class="field"><div class="small muted">' + esc(BAD_IMAGE_TEXT) + '</div>' +
            '<div class="quick mt12"><button class="btn ghost" data-act="recog-pick">换一张</button>' +
            '<button class="btn ghost" data-act="recog-manual">手动记一条</button></div></div>';
          return;
        }
        var bad = qualityHint(m);
        if (bad) {
          /* 先别发：一天只有 5 次，糊图发出去大概率是浪费一次。
             图已经压好了，用户点「就这样识别」就接着发。 */
          recogPending = small;
          out.innerHTML = '<div class="recog-photo"><img src="' + small + '" alt=""></div>' +
            '<div class="field"><div class="small muted">' + esc(bad) + '</div>' +
            '<div class="quick mt12"><button class="btn ghost" data-act="recog-pick">换一张</button>' +
            '<button class="btn" data-act="recog-force">就这样识别</button></div></div>';
          return;
        }
        sendRecognize(small, out);
      });
    });
  }

  function sendRecognize(small, out) {
    recogPending = null;
    photoSaved = false;
    out.innerHTML = '<div class="recog-photo"><img src="' + small + '" alt=""></div>' +
      '<div class="field"><div class="small muted">识别中… 大模型看图一般 3–10 秒</div></div>';
    var t0 = Date.now();
    recogBusy = true;
    api.recognize(serverCfg(), { image: small, meal: picker.meal, clientId: newClientId() }).then(function (r) {
      recogBusy = false;
      if (!out.parentNode) return;   // 面板已经被关掉了
      if (r.error) {
        /* 网络类失败把图存下来，「稍后重试」就不用重拍。
           同一个 clientId 重发时服务端会认出来，不会重复扣次数。 */
        var retryable = !r.status || r.status === 502 || r.status === 504;
        if (retryable) savePendingPhoto(small);
        out.innerHTML = recogErrHtml(r);
        return;
      }
      savePendingPhoto('');
      var data = r.data || {};
      recogOut = { items: data.items || [], note: data.note || '', model: data.model || '', small: small };
      pushRecentPhoto(small);   // 照片墙「最近拍的」直接就能拿来分享
      out.innerHTML = recogListHtml(recogOut, Math.round((Date.now() - t0) / 1000));
      var q = $('#recog-quota');
      if (q && data.remainingToday !== undefined) {
        q.textContent = recogQuotaText({
          enabled: true, remainingToday: data.remainingToday, dailyLimit: data.dailyLimit
        });
      }
    });
  }

  function addAllAi() {
    if (!recogOut || !recogOut.items.length) { toast('没有可加的'); return; }
    var meal = picker.meal;
    var n = 0;
    for (var i = 0; i < recogOut.items.length; i++) {
      var d = aiDraft(recogOut.items[i]);
      state.entries.push(d);
      var nm = d.name;
      state.recent = [nm].concat(state.recent.filter(function (x) { return x !== nm; })).slice(0, 20);
      n++;
    }
    if (!n) return;
    markDiaryDirty(state.date);
    save();
    closeSheet();
    render();
    toast('已加 ' + n + ' 样到' + mealName(meal));
  }

  /* 把刚识别用的那张图存进「今天的动态」。
   * 传的就是压过的 896px 版本（150 KB 上下），不用再压一遍；
   * 服务端存到 OSS，数据库里只留一行「谁、哪天、哪一餐、哪个 key」。
   * 照片和记录是两条独立的线：不传照片照样能记这条饭。 */
  var photoBusy = false;
  var photoSaved = false;

  function savePhotoToFeed(small) {
    if (!small) { toast('没有可存的照片'); return; }
    if (!serverOn() || !state.server.token) { toast('先在设置里连上服务器才能存照片'); return; }
    if (photoBusy) { toast('上一张还在传，稍等一下'); return; }
    photoBusy = true;
    var caption = '';
    if (recogOut && recogOut.items && recogOut.items.length) {
      var names = [];
      for (var i = 0; i < recogOut.items.length && i < 4; i++) names.push(recogOut.items[i].name);
      caption = names.join('、') + (recogOut.items.length > 4 ? ' 等' : '');
    }
    if (recogOut) recogOut.photoBusy = true;
    setRecogPhotoLabel();
    api.uploadPhoto(serverCfg(), {
      image: small,
      date: state.date,
      meal: picker.meal,
      caption: caption,
      clientId: newClientId()
    }).then(function (r) {
      photoBusy = false;
      if (recogOut) recogOut.photoBusy = false;
      setRecogPhotoLabel();
      if (r.error) {
        var msg = r.status === 503 ? '服务器还没开照片存储（见 README 的「照片存储」一节）'
          : r.status === 413 ? '这张图太大了'
          : r.status === 415 ? '这张图的格式不支持，换一张 JPG'
          : r.status === 429 ? '今天的照片数量用完了'
          : r.status === 401 ? '登录过期了，重新登录一下'
          : ('没存上：' + (r.error || '稍后再试'));
        toast(msg);
        return;
      }
      toast('照片已存进今天的记录');
      photoSaved = true;
      setRecogPhotoLabel();
      /* 动态页按「今天」拉一次，让刚存的图马上出现在自己那条里 */
      if (typeof pullFeed === 'function') pullFeed(true, true);
    });
  }

  /* 上传中/已上传只改按钮上的字，别整块重绘（会把「加到哪一餐」的选中态清掉） */
  function setRecogPhotoLabel() {
    var btn = $('[data-act="recog-photo"]');
    if (!btn) return;
    if (photoBusy) btn.textContent = '正在上传…';
    else if (photoSaved) { btn.textContent = '✓ 已存到今天的动态'; btn.disabled = true; }
    else btn.textContent = '📷 存到今天的动态';
  }

  /* ---------------------------------------------------------- 照片墙（朋友圈） */
  /* 好友页的第三个分段：我 + 好友的照片，按时间倒序。
   *
   * 两个入口：
   *   1. 拍照识别留下来的图 —— 识别成功时顺手存一张进本地「最近识别」（最多 3 张，
   *      只留压缩后的 896px 版本，约 100 KB/张），照片墙顶部点一下就直接分享，
   *      不用为了发一条动态再拍一次；
   *   2. 照片墙自己的「拍照 / 从相册选」。
   *
   * 分页用游标（before = 上一页最后一张的 createdAt）而不是 offset：
   * 翻页时有好友新传了照片，offset 会漏一张或重一张。 */

  var RECENT_KEY = 'shike_recog_recent';
  var RECENT_MAX = 3;

  var photoFeed = [];        // 我 + 好友的照片，最新在前
  var photoCursor = 0;
  var photoHasMore = true;
  var photoLoading = false;
  var photoFetchedAt = 0;
  var wallImage = '';        // 正在发的那张（data URL）
  var wallBusy = false;
  var wallDay = 'today';     // 这张照片算哪天的：today / yesterday

  function loadRecentPhotos() {
    try {
      var raw = window.localStorage.getItem(RECENT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string' && x.slice(0, 11) === 'data:image/'; }) : [];
    } catch (e) { return []; }
  }

  function pushRecentPhoto(dataUrl) {
    if (!dataUrl) return;
    if (dataUrl.length > 400 * 1024) return;   // 太大的不占本地空间
    try {
      var arr = loadRecentPhotos();
      // 同一张图不重复存：比对前 200 个字符足够区分
      arr = arr.filter(function (x) { return x.slice(0, 200) !== dataUrl.slice(0, 200); });
      arr.unshift(dataUrl);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX)));
    } catch (e) { /* 隐私模式 / 配额满：不存也不影响识别 */ }
  }

  function dropRecentPhoto(dataUrl) {
    try {
      var arr = loadRecentPhotos().filter(function (x) { return x !== dataUrl; });
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(arr));
    } catch (e) {}
  }

  function photoWallHtml() {
    var html = '';

    var recent = loadRecentPhotos();
    if (recent.length) {
      html += '<div class="card"><div class="card-head"><h2>最近拍的</h2>' +
        '<span class="hint">点一下直接分享</span></div><div class="wall-recent">';
      for (var i = 0; i < recent.length; i++) {
        html += '<button class="wall-recent-item" data-act="wall-import" data-i="' + i + '">' +
          '<img src="' + recent[i] + '" alt=""></button>';
      }
      html += '</div></div>';
    }

    html += '<div class="card wall-add-card">' +
      '<button class="btn ghost wall-add" data-act="wall-pick">📷 拍照 / 从相册选</button>' +
      '</div>';

    if (!photoFeed.length) {
      html += '<div class="card center muted">' +
        (photoLoading ? '正在加载…'
          : '还没有照片<br><span class="small">拍一张发出来，好友就能看到、能给你这顿打分</span>') +
        '</div>';
      return html;
    }

    // 按日期分组，同一天的照片铺成三列
    var byDate = {};
    var order = [];
    for (var j = 0; j < photoFeed.length; j++) {
      var p = photoFeed[j];
      var d = p.date || '';
      if (!byDate[d]) { byDate[d] = []; order.push(d); }
      byDate[d].push(p);
    }
    for (var k = 0; k < order.length; k++) {
      var day = order[k];
      var list = byDate[day];
      html += '<div class="wall-day"><div class="wall-day-head">' + esc(prettyDate(day)) +
        '<span class="small muted"> · ' + list.length + ' 张</span></div>' +
        '<div class="wall-grid">';
      for (var m = 0; m < list.length; m++) {
        var ph = list[m];
        var badges = '';
        if (Number(ph.likes)) badges += '<span class="wall-badge">❤️ ' + ph.likes + '</span>';
        if (Number(ph.commentCount)) badges += '<span class="wall-badge">💬 ' + ph.commentCount + '</span>';
        else if (ph.rating && Number(ph.rating.count)) badges += '<span class="wall-badge">★ ' + ph.rating.avg + '</span>';
        html += '<button class="wall-tile" data-act="wall-open" data-id="' + ph.id + '">' +
          (ph.url ? '<img src="' + esc(ph.url) + '" alt="" loading="lazy">' : '<span class="small muted">图片没存上</span>') +
          (ph.mine ? '' : '<span class="wall-who">' + esc((ph.author && ph.author.displayName) || '好友') + '</span>') +
          (badges ? '<span class="wall-badges">' + badges + '</span>' : '') +
          '</button>';
      }
      html += '</div></div>';
    }

    if (photoHasMore) {
      html += '<div class="card center"><button class="btn ghost" data-act="wall-more">' +
        (photoLoading ? '正在加载…' : '看更早的') + '</button></div>';
    }
    return html;
  }

  function pullPhotoFeed(force) {
    if (!serverOn() || !state.server.token) {
      photoFeed = []; photoHasMore = false; photoLoading = false;
      return;
    }
    if (photoLoading) return;
    if (!force && photoFeed.length && Date.now() - photoFetchedAt < 60 * 1000) return;
    photoLoading = true;
    if (state.view === 'social' && state.feedTab === 'photos') render();
    api.photoFeed(serverCfg(), 0, 24).then(function (r) {
      photoLoading = false;
      if (r && !r.error) {
        var d = r.data || {};
        photoFeed = d.photos || [];
        photoCursor = d.nextBefore || 0;
        photoHasMore = !!d.hasMore;
        photoFetchedAt = Date.now();
      }
      if (state.view === 'social' && state.feedTab === 'photos') render();
    });
  }

  function loadMorePhotos() {
    if (photoLoading || !photoHasMore || !photoCursor) return;
    photoLoading = true;
    render();
    api.photoFeed(serverCfg(), photoCursor, 24).then(function (r) {
      photoLoading = false;
      if (r && !r.error) {
        var d = r.data || {};
        photoFeed = photoFeed.concat(d.photos || []);
        photoCursor = d.nextBefore || 0;
        photoHasMore = !!d.hasMore;
      }
      if (state.view === 'social' && state.feedTab === 'photos') render();
    });
  }

  function openWallComposer(prefill) {
    if (!serverOn() || !state.server.token) { toast('先在设置里连上服务器才能发照片'); return; }
    wallImage = prefill || '';
    var body =
      '<div class="field"><label>照片</label>' +
      '<input type="file" id="wall-file" accept="image/*" class="recog-file">' +
      '<div id="wall-preview">' + (wallImage
        ? '<div class="recog-photo"><img src="' + wallImage + '" alt=""></div>'
        : '<div class="small muted">还没选。点下面的按钮拍照或从相册挑一张。</div>') + '</div>' +
      '<div class="mt8"><button class="btn ghost small" data-act="wall-choose">' +
      (wallImage ? '换一张' : '拍照 / 从相册选') + '</button></div></div>' +
      '<div class="field"><label>文案（可选，好友看得到）</label>' +
      '<input class="input" id="wall-caption" maxlength="120" placeholder="楼下小碗菜，18 块，米饭没吃完"></div>' +
      '<div class="field"><label>算在哪一天</label>' +
      '<div class="quick">' +
      '<button data-act="wall-day" data-d="today" class="' + (wallDay === 'today' ? 'on' : '') + '">今天</button>' +
      '<button data-act="wall-day" data-d="yesterday" class="' + (wallDay === 'yesterday' ? 'on' : '') + '">昨天</button>' +
      '</div></div>';
    openSheet('发一张照片', body,
      '<button class="btn ghost" data-act="cancel">取消</button>' +
      '<button class="btn" data-act="wall-send">' + (wallBusy ? '上传中…' : '上传') + '</button>');
    var input = $('#wall-file');
    if (input) {
      input.addEventListener('change', function () { onWallPick(input); });
    }
  }

  function onWallPick(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('这张图太大了，换一张'); return; }
    /* 0 字节 = 相机（或某些 ROM）建了文件却没往里写。这种文件读出来是一段空 base64，
     * 后面只会以「打不开」收场，不如在这里就说清楚是相机没存下来。 */
    if (!file.size) {
      toast('这个文件是空的：相机没把照片存下来。换一张，或者从相册里选。');
      return;
    }
    var preview = $('#wall-preview');
    if (preview) preview.innerHTML = '<div class="small muted">正在处理图片…</div>';
    readFileAsDataUrl(file, function (dataUrl) {
      if (!dataUrl) { toast('这张图读不出来，换一张试试'); return; }
      shrinkImage(dataUrl, function (small) {
        if (!small) {
          wallImage = '';
          if (preview) preview.innerHTML = '<div class="small muted">' + esc(BAD_IMAGE_TEXT) + '</div>';
          toast('这张图打不开，换一张 JPG');
          return;
        }
        wallImage = small;
        if (preview) preview.innerHTML = '<div class="recog-photo"><img src="' + wallImage + '" alt=""></div>';
        var btn = $('[data-act="wall-choose"]');
        if (btn) btn.textContent = '换一张';
      });
    });
  }

  function wallDate() {
    return wallDay === 'yesterday' ? shiftDay(today(), -1) : today();
  }

  function sendWallPhoto() {
    if (!wallImage) { toast('先选一张照片'); return; }
    if (wallBusy) return;
    var cap = ($('#wall-caption') && $('#wall-caption').value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    wallBusy = true;
    var btn = $('[data-act="wall-send"]');
    if (btn) { btn.textContent = '上传中…'; btn.disabled = true; }
    api.uploadPhoto(serverCfg(), {
      image: wallImage,
      date: wallDate(),
      meal: picker.meal,
      caption: cap,
      clientId: newClientId()
    }).then(function (r) {
      wallBusy = false;
      if (r.error) {
        var msg = r.status === 503 ? '服务器还没开照片存储（见 README）'
          : r.status === 413 ? '这张图太大了'
          : r.status === 415 ? '这张图的格式不支持，换一张 JPG'
          : r.status === 429 ? '今天存的照片到上限了（每天 30 张）'
          : r.status === 401 ? '登录过期了，重新登录一下'
          : ('没传上去：' + (r.error || '稍后再试'));
        toast(msg);
        if (btn) { btn.textContent = '上传'; btn.disabled = false; }
        return;
      }
      dropRecentPhoto(wallImage);
      wallImage = '';
      closeSheet();
      toast('照片发出去了');
      state.feedTab = 'photos';
      pullPhotoFeed(true);
      render();
    });
  }

  /* ---------------------------------------------------------- 照片详情 */
  /* 照片不再只是「一张图」：点开是一页动态 —— 谁、哪天、文案、点赞、1–5 星、评论。
   * 先用本地那份数据把页面铺出来（点开立刻有东西），再向服务器要一份最新的补上：
   * 免费实例冷启动要几秒，等白了屏没人愿意点第二次。 */
  var photoCur = null;      // { photo, comments }

  function findFeedPhoto(id) {
    for (var i = 0; i < photoFeed.length; i++) {
      if (Number(photoFeed[i].id) === Number(id)) return photoFeed[i];
    }
    return null;
  }

  function syncFeedPhoto(id, patch) {
    var p = findFeedPhoto(id);
    if (!p) return;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) p[k] = patch[k];
  }

  function agoText(ms) {
    var d = Date.now() - Number(ms || 0);
    if (!(d >= 0)) return '';
    if (d < 60 * 1000) return '刚刚';
    if (d < 3600 * 1000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 24 * 3600 * 1000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 7 * 24 * 3600 * 1000) return Math.floor(d / 86400000) + ' 天前';
    return '';
  }

  function photoStarsHtml(p) {
    var r = p.rating || {};
    var mine = Number(r.mine) || 0;
    var out = '<span class="pstars">';
    for (var i = 1; i <= 5; i++) {
      out += '<button class="pstar' + (i <= mine ? ' on' : '') + '" data-act="photo-rate" data-s="' + i +
        '" aria-label="' + i + ' 星">★</button>';
    }
    out += '</span><span class="small muted">' +
      (Number(r.count) ? ((Number(r.avg) || 0) + ' 分 · ' + r.count + ' 人打过') : '还没人打分') +
      '</span>';
    return out;
  }

  function photoDetailBody(p, comments) {
    var who = p.mine ? '我' : ((p.author && p.author.displayName) || '好友');
    var html = '';
    if (p.url) html += '<div class="photo-full"><img src="' + esc(p.url) + '" alt=""></div>';
    html += '<div class="photo-meta">' + esc(who) + ' · ' + esc(prettyDate(p.date)) + '</div>';
    if (p.caption) {
      html += '<div class="photo-cap">' + esc(p.caption) + '</div>';
    } else if (p.mine) {
      html += '<div class="photo-cap empty">还没写文案 —— 点「写点文案」补一句，好友才知道这是哪儿买的、多少钱。</div>';
    }
    html += '<div class="photo-acts">' +
      '<button class="btn ghost small' + (p.likedByMe ? ' on' : '') + '" data-act="photo-like">' +
      (p.likedByMe ? '❤️ 已赞 ' : '🤍 点赞 ') + (Number(p.likes) || 0) + '</button>' +
      photoStarsHtml(p) + '</div>';
    if (p.mine) {
      html += '<div class="quick mt8">' +
        '<button class="btn ghost small" data-act="wall-cap">写点文案</button>' +
        '<button class="btn ghost small" data-act="wall-del" data-id="' + p.id + '">删除这张</button>' +
        '</div>';
    }
    html += '<div class="photo-comments">';
    if (!comments || !comments.length) {
      html += '<div class="small muted">还没有评论，说两句。</div>';
    } else {
      for (var i = 0; i < comments.length; i++) {
        var c = comments[i];
        var name = (c.author && c.author.displayName) || '好友';
        html += '<div class="pc-item"><div class="pc-head">' + esc(name) +
          '<span class="small muted"> · ' + esc(agoText(c.createdAt)) + '</span>' +
          (c.mine ? '<button class="pc-del" data-act="photo-cmt-del" data-id="' + c.id + '">删除</button>' : '') +
          '</div><div class="pc-body">' + esc(c.body) + '</div></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderPhotoDetail() {
    if (!photoCur) return;
    var p = photoCur.photo;
    var who = p.mine ? '我' : ((p.author && p.author.displayName) || '好友');
    openSheet(who + '的照片', photoDetailBody(p, photoCur.comments),
      '<input class="input" id="pc-input" maxlength="200" placeholder="说点什么…">' +
      '<button class="btn" data-act="photo-comment">发送</button>');
  }

  function openWallPhoto(id) {
    var cached = findFeedPhoto(id);
    if (!cached) return;
    photoCur = { photo: cached, comments: [] };
    renderPhotoDetail();
    api.photoDetail(serverCfg(), id).then(function (r) {
      if (r.error || !r.data || !r.data.photo) return;
      if (!photoCur || Number(photoCur.photo.id) !== Number(id)) return;
      photoCur = { photo: r.data.photo, comments: r.data.comments || [] };
      syncFeedPhoto(id, {
        likes: photoCur.photo.likes, likedByMe: photoCur.photo.likedByMe,
        commentCount: photoCur.photo.commentCount, rating: photoCur.photo.rating,
        caption: photoCur.photo.caption
      });
      renderPhotoDetail();
    });
  }

  function photoLike() {
    if (!photoCur) return;
    var id = photoCur.photo.id;
    api.likePhoto(serverCfg(), id).then(function (r) {
      if (r.error) { toast('点赞没成功：' + (r.error || '稍后再试')); return; }
      photoCur.photo.likes = Number(r.data && r.data.likes) || 0;
      photoCur.photo.likedByMe = !!(r.data && r.data.liked);
      syncFeedPhoto(id, { likes: photoCur.photo.likes, likedByMe: photoCur.photo.likedByMe });
      renderPhotoDetail();
    });
  }

  function photoRate(stars) {
    if (!photoCur) return;
    var id = photoCur.photo.id;
    api.ratePhoto(serverCfg(), id, stars).then(function (r) {
      if (r.error) { toast('打分没成功：' + (r.error || '稍后再试')); return; }
      photoCur.photo.rating = (r.data && r.data.rating) || photoCur.photo.rating;
      syncFeedPhoto(id, { rating: photoCur.photo.rating });
      renderPhotoDetail();
    });
  }

  function photoComment() {
    if (!photoCur) return;
    var inp = $('#pc-input');
    var text = ((inp && inp.value) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) { toast('先写点什么'); return; }
    var id = photoCur.photo.id;
    api.addPhotoComment(serverCfg(), id, text).then(function (r) {
      if (r.error) { toast('没发出去：' + (r.error || '稍后再试')); return; }
      if (r.data && r.data.comment) photoCur.comments.push(r.data.comment);
      photoCur.photo.commentCount = photoCur.comments.length;
      syncFeedPhoto(id, { commentCount: photoCur.comments.length });
      renderPhotoDetail();
    });
  }

  function delPhotoComment(id) {
    if (!photoCur) return;
    api.deletePhotoComment(serverCfg(), id).then(function (r) {
      if (r.error) { toast('没删掉：' + (r.error || '稍后再试')); return; }
      photoCur.comments = photoCur.comments.filter(function (c) { return Number(c.id) !== Number(id); });
      photoCur.photo.commentCount = photoCur.comments.length;
      syncFeedPhoto(photoCur.photo.id, { commentCount: photoCur.comments.length });
      renderPhotoDetail();
    });
  }

  function openCaptionEditor() {
    if (!photoCur) return;
    openSheet('写点文案',
      '<div class="field"><label>这一顿是什么情况</label>' +
      '<input class="input" id="cap-input" maxlength="120" placeholder="楼下小碗菜，18 块，米饭没吃完" value="' +
      esc(photoCur.photo.caption || '') + '"></div>' +
      '<div class="small muted">写给好友看的。以后想找「哪家店值」，靠的就是这一句。</div>',
      '<button class="btn ghost" data-act="cancel">取消</button>' +
      '<button class="btn" data-act="cap-save">保存</button>');
  }

  function saveCaption() {
    if (!photoCur) return;
    var inp = $('#cap-input');
    var cap = ((inp && inp.value) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    var id = photoCur.photo.id;
    api.editPhotoCaption(serverCfg(), id, cap).then(function (r) {
      if (r.error) { toast('没存上：' + (r.error || '稍后再试')); return; }
      photoCur.photo.caption = cap;
      syncFeedPhoto(id, { caption: cap });
      toast('文案已保存');
      renderPhotoDetail();
      render();
    });
  }

  function deleteWallPhoto(id) {
    api.deletePhoto(serverCfg(), id).then(function (r) {
      if (r.error) { toast('没删掉：' + (r.error || '稍后再试')); return; }
      photoFeed = photoFeed.filter(function (p) { return p.id !== Number(id); });
      closeSheet();
      toast('已删除');
      render();
    });
  }


  /* 新建自定义食物：两种填法
   *   serving —— 按「这一份 / 这一顿」填总量（默认）。出去吃一顿、点一杯奶茶，
   *              手里只有「这顿大概多少卡、多少蛋白」，谁也不会先换算成每 100 克。
   *   100g    —— 按每 100 克填（包装食品背面就是这么印的），保留给想精确复用的。
   * serving 存成 w = 100、ps = 1，这样「1 份」在份量面板里等于整份，不用动分量换算。
   */
  var nfMode = 'serving';

  function openNewFood() {
    nfMode = 'serving';
    var cats = window.CATEGORIES.map(function (c) { return c.id; });
    var body =
      '<div class="field"><label>怎么填</label><div class="segmented" id="nf-mode">' +
      '<button class="on" data-act="nf-mode" data-mode="serving">按这一份</button>' +
      '<button data-act="nf-mode" data-mode="100g">按每 100 克</button>' +
      '</div><div class="small muted mt8">' + NF_HINT.serving + '</div></div>' +
      '<div class="field"><label>食物名称</label><input class="input" id="nf-name" placeholder="如 楼下的鸡腿饭"></div>' +
      '<div class="field"><label>分类</label><select class="input" id="nf-cat">' +
      cats.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') + '</select></div>' +
      // 每格都带固定标签。以前只写占位符，填进去半格就看不见自己在填什么了。
      '<div class="field"><label id="nf-nut-label">这一份的营养</label><div class="num-grid">' +
      '<div class="field"><label>热量 kcal</label>' +
      '<input class="input" id="nf-e" type="number" inputmode="decimal" placeholder="自动"></div>' +
      '<div class="field"><label>蛋白质 g</label>' +
      '<input class="input" id="nf-p" type="number" inputmode="decimal"></div>' +
      '<div class="field"><label>碳水 g</label>' +
      '<input class="input" id="nf-ch" type="number" inputmode="decimal"></div>' +
      '<div class="field"><label>脂肪 g</label>' +
      '<input class="input" id="nf-f" type="number" inputmode="decimal"></div>' +
      '</div><div class="small muted mt8" id="nf-tip">' + NF_TIP.serving + '</div></div>' +
      '<div class="field"><label>单位与份量</label><div class="num-grid">' +
      '<div class="field"><label>单位</label><select class="input" id="nf-unit">' +
      Object.keys(window.SERVINGS).map(function (u) {
        return '<option value="' + u + '"' + (u === '份' ? ' selected' : '') + '>' + u + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field" id="nf-w-field" style="display:none"><label>每份克数</label>' +
      '<input class="input" id="nf-w" type="number" inputmode="decimal" placeholder="100"></div>' +
      '</div></div>';

    var foot = '<button class="btn ghost" data-act="cancel">取消</button>' +
      '<button class="btn" data-act="save-food">保存并使用</button>';
    var sheet = openSheet('新建自定义食物', body, foot);
    setNewFoodMode('serving', sheet);

    bindSheet('input', function (ev) {
      if (ev.target.id === 'nf-e') return;
      var pe = $('#nf-p', sheet), ce = $('#nf-ch', sheet), fe = $('#nf-f', sheet), ee = $('#nf-e', sheet);
      if (!pe || !ce || !fe || !ee) return;
      var p = parseFloat(pe.value) || 0;
      var c = parseFloat(ce.value) || 0;
      var f = parseFloat(fe.value) || 0;
      if (p || c || f) ee.value = r0(p * 4 + c * 4 + f * 9);
    });
  }

  var NF_HINT = {
    serving: '不换算每 100 克，这顿吃了多少就填多少。',
    '100g': '按包装上的「每 100 克」填，以后按克数称着记更准。'
  };
  var NF_TIP = {
    serving: '填了碳蛋脂，热量按 <b>蛋白 4 + 碳水 4 + 脂肪 9</b> 自动算；也可以直接改热量。',
    '100g': '填了碳蛋脂，热量按 <b>蛋白 4 + 碳水 4 + 脂肪 9</b> 自动算；也可以直接改热量。'
  };

  function setNewFoodMode(mode, sheet) {
    nfMode = mode === '100g' ? '100g' : 'serving';
    sheet = sheet || $('#sheet');
    if (!sheet) return;
    var btns = sheet.querySelectorAll('#nf-mode button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === nfMode;
      if (on) btns[i].classList.add('on'); else btns[i].classList.remove('on');
    }
    var lab = $('#nf-nut-label', sheet);
    if (lab) lab.textContent = nfMode === 'serving' ? '这一份的营养' : '每 100 克营养';
    var wf = $('#nf-w-field', sheet);
    if (wf) wf.style.display = nfMode === '100g' ? '' : 'none';
    if (nfMode === '100g') {
      var w = $('#nf-w', sheet);
      var u = $('#nf-unit', sheet);
      if (w && !w.value) w.value = (u && window.SERVINGS[u.value]) || 100;
    }
    var hint = sheet.querySelector('#nf-mode + .small');
    if (hint) hint.innerHTML = NF_HINT[nfMode];
    var tip = $('#nf-tip', sheet);
    if (tip) tip.innerHTML = NF_TIP[nfMode];
  }

  function saveNewFood() {
    var sheet = $('#sheet');
    var name = ($('#nf-name', sheet).value || '').trim();
    if (!name) { toast('请填写名字'); return; }
    var p = parseFloat($('#nf-p', sheet).value) || 0;
    var ch = parseFloat($('#nf-ch', sheet).value) || 0;
    var f = parseFloat($('#nf-f', sheet).value) || 0;
    var e = parseFloat($('#nf-e', sheet).value) || r0(p * 4 + ch * 4 + f * 9);
    var unit = $('#nf-unit', sheet).value || '份';
    var serving = nfMode !== '100g';
    var w = serving ? 100 : (parseFloat($('#nf-w', sheet).value) || window.SERVINGS[unit] || 100);
    var food = { n: name, c: $('#nf-cat', sheet).value, e: e, p: p, f: f, ch: ch, u: unit, w: w, custom: true };
    if (serving) food.ps = 1;
    state.custom = state.custom.filter(function (x) { return x.n !== name; });
    state.custom.push(food);
    invalidateFoods();
    markProfileDirty();   // 自定义食物跟着档案一起上云
    save();
    toast('已保存到我的食物');
    beginEntry(name);
  }

  /* -------------------------------------------------- 社交后端（Turso+Render） */
  /* 「连上了」= 有地址**并且**有 token。只看地址是不够的：地址可以只填了
     没登录（或者登录态过期了），那时候所有带鉴权的接口都会 401，界面却以为
     自己在联机 —— 检查更新就会因此误走回退路径（真踩过）。 */
  function serverOn() { return !!(state.server && state.server.baseUrl && state.server.token); }
  function serverCfg() {
    return { baseUrl: state.server.baseUrl, token: state.server.token };
  }
  function serverHint(res) {
    if (!res) return '';
    if (res.error) return res.error;
    return '';
  }

  /** 退出登录：只摘掉本机 token 和账号信息。记录、自定义食物都留在本机不动，
     之后再登录（同一个账号）会以服务器上的那份为准合并回来。 */
  function doLogout() {
    api.logout(serverCfg());   // 先拿旧 token 去注销，清空之后就发不出去了
    state.server.token = '';
    state.server.userId = null;
    state.server.uid = '';
    state.server.displayName = '';
    save();
    render();
  }

  /** 打开「社交服务器」设置浮层：填地址 → 连健康检查 → 注册/登录 */
  function openServerSheet() {
    var s = state.server;
    var body = '<div class="field"><label>服务器地址</label>' +
      '<input class="input" id="sv-url" placeholder="' + DEFAULT_SERVER + '" value="' + esc(s.baseUrl || '') + '"></div>' +
      '<div class="small muted mb12">数据库用 <b>Turso</b>，服务跑在 <b>Render</b> 免费 Web Service 上。' +
      '把域名填在这里就行，不用带 <code>/api</code> 路径。</div>';

    if (s.token) {
      body += '<div class="card" style="margin:0 0 12px">' +
        '<div class="row-between"><span class="small">当前登录</span>' +
        '<span class="small" style="color:var(--brand)">已连接</span></div>' +
        '<div style="font-weight:700;margin-top:4px">' + esc(s.displayName || s.userId || '已登录') + '</div>' +
        '<div class="row-between" style="margin-top:8px"><span class="small">自动同步</span>' +
        '<span class="small ' + (s.lastSyncOk === false ? 'warn-text' : 'muted') + '">' + esc(lastSyncText()) + '</span></div>' +
        '<div class="small muted" style="margin-top:2px">每次记录后自动上传，不用手动点。断网时会稍后自动重试。</div></div>' +
        '<div class="list mb12">' +
        '<div class="row" data-act="server-sync" style="padding:0 0 0 0"><div class="thumb">' + svg('cloud') + '</div>' +
        '<div class="body"><div class="title">立即同步一次</div><div class="meta">一般用不到；只在你想马上让好友看到时点</div></div><span class="chev">›</span></div>' +
        '<div class="row" data-act="server-logout" style="padding:0"><div class="thumb">' + svg('logout') + '</div>' +
        '<div class="body"><div class="title">退出登录</div><div class="meta">只清掉本机 token，记录不受影响</div></div><span class="chev">›</span></div>' +
        '</div>';
    } else {
      body += '<div class="field"><label>用户名</label><input class="input" id="sv-user" placeholder="3-24 位字母或数字"></div>' +
        '<div class="field"><label>密码</label><input class="input" id="sv-pass" type="password" placeholder="至少 6 位"></div>' +
        '<div class="field"><label>昵称（注册时用）</label><input class="input" id="sv-name" placeholder="好友看到的名字"></div>';
    }

    var foot = s.token
      ? '<button class="btn" data-act="server-save">保存地址</button>'
      : '<button class="btn ghost" data-act="server-login">登录</button>' +
        '<button class="btn" data-act="server-register">注册并登录</button>';
    openSheet('社交服务器', body, foot);
  }

  function readServerUrl() {
    var url = window.dietApi.trimBase($('#sv-url') ? $('#sv-url').value : '');
    state.server.baseUrl = url;
    save();
    return url;
  }

  function doServerLogin(isRegister) {
    readServerUrl();
    if (!state.server.baseUrl) { toast('先填服务器地址'); return; }
    var user = ($('#sv-user') && $('#sv-user').value || '').trim();
    var pass = ($('#sv-pass') && $('#sv-pass').value || '');
    var name = ($('#sv-name') && $('#sv-name').value || '').trim();
    if (!user || !pass) { toast('用户名和密码都要填'); return; }
    toast('连接服务器中…（免费实例唤醒要几十秒）');
    var cfg = serverCfg();
    var call = isRegister
      ? api.register(cfg, user, pass, name || user)
      : api.login(cfg, user, pass);
    call.then(function (res) {
      if (res.offline) { toast(res.error); return; }
      if (res.error) { toast(res.error); return; }
      var user2 = res.data.user || {};
      state.server.token = res.data.token;
      state.server.userId = user2.id || null;
      state.server.uid = user2.uid || '';
      state.server.displayName = user2.displayName || user;
      state.autoSync = true;
      save();
      closeSheet();
      render();
      toast(isRegister ? '注册成功，已登录' : '登录成功');
      // 登录后：先把本机记录整批迁上去，同时拉服务器上已有的（换手机能还原）
      pullDiary(true, true);
      pullProfile(true);
      pullFriends('', true);
      refreshFriendRequests(true, true);
      // 当天的记录推上去，好友马上就能看到；之后就靠自动同步
      scheduleSync();
      refreshFeed();
    });
  }

  /**
   * 待处理的好友请求。这是以前缺的一环：服务端一直有 /api/friends/requests、
   * accept、reject 三个接口，但客户端从来没有调用过 —— 所以对方发了请求，
   * 这边永远不知道，请求就一直卡在 pending。
   */
  /* ---------------------------------------------------------------------------
   * 拉取节流
   *
   * 以前每处都各拉各的：切个标签、从后台回来、对方点了同意……都可能连着发好几个
   * 一样的请求，Render 免费实例被打得慢上加慢。这里给每类数据一个最小间隔，
   * 内部调用（不带 force）自动去重，只有用户主动点刷新 / 刚登录才强制穿透。
   * ------------------------------------------------------------------------ */
  var PULL_GAP = { feed: 4000, friends: 4000, diary: 8000, profile: 15000, reqs: 5000 };
  var lastPull = {};
  function due(key, force) {
    if (force) { lastPull[key] = Date.now(); return true; }
    var now = Date.now();
    if (now - (lastPull[key] || 0) < (PULL_GAP[key] || 5000)) return false;
    lastPull[key] = Date.now();
    return true;
  }

  function refreshFriendRequests(silent, force) {
    if (!serverOn() || !state.server.token) {
      state.friendReqs = { incoming: [], outgoing: [] };
      return null;
    }
    if (!due('reqs', force)) return null;
    var prevOut = (state.friendReqs.outgoing || []).map(function (r) { return r.uid || ''; });
    var prevIn = (state.friendReqs.incoming || []).length;
    return api.friendRequests(serverCfg()).then(function (res) {
      if (!res || res.error) {
        if (!silent) toast(res && res.error ? res.error : '拿不到好友请求');
        return;
      }
      var d = res.data || {};
      var map = function (r) {
        var u = r.user || {};
        var name = u.displayName || u.username || '好友';
        return { id: r.id, uid: u.uid || '', name: name, letter: String(name).slice(0, 1) };
      };
      var inc = (d.incoming || []).map(map);
      var out = (d.outgoing || []).map(map);
      state.friendReqs = { incoming: inc, outgoing: out };
      save();
      // 数量变了才重画，避免每次轮询都重建 DOM（会把正在输入的框弄掉）
      if (prevIn !== inc.length || prevOut.length !== out.length) render();

      // 我发出去的请求少了一条 —— 要么对方同意了，要么拒绝了。这两种在
      // /api/friends/requests 里长得一样（都从 pending 里消失），只能再拉一次
      // 好友列表来判断。以前完全不处理，所以「对方点了同意，我这边看不到」。
      var gone = prevOut.filter(function (uid) {
        return uid && !out.some(function (o) { return o.uid === uid; });
      });
      if (gone.length) pullFriends('gone', true);

      if (!silent) {
        toast(inc.length ? '收到 ' + inc.length + ' 条好友请求，去「好友」看看' : '暂无新的好友请求');
      }
    }).catch(function () {
      if (!silent) toast('拿不到好友请求，网络好像不通');
    });
  }

  /** 接受 / 拒绝一条好友请求 */
  function answerFriendRequest(id, accept) {
    if (!serverOn() || !state.server.token) { toast('先登录'); return; }
    var call = accept ? api.acceptFriend : api.rejectFriend;
    call(serverCfg(), id).then(function (res) {
      if (!res || res.error) { toast((res && res.error) || '操作失败'); return; }
      state.friendReqs.incoming = state.friendReqs.incoming.filter(function (r) { return r.id !== id; });
      save();
      render();
      if (accept) { toast('已加为好友'); pullFriends('', true); }
      else toast('已拒绝');
    });
  }

  /**
   * 好友页需要的一切：待处理请求 + 好友列表 + 动态。
   * 用户主动点右上角刷新时 force=true，否则走节流。
   */
  function refreshSocial(force) {
    var jobs = [
      refreshFriendRequests(true, force),
      pullFriends('', force),
      pullFeed(true, force)
    ];
    return Promise.all(jobs.map(function (p) { return p || Promise.resolve(); }));
  }
  if (!window.__socialRefresh) {
    window.__socialRefresh = true;
    // 从后台切回来（手机解锁、从别的 App 回来）立刻补一次，
    // 这是「非得重进 App 才刷新」最直接的解药。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!serverOn() || !state.server.token) return;
      pullDiary(true);
      pullProfile(true);
      refreshSocial(false);
    });
  }

  // save() 是合并写入，离开页面前把还没落盘的那一次补上
  if (!window.__saveFlushBound) {
    window.__saveFlushBound = true;
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushSave();
    });
  }

  function refreshFeed() {
    if (!window.__demoServer && (!serverOn() || !state.server.token)) { toast('先连接服务器并登录'); return; }
    toast('拉取好友动态…');
    pullFeed(true, true);
    pullFriends('', true);
    refreshFriendRequests(true, true);
  }

  /** 只拉动态列表（silent=true 时不弹 toast） */
  function pullFeed(silent, force) {
    if (!window.__demoServer && (!serverOn() || !state.server.token)) return;
    if (!due('feed', force)) return null;
    return api.feed(serverCfg(), state.date, 'friends').then(function (res) {
      if (!res || res.error) { if (!silent) toast((res && res.error) || '拉不到动态'); return; }
      var posts = (res.data && res.data.posts) || [];
      state.posts = posts.map(postFromApi);
      save();
      render();
      if (!silent) toast('好友动态已更新（' + posts.length + ' 条）');
    });
  }

  /**
   * 拉好友列表。
   * notice:
   *   ''       安静更新
   *   'gone'   我发出的请求消失了 —— 拉完看好友有没有变多，来判断对方是同意还是拒绝
   */
  function pullFriends(notice, force) {
    if (!serverOn() || !state.server.token) return;
    if (!due('friends', force)) return null;
    var beforeCount = (state.friends || []).length;
    return api.friends(serverCfg()).then(function (res) {
      if (!res || res.error || !res.data) return;
      var list = res.data.friends || [];
      state.friends = list.map(function (u) {
        return {
          id: 'u' + u.id, name: u.displayName || u.username,
          letter: String(u.displayName || u.username || '?').slice(0, 1),
          goalText: u.goalText || '一起记录', streak: u.streak || 0, online: true
        };
      });
      save();
      if (state.view === 'social' || state.view === 'me') render();
      if (notice === 'gone') {
        toast(list.length > beforeCount ? '对方同意了，已经加为好友' : '对方没有同意你的好友请求');
      } else if (list.length > beforeCount) {
        toast('多了一位好友');
      }
    });
  }

  /** 后端的 post 形状 → 本机渲染用的形状（字段名不同，这里做一次翻译） */
  function postFromApi(p) {
    var meals = p.meals || {};
    // 后端把餐次规整成 breakfast/lunch/dinner/snack/extra 五个 key，这里摊平
    // 成和本机记录一样的扁平清单，好让 feedCard 用同一套渲染逻辑。
    var flat = [];
    var order = ['breakfast', 'lunch', 'dinner', 'snack', 'extra'];
    for (var i = 0; i < order.length; i++) {
      var list = meals[order[i]] || [];
      for (var j = 0; j < list.length; j++) {
        var it = list[j];
        flat.push({
          meal: order[i] === 'extra' ? 'snack' : order[i],
          name: it.name,
          amount: it.amount || '',
          kcal: it.kcal || 0, p: it.p || 0, f: it.f || 0, ch: it.ch || 0
        });
      }
    }
    return {
      id: 'srv_' + p.id,
      serverId: p.id,
      friendId: 'u' + p.userId,
      name: p.displayName || p.username || '好友',
      letter: String(p.displayName || p.username || '?').slice(0, 1),
      goalText: p.goalText || '',
      streak: p.streak || 0,
      date: p.date,
      seq: p.id,
      total: (p.totals && p.totals.kcal) || 0,
      entries: flat,
      photos: p.photos || [],
      rating: p.rating || { avg: 0, count: 0, mine: 0 },
      likes: p.likes || 0,
      likedByMe: !!p.likedByMe,
      comments: (p.comments || []).map(function (c) {
        return { id: 'srv_c' + c.id, who: c.displayName || '好友', text: c.text, ts: '', mine: false };
      })
    };
  }

  /* ------------------------------------------------------- 自动同步（后台）
   * 设计原则：**本地记录永远先落盘、不等网络**，服务器同步是后台补上的
   * 附加动作。所以每次记录、修改、删除之后延迟一小会儿就自动推一次，
   * 用户不需要手动点任何按钮；断网时静默失败，下次有改动或开 App 时重试。
   * ---------------------------------------------------------------------- */
  var SYNC_DEBOUNCE_MS = 1500;
  var syncTimer = null;      // 防抖定时器
  var syncInFlight = false;  // 正在发请求
  var syncPending = false;   // 请求途中又改了数据，发完要再发一次
  var syncRetryTimer = null; // 失败后的退避重试

  /** 当前有没有「已登录 + 填了地址 + 自动同步没被关掉」 */
  function autoSyncReady() {
    return !!(state.autoSync !== false && serverOn() && state.server.token && state.server.baseUrl);
  }

  /** 有记录变动时调用：防抖后自动上传当天记录 */
  function scheduleSync() {
    if (!autoSyncReady()) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      syncTimer = null;
      doBackgroundSync();
    }, SYNC_DEBOUNCE_MS);
  }

  /** 某一天的记录被改动过：打个本地时间戳，下次同步就会把它推上去 */
  function markDiaryDirty(date) {
    if (!date) return;
    state.diaryStamps[date] = Date.now();
  }

  function entriesOfDate(date) {
    return state.entries.filter(function (e) { return e.date === date; });
  }

  /** 本机比服务器新的那些天 */
  function dirtyDiaryDays() {
    var out = [];
    for (var date in state.diaryStamps) {
      if (!Object.prototype.hasOwnProperty.call(state.diaryStamps, date)) continue;
      if ((state.diaryStamps[date] || 0) > (state.diarySynced[date] || 0)) {
        out.push({ date: date, entries: entriesOfDate(date), updatedAt: state.diaryStamps[date] });
      }
    }
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out.slice(0, 400);
  }

  /** 把本机改动过的天推上去。失败就下次再说，不影响本机记录。 */
  function pushDirtyDiary() {
    if (!autoSyncReady()) return;
    var days = dirtyDiaryDays();
    if (!days.length) return;
    api.diaryPush(serverCfg(), days).then(function (res) {
      if (!res || res.error || res.offline) return;
      for (var i = 0; i < days.length; i++) {
        state.diarySynced[days[i].date] = days[i].updatedAt;
      }
      save();
    });
  }

  /**
   * 从服务器拉记录，按「谁的时间戳新谁赢」合并：
   *   * 服务器更新 → 用服务器那天的数据覆盖本机
   *   * 本机更新   → 保持本机，等 pushDirtyDiary 推上去
   *   * 本机有、服务器没有（老版本升级上来第一次登录）→ 标记待推，完成迁移
   */
  function pullDiary(silent, force) {
    if (!autoSyncReady()) return;
    if (!due('diary', force)) return;
    var to = today(), from = shiftDay(to, -400);
    api.diaryList(serverCfg(), from, to).then(function (res) {
      if (!res || res.error || res.offline || !res.data) return;
      var days = res.data.days || [];
      var changed = false;
      var serverDates = {};
      for (var i = 0; i < days.length; i++) {
        var d = days[i] || {};
        if (!d.date) continue;
        serverDates[d.date] = true;
        var serverAt = Number(d.updatedAt) || 0;
        var localAt = state.diaryStamps[d.date] || 0;
        var syncedAt = state.diarySynced[d.date] || 0;
        if (serverAt > localAt && serverAt > syncedAt) {
          state.entries = state.entries.filter(function (e) { return e.date !== d.date; })
            .concat(d.entries || []);
          state.diaryStamps[d.date] = serverAt;
          state.diarySynced[d.date] = serverAt;
          changed = true;
        } else if (serverAt > syncedAt) {
          state.diarySynced[d.date] = serverAt;
        }
      }
      // 本机有、服务器还没有的日期 —— 老版本升级上来的人，第一次登录就把记录整批迁上去
      var localDates = {};
      for (var k = 0; k < state.entries.length; k++) localDates[state.entries[k].date] = true;
      for (var dt in localDates) {
        if (!Object.prototype.hasOwnProperty.call(localDates, dt)) continue;
        if (serverDates[dt]) continue;
        if (!state.diaryStamps[dt]) {
          state.diaryStamps[dt] = Date.now();
          changed = true;
        }
      }
      if (changed) { save(); render(); }
      pushDirtyDiary();
      if (!silent) toast('记录已同步');
    });
  }

  /* 身体档案 + 体重：跟记录一样「本地先写，联网补推」。
     整块一起传，按 updatedAt 比新旧 —— 谁的改动更新听谁的；
     手机离线改也不会丢，下次有网自动补。 */
  function profilePayload() {
    return {
      body: state.body, weights: state.weights, goals: state.goals,
      goalsManual: state.goalsManual, bodyConfirmed: state.bodyConfirmed,
      custom: state.custom
    };
  }
  function markProfileDirty() {
    state.profileUpdatedAt = Date.now();
    save();
  }
  function pushProfile() {
    if (!autoSyncReady()) return;
    if (!(state.profileUpdatedAt > state.profileSyncedAt)) return;
    var at = state.profileUpdatedAt;
    api.profileSave(serverCfg(), profilePayload(), at).then(function (res) {
      if (res && !res.error && !res.offline && res.data && res.data.updatedAt) {
        state.profileSyncedAt = Number(res.data.updatedAt) || at;
        save();
      }
    });
  }
  function pullProfile(silent) {
    if (!autoSyncReady()) return;
    api.profileGet(serverCfg()).then(function (res) {
      if (!res || res.error || res.offline || !res.data) return;
      var at = Number(res.data.updatedAt) || 0;
      var d = res.data.data || null;
      if (at > state.profileUpdatedAt && d) {
        if (d.body) {
          for (var k in state.body) {
            if (d.body[k] !== undefined && d.body[k] !== null) state.body[k] = d.body[k];
          }
        }
        if (Array.isArray(d.weights)) state.weights = d.weights;
        // 自定义食物也在这份档案里：换手机/清数据之后还能回来
        if (Array.isArray(d.custom)) state.custom = d.custom;
        if (d.goals && typeof d.goals.kcal === 'number') state.goals = d.goals;
        if (typeof d.goalsManual === 'boolean') state.goalsManual = d.goalsManual;
        if (typeof d.bodyConfirmed === 'boolean') state.bodyConfirmed = d.bodyConfirmed;
        state.profileUpdatedAt = at;
        state.profileSyncedAt = at;
        save(); render();
        if (!silent) toast('身体档案已同步');
      } else if (state.profileUpdatedAt > (at || 0)) {
        pushProfile();
      }
    });
  }

  function doBackgroundSync() {
    if (!autoSyncReady()) return;
    // 先把记录本体推到服务器（换手机能还原），再发「动态」给好友看
    pushDirtyDiary();
    pushProfile();
    if (syncInFlight) { syncPending = true; return; }
    syncInFlight = true;
    if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
    var list = dayEntries(state.date);
    var t = sumEntries(list);
    var meals = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var key = (e.meal === 'preworkout' || e.meal === 'postworkout' || e.meal === 'latenight') ? 'extra' : e.meal;
      if (!meals[key]) meals[key] = [];
      meals[key].push({ name: e.name, amount: e.amount, kcal: e.kcal, p: e.p, f: e.f, ch: e.ch });
    }
    var date = state.date;
    api.publish(serverCfg(), {
      date: date, meals: meals,
      totals: { kcal: t.kcal, p: t.p, f: t.f, ch: t.ch },
      goalText: state.profile.goalText
    }).then(function (res) {
      syncInFlight = false;
      if (!res || res.error) {
        state.server.lastSyncOk = false;
        state.server.lastSyncAt = Date.now();
        save();
        // 免费实例会休眠，第一次常常超时；30 秒后再试一次，不加打扰
        syncRetryTimer = setTimeout(function () { syncRetryTimer = null; doBackgroundSync(); }, 30000);
        if (state.view === 'me' && sheetOpenOn('server')) render();
        if (syncPending) { syncPending = false; doBackgroundSync(); }
        return;
      }
      state.server.lastSyncOk = true;
      state.server.lastSyncAt = Date.now();
      save();
      if (state.view === 'me' && sheetOpenOn('server')) render();
      if (syncPending) { syncPending = false; doBackgroundSync(); }
    });
  }

  /** 浮层是否正开着某个标题（避免后台同步把用户正在看的其它浮层刷掉） */
  function sheetOpenOn(title) {
    var el = $('#sheet');
    return !!(el && el.classList.contains('show') && el.textContent.indexOf(title) >= 0);
  }

  /** 「上次同步」的人类可读说法 */
  function lastSyncText() {
    if (!state.server.lastSyncAt) return '还没有同步过';
    var d = new Date(state.server.lastSyncAt);
    var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    return (state.server.lastSyncOk === false ? '上次同步失败 · ' : '上次同步 ') + hh + ':' + mm;
  }

  /* ------------------------------------------------------------ 更新检查 */
  function compareVersion(a, b) {
    var x = String(a || '0').split('.'), y = String(b || '0').split('.');
    for (var i = 0; i < 3; i++) {
      var p = parseInt(x[i] || '0', 10) || 0, q = parseInt(y[i] || '0', 10) || 0;
      if (p > q) return 1;
      if (p < q) return -1;
    }
    return 0;
  }

  /**
   * 真实安装版本。装在手机上时读 PackageManager（bridge.versionCode()），
   * 浏览器里调试时退回打包时写死的常量，免得两边对不上时误报有新版本。
   */
  function appVersionCode() {
    if (bridge && bridge.versionCode) {
      var v = parseInt(bridge.versionCode(), 10);
      if (v > 0) return v;
    }
    return APP_VERSION_CODE;
  }
  function appVersionName() {
    if (bridge && bridge.versionName) {
      var s = String(bridge.versionName() || '');
      if (s) return s;
    }
    return APP_VERSION;
  }

  /**
   * 检查更新。从两个地方问「最新版本」，取版本号高的那个：
   *   1. 自建后端 /api/version（快、国内可达，但需要 Render 重新部署才更新）
   *   2. GitHub 上的 version.json（静态文件，push 完立刻生效，不需要部署）
   * 两边都问、取最大值，这样即使后端忘了部署也不会把新版本藏起来；
   * 而后者在国内被墙时，前者还能用。任何一边成功就够。
   */
  var VERSION_SOURCES = [
    VERSION_MANIFEST_URL,
    'https://raw.githubusercontent.com/yu10288201/dietdiary-server/main/version.json'
  ];

  // 给一个 Promise 套上硬超时：到点就当作「这份没拿到」。
  // 必须有这个 —— GitHub raw 在国内经常连不上，fetch 会一直挂着不回，
  // 没有超时的话「检查更新」就会半天没反应。
  function withTimer(p, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(null);
      }, ms);
      p.then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      }, function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(null);
      });
    });
  }

  function fetchOneManifest(url, ms) {
    var req = api.fetchJSON(url, { cache: 'no-store' }).then(function (res) {
      var j = res && res.data;
      return (j && j.android) || j || null;
    }).catch(function () { return null; });
    return withTimer(req, ms || 7000);
  }

  // 两份清单（后端 /api/version 与仓库里的 version.json）版本号打平时，
  // 取「带 sha256」的那份，并把对方缺的字段补上 —— 只有拿到指纹，安装前才能校验。
  // 版本号不同就整份取新的，绝不混着用，免得拿别版包的指纹去校验。
  function mergeManifest(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    var ac = parseInt(a.versionCode, 10);
    var bc = parseInt(b.versionCode, 10);
    if (isNaN(ac)) return b;
    if (isNaN(bc)) return a;
    if (ac !== bc) return ac > bc ? a : b;
    var out = {};
    var k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      if (out[k] === undefined || out[k] === null || out[k] === '' || out[k] === 0) out[k] = b[k];
    }
    return out;
  }

  function checkUpdate(opts) {
    opts = opts || {};
    var silent = opts.silent !== false;
    var cfg = serverCfg();
    // 手动点「检查更新」时先给个反馈，别让人以为点了没反应
    if (!silent) toast('正在检查更新…');

    var fetchManifest = function () {
      var all = [];
      for (var i = 0; i < VERSION_SOURCES.length; i++) all.push(fetchOneManifest(VERSION_SOURCES[i], 7000));
      return Promise.all(all).then(function (list) {
        // 取 versionCode 最大的那份；都没给 code 就取第一份有数据的
        var best = null;
        for (var k = 0; k < list.length; k++) best = mergeManifest(best, list[k]);
        if (!best) return { error: '拿不到版本信息：网络连不上，或服务器正在冷启动（免费实例要 30-60 秒）' };
        return { data: best };
      });
    };

    // 登录后以前只问后端 /api/version —— 那个接口当时不回 sha256，
    // 于是「下载下来的是旧包」没人拦。现在两边都问，谁先回谁算数：
    // 第一份能用之后再等 2 秒把另一份的指纹/大小补上，然后立刻返回，
    // 绝不等一个连不上的地址把整个检查卡死。
    var reqs = [];
    if (serverOn() || window.__demoServer) {
      reqs.push(withTimer(api.checkVersion(cfg, 'android').then(function (r) {
        return (r && !r.error && !r.offline) ? r.data : null;
      }).catch(function () { return null; }), 30000));
    }
    for (var si = 0; si < VERSION_SOURCES.length; si++) {
      reqs.push(fetchOneManifest(VERSION_SOURCES[si], 7000));
    }

    var p = new Promise(function (resolve) {
      var best = null;
      var settled = false;
      var grace = null;
      var used = 0;
      var hard = setTimeout(function () {
        finish(best ? { data: best } : { error: '检查超时：网络不通，或服务器正在冷启动。过一会儿再点一次。' });
      }, 33000);
      function finish(val) {
        if (settled) return;
        settled = true;
        if (grace) clearTimeout(grace);
        clearTimeout(hard);
        resolve(val);
      }
      function onOne(v) {
        used++;
        if (v) best = mergeManifest(best, v);
        if (!best) {
          if (used >= reqs.length) finish({ error: '拿不到版本信息：网络连不上，或服务器正在冷启动（免费实例要 30-60 秒）' });
          return;
        }
        if (!grace) {
          grace = setTimeout(function () { finish({ data: best }); }, 2000);
        }
      }
      for (var i = 0; i < reqs.length; i++) reqs[i].then(onOne, function () { onOne(null); });
    });
    return p.then(function (res) {
      // 自建后端挂了也不放弃，退回匿名清单再试一次
      if ((res.error || res.offline) && serverOn()) return fetchManifest();
      return res;
    }).then(function (res) {
      state.update.checkedAt = Date.now();
      save();
      if (res.error || res.offline || !res.data) {
        if (!silent) toast(res.error || '暂时检查不了更新');
        return null;
      }
      var info = res.data;
      state.update.latest = info;
      save();
      var curCode = appVersionCode();
      var curName = appVersionName();
      var rawCode = parseInt(info.versionCode, 10);
      var srvCode = isNaN(rawCode) ? null : rawCode;
      var srvName = info.versionName || info.version || '';
      // 只在服务器确实更高时才算有新版。用 versionCode 判方向最可靠；
      // 服务器没给 code 时退回比版本号字符串。方向搞反会让 App
      // 从新版"升级"回旧版，所以两个判断都必须严格大于。
      var newer = srvCode !== null
        ? srvCode > curCode
        : (srvName ? compareVersion(srvName, curName) > 0 : false);
      if (!newer) {
        if (!silent) toast('已是最新版本 v' + curName);
        return null;
      }
      showUpdateSheet(info);
      return info;
    });
  }

  function showUpdateSheet(info) {
    var ver = info.versionName || info.version || '新版';
    var body = '<div class="update-hero"><div class="v">v' + esc(ver) + '</div>' +
      '<div class="small muted">当前 v' + esc(appVersionName()) + ' · ' + (info.force ? '需要更新后才能继续用' : '可以稍后再更新') + '</div></div>';
    if (info.notes) {
      body += '<div class="card" style="margin:12px 0"><div class="card-head"><h2>更新内容</h2></div>' +
        '<div class="small">' + esc(info.notes).replace(/\n/g, '<br>') + '</div></div>';
    }
    if (info.size && !isWebApp()) body += '<div class="small muted mb12">安装包 ' + Math.round(info.size / 1024) + ' KB · 覆盖安装不会丢记录</div>';
    // 版本号也摆出来：出问题时能一眼看出「是包下错了」还是「手机的版本号判断不对」
    var mine = appVersionCode();
    var theirs = parseInt(info.versionCode, 10);
    body += '<div class="small muted mb12">版本号：' + (isWebApp() ? '网页版' : '手机上') + ' <b>' + mine + '</b>' +
      (isNaN(theirs) ? '' : ' · 新版本 <b>' + theirs + '</b>') + '</div>';
    body += '<div class="small muted">' +
      (isWebApp()
        ? '网页版：新版本部署到服务器后，刷新页面就是最新的，不用装安装包。'
        : '安装方式：点「下载并安装」→ 系统会打开安装器，允许本次安装即可（自签名包的正常提示）。') +
      '</div>';

    var foot = (info.force ? '' : '<button class="btn ghost" data-act="update-later">稍后</button>') +
      '<button class="btn" data-act="update-install">下载并安装</button>';
    if (isWebApp()) {
      // 网页版没有安装器：新版本在服务器上，刷新即用；想装安卓包就走下载
      foot = (info.force ? '' : '<button class="btn ghost" data-act="update-later">稍后</button>') +
        '<button class="btn" data-act="open-apk">下载安卓安装包</button>';
    }
    openSheet('发现新版本', body, foot);
  }

  /** 关于页：应用名 / 图标 / 版本 / 包名，顺带放「检查更新」入口 */
  function aboutLogo() {
    return '<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="108" height="108" fill="#4F7F52"/>' +
      '<path d="M31,58c0,-13.8 10.3,-25 23,-25s23,11.2 23,25z" fill="#F4D9A8"/>' +
      '<path d="M56,20l4.8,2.9 -15.8,31.6 -4.8,-2.9z" fill="#E4BE92"/>' +
      '<path d="M66.5,26l4.8,2.9 -15.8,31.6 -4.8,-2.9z" fill="#E4BE92"/>' +
      '<path d="M20,54h68c0,19.3 -15.2,35 -34,35s-34,-15.7 -34,-35z" fill="#FFFFFF"/>' +
      '<path d="M45,90h18v6h-18z" fill="#FFFFFF"/>' +
      '</svg>';
  }
  function openAbout() {
    // 上一次更新的结果（走的哪个地址、多大、包内版本号、已装版本号）。
    // 更新出问题时这一行就是现场记录，截图即可定位。
    var lastLog = '';
    try { lastLog = (bridge && bridge.lastUpdateLog) ? String(bridge.lastUpdateLog() || '') : ''; } catch (e) { lastLog = ''; }
    var body = '<div class="about">' +
      '<div class="logo">' + aboutLogo() + '</div>' +
      '<div class="nm">' + esc(APP_NAME) + '</div>' +
      '<div class="en">SHI KE · 记录每一餐</div>' +
      '<div class="v">版本 v' + esc(appVersionName()) + '（' + appVersionCode() + '）</div>' +
      '</div>' +
      (lastLog
        ? '<div class="small muted" style="line-height:1.6;margin-bottom:10px">' +
          '上次更新：' + esc(lastLog) + '</div>'
        : '') +
      '<div class="small muted" style="line-height:1.7">' +
      '「食刻」= 食 + 时刻：既指「到点吃饭的这一刻」，也指记录饮食的每一刻。<br>' +
      '记录、身体档案、自定义食物都跟着账号存在服务器上（Turso + Render），' +
      '换手机登录同一个账号就能接上。' +
      '</div>';
    openSheet('关于', body,
      '<button class="btn ghost" data-act="update-check">检查更新</button>' +
      '<button class="btn" data-act="close-sheet">好</button>');
  }

  // 同一个安装包在两个地方都有：
  //   1. 仓库静态文件（GitHub raw）—— push 完就生效，但国内可能连不上
  //   2. 后端 /api/download/apk —— 国内更稳，但要等 Render 部署完才有新包
  // 主地址失败或指纹对不上就自动换备用，两个互相兜底。
  // 下载顺序：后端优先，GitHub 静态文件当备胎。
  // 反过来试过：国内连 raw.githubusercontent.com 会一直挂到超时才换地址，
  // 用户看到的就是「下载中…」几分钟不动。
  var APK_URL_RAW = 'https://raw.githubusercontent.com/yu10288201/dietdiary-server/main/public/shike.apk';

  // GitHub raw 有最长 5 分钟的 CDN 缓存：刚发完版那几分钟可能还会给出上一个包，
  // 结果就是「提示 0.4.1、装上去还是 0.4.0」。加一个跟版本号走的参数强制绕缓存。
  function withVersionQuery(url, code) {
    if (!url) return url;
    if (/[?&]v=/.test(url)) return url;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'v=' + encodeURIComponent(String(code || Date.now()));
  }

  function apkBackendUrl() {
    var cfg = serverCfg();
    var base = (cfg && cfg.baseUrl ? cfg.baseUrl : DEFAULT_SERVER).replace(/\/+$/, '');
    return base + '/api/download/apk';
  }

  function doUpdateInstall() {
    var info = state.update.latest || {};
    var manifestUrl = info.url || (info.android && info.android.url) || '';
    var code = info.versionCode || appVersionCode();
    var backend = apkBackendUrl();
    // 清单里给的地址可能是后端也可能是静态文件，反正先试后端那条。
    var primary = (manifestUrl && manifestUrl.indexOf('/api/download/apk') >= 0) ? manifestUrl : backend;
    var fb = (manifestUrl && manifestUrl !== primary) ? manifestUrl : APK_URL_RAW;
    if (fb === primary) fb = '';
    if (!primary) { toast('这次更新没有下载地址'); return; }
    var url = withVersionQuery(primary, 'v' + code);
    var fbUrl = fb ? withVersionQuery(fb, 'v' + code) : '';
    state.update.dismissed = Date.now();
    save();
    if (bridge && bridge.installApk) {
      // 按钮文案跟着时间升级：Render 免费实例冷启动要 30-60 秒，
      // 只写「下载中…」用户会以为卡死了。
      function setBtn(text, enabled) {
        var b = $('#sheet [data-act="update-install"]');
        if (!b) return;
        b.textContent = text;
        if (typeof enabled === 'boolean') b.disabled = !enabled;
      }
      setBtn('下载中…', false);
      var t1 = setTimeout(function () { setBtn('下载中…（服务器在冷启动，可能要等半分钟）', false); }, 12000);
      var t2 = setTimeout(function () { setBtn('还没下完，网络不好可以稍后再试', false); }, 60000);
      var t3 = setTimeout(function () { setBtn('下载超时，重新点一次再试', true); }, 180000);
      // 有指纹就一定会校验：下到的包跟清单对不上，Java 那边会丢掉再换备用地址，
      // 两个都不对就报错，不会把旧版本装上。
      toast(info.sha256 ? '开始下载更新包，会核对指纹后再安装' : '开始下载更新包，完成后会弹系统安装器');
      try {
        bridge.installApk(url, fbUrl, info.sha256 || '');
      } catch (e) {
        clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
        setBtn('下载并安装', true);
        toast('无法启动安装器');
      }
      return;
    }
    // 浏览器里调试时直接开新页
    try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
    toast('已在浏览器打开下载地址');
  }
  function openFriend(id) {
    var f = null;
    for (var i = 0; i < state.friends.length; i++) if (state.friends[i].id === id) f = state.friends[i];
    if (!f) return;
    state.view = 'social';
    state.feedTab = 'feed';
    // 定位到这个好友最近的一条动态（列表是按日期倒序排的）
    var mine = state.posts.filter(function (p) { return p.friendId === id; })
      .sort(function (a, b) { return (a.date < b.date) ? 1 : (a.date > b.date ? -1 : 0); });
    state.socialFocus = mine.length ? ('post-' + mine[0].id) : null;
    render();
    toast(mine.length ? ('已定位到 ' + f.name + ' 的动态') : (f.name + ' 还没有发布动态'));
  }

  /* ------------------------------------------------- 身体档案 / 目标计算 */
  // 活动系数（乘在基础代谢上）。名字短一点，弹层里放得下。
  var ACTIVITY = [
    { id: 'sed', name: '久坐（几乎不动）', k: 1.2 },
    { id: 'light', name: '轻度（1-3 次/周）', k: 1.375 },
    { id: 'mid', name: '中度（3-5 次/周）', k: 1.55 },
    { id: 'high', name: '高强度（6-7 次/周）', k: 1.725 }
  ];
  // 目标：热量按百分比增减，蛋白按 g/kg 体重走。
  var GOAL_TYPES = [
    { id: 'cut', name: '减脂', pct: -0.2, pro: 2.0 },
    { id: 'mildcut', name: '轻微减重', pct: -0.1, pro: 1.8 },
    { id: 'keep', name: '保持', pct: 0, pro: 1.6 },
    { id: 'mildgain', name: '轻微增重', pct: 0.1, pro: 1.7 },
    { id: 'gain', name: '增重', pct: 0.2, pro: 1.8 }
  ];
  function activityById(id) {
    for (var i = 0; i < ACTIVITY.length; i++) if (ACTIVITY[i].id === id) return ACTIVITY[i];
    return ACTIVITY[1];
  }
  function goalTypeById(id) {
    for (var i = 0; i < GOAL_TYPES.length; i++) if (GOAL_TYPES[i].id === id) return GOAL_TYPES[i];
    return GOAL_TYPES[2];
  }
  /**
   * 米夫林-斯蒂尔杰尔公式：
   *   男 10w + 6.25h − 5a + 5 ／ 女 10w + 6.25h − 5a − 161
   * 比旧的哈里斯-本尼迪克特准，是目前最通用的估算式。
   */
  function bmr() {
    var b = state.body;
    return 10 * b.weight + 6.25 * b.height - 5 * b.age + (b.sex === 'm' ? 5 : -161);
  }
  function tdee() { return bmr() * activityById(state.body.activity).k; }
  function goalKcal() { return Math.round(tdee() * (1 + goalTypeById(state.body.goal).pct)); }
  /** 热量定下来以后按 g/kg 拆三大营养素，碳水吃剩下的。 */
  function macrosFor(kcal, kg, proPerKg) {
    var p = Math.round(kg * proPerKg);
    var f = Math.round(kg * 0.9);
    var c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
    return { kcal: Math.round(kcal), p: p, c: c, f: f };
  }
  /** 只读一遍身体档案，重算每日目标。手动改过目标的不动（除非 force）。 */
  function recalcGoals(force) {
    var b = state.body;
    if (!b.weight || !b.height || !b.age) return false;
    if (!force && state.goalsManual) return false;
    state.goals = macrosFor(goalKcal(), b.weight, goalTypeById(b.goal).pro);
    save();
    return state.goals;
  }
  function openBodySheet() {
    var b = state.body;
    var body = '<div class="num-grid">' +
      '<div class="field"><label>性别</label><select class="input" id="bd-sex">' +
      '<option value="f"' + (b.sex === 'f' ? ' selected' : '') + '>女</option>' +
      '<option value="m"' + (b.sex === 'm' ? ' selected' : '') + '>男</option></select></div>' +
      '<div class="field"><label>年龄</label><input class="input" id="bd-age" type="number" inputmode="numeric" value="' + b.age + '"></div>' +
      '<div class="field"><label>身高 cm</label><input class="input" id="bd-h" type="number" inputmode="decimal" value="' + b.height + '"></div>' +
      '<div class="field"><label>体重 kg</label><input class="input" id="bd-w" type="number" inputmode="decimal" step="0.1" value="' + b.weight + '"></div>' +
      '</div>' +
      '<div class="field"><label>活动水平</label><select class="input" id="bd-act">' +
      ACTIVITY.map(function (a) {
        return '<option value="' + a.id + '"' + (a.id === b.activity ? ' selected' : '') + '>' + a.name + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>目标</label><select class="input" id="bd-goal">' +
      GOAL_TYPES.map(function (g) {
        var pct = g.pct === 0 ? '保持' : (g.pct > 0 ? '+' : '') + Math.round(g.pct * 100) + '%';
        return '<option value="' + g.id + '"' + (g.id === b.goal ? ' selected' : '') + '>' + g.name + '（' + pct + '）</option>';
      }).join('') + '</select></div>' +
      '<div class="small muted">保存后按<b>米夫林-斯蒂尔杰尔</b>公式重算每日热量：基础代谢 × 活动系数 ' +
      '× 目标调整，再按体重系数拆三大营养素。之前手动改过的目标会被重新覆盖。</div>';
    openSheet('身体档案', body,
      '<button class="btn ghost" data-act="cancel">取消</button><button class="btn" data-act="save-body">保存</button>');
  }
  function saveBody() {
    var sheet = $('#sheet');
    var age = parseFloat($('#bd-age', sheet).value);
    var h = parseFloat($('#bd-h', sheet).value);
    var w = parseFloat($('#bd-w', sheet).value);
    if (!age || age < 10 || age > 100) { toast('年龄看起来不对'); return; }
    if (!h || h < 100 || h > 250) { toast('身高看起来不对'); return; }
    if (!w || w < 25 || w > 300) { toast('体重看起来不对'); return; }
    state.body = {
      sex: $('#bd-sex', sheet).value,
      age: age,
      height: h,
      weight: w,
      activity: $('#bd-act', sheet).value,
      goal: $('#bd-goal', sheet).value
    };
    state.goalsManual = false;
    state.bodyConfirmed = true;
    var g = recalcGoals(true);
    markProfileDirty();
    save(); closeSheet(); render();
    toast(g ? ('目标已重算：' + g.kcal + ' kcal') : '已保存');
  }
  /** 最近一条体重记录（含今天）。 */
  function latestWeight() {
    if (!state.weights.length) return null;
    var s = state.weights.slice().sort(function (a, b) { return a.d < b.d ? 1 : -1; });
    return s[0].kg;
  }
  function openWeightSheet() {
    var body = '<div class="field"><label>体重 kg</label>' +
      '<input class="input" id="wt-kg" type="number" inputmode="decimal" step="0.1" ' +
      'value="' + (latestWeight() || state.body.weight) + '"></div>' +
      '<div class="small muted">记在 ' + state.date + '。同一天再记一次会覆盖。</div>';
    openSheet('记录体重', body,
      '<button class="btn ghost" data-act="cancel">取消</button><button class="btn" data-act="save-weight">保存</button>');
  }
  function saveWeight() {
    var sheet = $('#sheet');
    var kg = parseFloat($('#wt-kg', sheet).value);
    if (!kg || kg < 25 || kg > 300) { toast('体重看起来不对'); return; }
    kg = Math.round(kg * 10) / 10;
    var d = state.date;
    state.weights = state.weights.filter(function (x) { return x.d !== d; });
    state.weights.push({ d: d, kg: kg });
    state.weights.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    state.body.weight = kg;
    state.goalsManual = false;
    state.bodyConfirmed = true;
    recalcGoals(true);
    markProfileDirty();
    save(); closeSheet(); render(); toast('已记录 ' + kg + ' kg');
  }
  /** 体重折线：只画最近 14 个点，纵向自适应，两个点以上才画线。 */
  function weightCurve() {
    var w = state.weights.slice(-14);
    if (w.length < 2) {
      return '<div class="small muted mt8">记两次以上就能看到趋势线。</div>';
    }
    var W = 300, H = 76, pad = 8;
    var min = Math.min.apply(null, w.map(function (x) { return x.kg; }));
    var max = Math.max.apply(null, w.map(function (x) { return x.kg; }));
    if (max - min < 0.6) { max = min + 0.6; }
    var pts = w.map(function (x, i) {
      var px = pad + (W - 2 * pad) * (i / (w.length - 1));
      var py = H - pad - (H - 2 * pad) * ((x.kg - min) / (max - min));
      return px.toFixed(1) + ',' + py.toFixed(1);
    }).join(' ');
    return '<svg class="wcurve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--brand)" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '</svg>' +
      '<div class="wcurve-x"><span>' + w[0].d.slice(5) + '</span><span>' + w[w.length - 1].d.slice(5) + '</span></div>';
  }

  /* -------------------------------------------------------------- dialogs */
  function editGoals() {
    var g = state.goals;
    var body = '<div class="field"><label>每日热量目标（kcal）</label><input class="input" id="g-kcal" type="number" value="' + g.kcal + '"></div>' +
      '<div class="num-grid">' +
      '<div class="field"><label>蛋白 g</label><input class="input" id="g-p" type="number" value="' + g.p + '"></div>' +
      '<div class="field"><label>碳水 g</label><input class="input" id="g-c" type="number" value="' + g.c + '"></div>' +
      '</div>' +
      '<div class="field"><label>脂肪 g</label><input class="input" id="g-f" type="number" value="' + g.f + '"></div>' +
      '<div class="quick">' +
      [['减脂 1500', 1500, 110, 150, 50], ['保持 2000', 2000, 110, 250, 65], ['增肌 2800', 2800, 150, 350, 85]]
        .map(function (p) { return '<button data-act="preset" data-v="' + p.slice(1).join(',') + '">' + p[0] + '</button>'; }).join('') +
      '</div>';
    var sheet = openSheet('修改每日目标', body, '<button class="btn" data-act="save-goals">保存</button>');
    bindSheet('click', function (ev) {
      var t = ev.target.closest('[data-act="preset"]');
      if (!t) return;
      var v = t.getAttribute('data-v').split(',');
      $('#g-kcal', sheet).value = v[0]; $('#g-p', sheet).value = v[1];
      $('#g-c', sheet).value = v[2]; $('#g-f', sheet).value = v[3];
    });
  }
  function saveGoals() {
    var sheet = $('#sheet');
    state.goals = {
      kcal: parseFloat($('#g-kcal', sheet).value) || 2000,
      p: parseFloat($('#g-p', sheet).value) || 110,
      c: parseFloat($('#g-c', sheet).value) || 250,
      f: parseFloat($('#g-f', sheet).value) || 65
    };
    // 手动填过就不再让身体档案自动覆盖（想恢复就去「身体档案」里保存一次）。
    state.goalsManual = true;
    markProfileDirty();
    save(); closeSheet(); render(); toast('目标已更新');
  }

  function pickDate() {
    var body = '<div class="field"><label>选择日期</label><input class="input" id="pd" type="date" value="' + state.date + '"></div>' +
      '<div class="quick">' +
      '<button data-act="pd-jump" data-d="0">今天</button>' +
      '<button data-act="pd-jump" data-d="-1">昨天</button>' +
      '<button data-act="pd-jump" data-d="-2">前天</button>' +
      '</div>';
    var sheet = openSheet('跳到某天', body, '<button class="btn" data-act="save-date">确定</button>');
    bindSheet('click', function (ev) {
      var t = ev.target.closest('[data-act="pd-jump"]');
      if (!t) return;
      $('#pd', sheet).value = shiftDay(today(), parseInt(t.getAttribute('data-d'), 10));
    });
  }

  function editProfile() {
    var body = '<div class="field"><label>昵称</label><input class="input" id="p-name" value="' + esc(state.profile.name) + '"></div>' +
      '<div class="field"><label>状态签名</label><input class="input" id="p-goal" value="' + esc(state.profile.goalText) + '"></div>';
    openSheet('编辑资料', body, '<button class="btn" data-act="save-profile">保存</button>');
  }

  /* --------------------------------------------------------------- events */
  function handleAction(act, el, ev) {
    switch (act) {
      case 'tab':
        // 离开食物库就把「自定义食物」重新收起来：用户要的是默认收起，
        // 展开只是这一会儿的动作，不该跟着人一直挂在页面上。
        if (state.view === 'foods' && el.getAttribute('data-tab') !== 'foods') state.customOpen = false;
        state.view = el.getAttribute('data-tab');
        syncHash();
        render();
        window.scrollTo(0, 0);
        // 切标签时顺手把这一页需要的服务器数据补一次（节流在 due() 里，
        // 来回点不会把同一个请求打很多遍）。以前什么都不拉，所以「切过去
        // 还是老数据，得退出去重进」。
        if (state.view === 'social') {
          if (state.feedTab === 'photos') pullPhotoFeed(false);
          else refreshSocial(false);
        }
        else if (state.view === 'today') { pullDiary(true); }
        else if (state.view === 'me') { pullProfile(true); }
        break;
      case 'pick-date': {
        var dd = el.getAttribute('data-date');
        if (dd) { state.date = dd; render(); }
        else pickDate();
        break;
      }
      case 'add-food':
        openAddFood(el.getAttribute('data-meal'));
        break;
      case 'new-food':
        openNewFood();
        break;
      case 'recognize':
        openRecognizeSheet();
        break;
      case 'recog-pick': {
        // 必须是用户点的那一下里触发，否则部分 WebView 会拦掉「非用户手势」的文件选择
        var rf = $('#recog-file');
        if (rf) rf.click();
        break;
      }
      case 'recog-meal': {
        var rm = el.getAttribute('data-m');
        if (!rm) break;
        picker.meal = rm;
        $$('[data-act="recog-meal"]').forEach(function (b) {
          var on = b.getAttribute('data-m') === rm;
          b.style.background = on ? 'var(--brand)' : '';
          b.style.color = on ? 'var(--brand-ink)' : '';
          b.style.borderColor = on ? 'var(--brand)' : '';
        });
        // 只改「全部加进…」那几个字，不重画整块 —— 重画会让刚选的照片闪一下
        var allBtn = $('[data-act="recog-all"]');
        if (allBtn) allBtn.textContent = '全部加进' + mealName(rm);
        break;
      }
      case 'recog-force': {
        // 用户看过「有点糊/太暗」的提醒，仍然要发 —— 图早就压好了，直接发
        if (!recogPending) { toast('没有待识别的照片，重新选一张'); break; }
        var ro = $('#recog-out');
        if (ro) sendRecognize(recogPending, ro);
        break;
      }
      case 'recog-item': {
        var ri = Number(el.getAttribute('data-i'));
        var item = recogOut && recogOut.items[ri];
        if (!item) break;
        picker.draft = aiDraft(item);
        openPortionSheet(false);
        break;
      }
      case 'recog-all':
        addAllAi();
        break;
      /* 断网/超时后重发那张存下来的图。同一个 clientId 服务端认得出，
         就算上次其实已经到了服务器，这次也只是把结果拿回来，不多扣次数。 */
      case 'recog-retry': {
        var again = recogPending || loadPendingPhoto();
        var rOut = $('#recog-out');
        if (!again) { toast('那张图已经不在了，重新拍一张吧'); break; }
        if (!rOut) break;
        sendRecognize(again, rOut);
        break;
      }
      case 'recog-drop':
        savePendingPhoto('');
        recogPending = null;
        closeSheet();
        toast('已经丢掉那张照片');
        break;
      /* 识别这条路走不通时，别把用户堵在死胡同里：直接转手动记一条，餐次带过去。 */
      case 'recog-manual':
        closeSheet();
        openAddFood(picker.meal);
        break;
      case 'pick':
        beginEntry(el.getAttribute('data-name'));
        break;
      case 'food-detail': {
        var nm = el.getAttribute('data-name');
        var f = allFoods()[nm];
        if (!f) break;
        var body = '<div class="preview"><div class="cell"><div class="v">' + r0(f.e) + '</div><div class="k">kcal / 100g</div></div>' +
          '<div class="cell"><div class="v" style="color:var(--c-pro)">' + f1(f.p) + '</div><div class="k">蛋白 g</div></div>' +
          '<div class="cell"><div class="v" style="color:#B08900">' + f1(f.ch) + '</div><div class="k">碳水 g</div></div>' +
          '<div class="cell"><div class="v" style="color:var(--c-fat)">' + f1(f.f) + '</div><div class="k">脂肪 g</div></div></div>' +
          '<div class="small muted">分类：' + esc(f.c) + ' · 常用份量：1' + esc(f.u) + ' ≈ ' + f.w + 'g</div>';
        var fav = state.favorites.indexOf(nm) >= 0;
        openSheet(nm, body,
          '<button class="btn ghost" data-act="fav" data-name="' + esc(nm) + '">' + (fav ? '取消收藏' : '加入常吃') + '</button>' +
          '<button class="btn" data-act="pick" data-name="' + esc(nm) + '">记一笔</button>');
        break;
      }
      case 'fav': {
        var n2 = el.getAttribute('data-name');
        if (state.favorites.indexOf(n2) >= 0) state.favorites = state.favorites.filter(function (x) { return x !== n2; });
        else state.favorites.push(n2);
        save(); closeSheet(); render(); toast('已更新常吃');
        break;
      }
      case 'fav-toggle':
        favOnly = !favOnly; render();
        break;
      case 'cat': {
        var cat = el.getAttribute('data-cat');
        if ($('#pick-list')) { foodsFilter.pickCat = cat; $('#pick-list').innerHTML = pickListHtml($('#pick-search').value, cat); }
        else { foodsFilter.cat = cat; render(); }
        $$('.chip').forEach(function (c) { if (c.getAttribute('data-cat') === cat) c.classList.add('on'); else c.classList.remove('on'); });
        break;
      }
      case 'confirm-entry': confirmEntry(); break;
      case 'delete-entry': deleteEntry(picker.draft.id); break;
      case 'save-food': saveNewFood(); break;
      case 'nf-mode': setNewFoodMode(el.getAttribute('data-mode'), $('#sheet')); break;
      case 'cancel': closeSheet(); break;
      // 引导页（独立整页）
      case 'ob-login': doOnboard(false); break;
      case 'ob-register': doOnboard(true); break;
      case 'ob-mode': {
        // 切「注册 / 登录」前把已填的内容存下来，免得重画页面把它清掉
        obDraft.user = ($('#ob-user') && $('#ob-user').value) || '';
        obDraft.pass = ($('#ob-pass') && $('#ob-pass').value) || '';
        obDraft.name = ($('#ob-name') && $('#ob-name').value) || '';
        obDraft.url = ($('#ob-url') && $('#ob-url').value) || '';
        obMode = el.getAttribute('data-mode') === 'login' ? 'login' : 'register';
        renderOnboarding();
        break;
      }
      case 'ob-server':
        obDraft.url = ($('#ob-url') && $('#ob-url').value) || '';
        obServerOpen = !obServerOpen;
        renderOnboarding();
        break;
      case 'edit-entry': {
        var id = el.getAttribute('data-id');
        var e = state.entries.filter(function (x) { return x.id === id; })[0];
        if (e) openAddFood(e.meal, e);
        break;
      }
      case 'edit-goals': editGoals(); break;
      case 'save-goals': saveGoals(); break;
      case 'edit-body': openBodySheet(); break;
      case 'save-body': saveBody(); break;
      case 'log-weight': openWeightSheet(); break;
      case 'save-weight': saveWeight(); break;
      case 'save-date': {
        var v = $('#pd').value;
        if (v) { state.date = v; }
        closeSheet(); render();
        break;
      }
      case 'edit-profile': editProfile(); break;
      case 'save-profile':
        state.profile.name = $('#p-name').value || '我';
        state.profile.goalText = $('#p-goal').value || '保持';
        state.profile.letter = state.profile.name.slice(0, 1);
        save(); closeSheet(); render(); toast('资料已保存');
        break;
      case 'set-theme':
        state.theme = el.getAttribute('data-id');
        window.applyTheme(state.theme, state.mode);
        save(); render();
        // 在主题浮层里点的，就把浮层重画一遍，勾选状态立刻反映出来
        if ($('#sheet').classList.contains('show') && $('#sheet [data-act="set-theme"]')) openThemeSheet();
        break;
      case 'settings':
        openSettings();
        break;
      case 'open-theme':
        openThemeSheet();
        break;
      case 'toggle-custom':
        // 只影响这一次浏览：不落盘，下次进食物库还是收起的。
        // （用户说「食物库里会显示自定义食物 这个默认收起」，展开更像临时动作。）
        state.customOpen = !state.customOpen;
        render();
        break;
      case 'toggle': {
        if (el.getAttribute('data-key') === 'dark') {
          state.mode = state.mode === 'dark' ? 'light' : 'dark';
          window.applyTheme(state.theme, state.mode);
          save(); render();
          if ($('#sheet').classList.contains('show') && $('#sheet [data-act="open-theme"]')) openSettings();
        } else if (el.getAttribute('data-key') === 'goal') {
          toast('练前/练后/夜宵餐次已开启');
        }
        break;
      }
      case 'trend-mode':
        state.trendMode = el.getAttribute('data-mode') === 'month' ? 'month' : 'week';
        render();
        window.scrollTo(0, 0);
        break;
      case 'month-shift': {
        var dir = parseInt(el.getAttribute('data-d'), 10) || 1;
        var next = shiftMonth(state.month, dir);
        if (next > today().slice(0, 7)) break;
        state.month = next;
        render();
        break;
      }
      case 'day-detail':
        openDayDetail(el.getAttribute('data-date'));
        break;
      case 'goto-day':
        state.date = el.getAttribute('data-date');
        state.month = state.date.slice(0, 7);
        state.view = 'today';
        syncHash();
        closeSheet();
        render();
        window.scrollTo(0, 0);
        break;
      case 'server':
        openServerSheet();
        break;
      case 'server-save':
        readServerUrl();
        closeSheet();
        render();
        toast(state.server.baseUrl ? '服务器地址已保存' : '已清空服务器地址');
        if (state.server.baseUrl && state.server.token) refreshFeed();
        break;
      case 'server-login': doServerLogin(false); break;
      case 'server-register': doServerLogin(true); break;
      case 'server-logout':
      case 'logout-account':
        doLogout(); closeSheet(); toast('已退出登录');
        break;
      case 'switch-account':
        doLogout(); closeSheet(); openServerSheet();
        toast('已退出，登录另一个账号');
        break;
      case 'server-sync':
        closeSheet();
        toast('正在同步…');
        doBackgroundSync();
        refreshFeed();
        break;
      case 'update-check':
        checkUpdate({ silent: false });
        break;
      case 'about': openAbout(); break;
      case 'close-sheet': closeSheet(); break;
      case 'update-install': doUpdateInstall(); break;
      case 'open-apk':
        // 网页版没有安装器：直接把安装包交给浏览器下载（Android 上就是下载→安装）
        location.href = apkBackendUrl();
        break;
      case 'update-later':
        state.update.dismissed = Date.now();
        save(); closeSheet();
        break;
      case 'feed-tab':
        state.feedTab = el.getAttribute('data-tab');
        save();
        render();
        if (state.feedTab === 'photos') pullPhotoFeed(false);
        break;
      /* ---------------------------------------------------------- 照片墙 */
      case 'wall-pick':
        openWallComposer('');
        break;
      case 'wall-choose': {
        var wf = $('#wall-file');
        if (wf) wf.click();     // 必须在用户手势里触发，setTimeout 之后会被拦
        break;
      }
      case 'wall-import': {
        var recent = loadRecentPhotos();
        var ri = Number(el.getAttribute('data-i'));
        if (!recent[ri]) { toast('这张已经不在本地了'); break; }
        openWallComposer(recent[ri]);
        break;
      }
      case 'wall-day': {
        wallDay = el.getAttribute('data-d') === 'yesterday' ? 'yesterday' : 'today';
        // 只换选中态，不重画面板（重画会把已经选好的图弄丢）
        var dayBtns = document.querySelectorAll('[data-act="wall-day"]');
        for (var di = 0; di < dayBtns.length; di++) {
          dayBtns[di].className = (dayBtns[di].getAttribute('data-d') === wallDay) ? 'on' : '';
        }
        break;
      }
      case 'wall-send':
        sendWallPhoto();
        break;
      case 'wall-more':
        loadMorePhotos();
        break;
      case 'wall-open':
        openWallPhoto(el.getAttribute('data-id'));
        break;
      case 'photo-like':
        photoLike();
        break;
      case 'photo-rate':
        photoRate(Number(el.getAttribute('data-s')) || 0);
        break;
      case 'photo-comment':
        photoComment();
        break;
      case 'photo-cmt-del':
        delPhotoComment(Number(el.getAttribute('data-id')));
        break;
      case 'wall-cap':
        openCaptionEditor();
        break;
      case 'cap-save':
        saveCaption();
        break;
      case 'wall-del':
        deleteWallPhoto(Number(el.getAttribute('data-id')));
        break;
      case 'like': {
        var p = state.posts.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
        if (!p) break;
        p.likedByMe = !p.likedByMe;
        p.likes += p.likedByMe ? 1 : -1;
        render();
        if (p.serverId && serverOn() && state.server.token) {
          api.like(serverCfg(), p.serverId).then(function (res) {
            if (res.error || !res.data) { toast('点赞没同步上去'); return; }
            p.likedByMe = !!res.data.liked;
            if (typeof res.data.likes === 'number') p.likes = res.data.likes;
            render();
          });
        }
        break;
      }
      case 'toggle-comments': {
        var pid = el.getAttribute('data-id');
        state.expanded[pid] = !state.expanded[pid];
        render();
        if (state.expanded[pid]) {
          var inp = document.getElementById('cmt-' + pid);
          if (inp) inp.focus();
        }
        break;
      }
      case 'send-comment': {
        var pid2 = el.getAttribute('data-id');
        var input = document.getElementById('cmt-' + pid2);
        var text = (input.value || '').trim();
        if (!text) { toast('写点内容吧'); break; }
        var post = state.posts.filter(function (x) { return x.id === pid2; })[0];
        if (post) {
          post.comments.push({ id: uid(), who: state.profile.name, text: text, ts: '刚刚', mine: true });
          // 服务器端评论成功后会用返回的 id 覆盖，失败也不回滚本机那条
          if (post.serverId && serverOn() && state.server.token) {
            api.comment(serverCfg(), post.serverId, text).then(function (res) {
              if (res.error) { toast('评论没同步上去'); return; }
              var c = res.data && res.data.comment;
              var mine = post.comments[post.comments.length - 1];
              if (c && mine) mine.id = 'srv_c' + c.id;
              toast('评论已发送');
            });
          } else {
            toast('评论已发布（本机演示）');
          }
        }
        render();
        break;
      }
      case 'cheer': {
        var cid = el.getAttribute('data-id');
        var cp = state.posts.filter(function (x) { return x.id === cid; })[0];
        if (cp && cp.serverId && serverOn() && state.server.token) {
          api.cheer(serverCfg(), cp.serverId).then(function (res) {
            toast(res.error ? '催更没发出去' : '已催 ' + (cp ? cp.name : '好友') + ' 更新今天的三餐');
          });
        } else {
          toast('已送出鼓励 👍（本机演示）');
        }
        break;
      }
      case 'rate': {
        var rp = state.posts.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
        if (!rp) break;
        openRateSheet(rp);
        break;
      }
      case 'rate-set': {
        var rsid = el.getAttribute('data-id');
        var stars = Number(el.getAttribute('data-s')) || 0;
        var tp = state.posts.filter(function (x) { return x.id === rsid; })[0];
        if (!tp) break;
        if (!tp.serverId || !serverOn() || !state.server.token) {
          tp.rating = { avg: stars || 0, count: stars ? 1 : 0, mine: stars };
          closeSheet(); render();
          toast(stars ? '已打 ' + stars + ' 星（本机演示）' : '已取消打分');
          break;
        }
        api.ratePost(serverCfg(), tp.serverId, stars).then(function (res) {
          if (res && res.error) { toast(res.error); return; }
          var rr = res && res.data && res.data.rating;
          if (rr) tp.rating = rr;
          closeSheet();
          render();
          toast(stars ? '已打 ' + stars + ' 星' : '已取消打分');
        });
        break;
      }
      case 'open-photo':
        openPhotoView(el.getAttribute('data-url'), el.getAttribute('data-cap'));
        break;
      case 'recog-photo':
        savePhotoToFeed(recogOut && recogOut.small);
        break;
      case 'open-friend':
        openFriend(el.getAttribute('data-id'));
        break;
      case 'refresh-social':
        if (!serverOn() || !state.server.token) { toast('先登录服务器才能刷新'); break; }
        toast('正在刷新…');
        if (state.feedTab === 'photos') { pullPhotoFeed(true); toast('已刷新'); break; }
        refreshSocial(true).then(function () { toast('已刷新'); }, function () { toast('刷新失败，网络好像不通'); });
        break;
      case 'add-friend': {
        var conn = serverOn() && state.server.token;
        var body = conn
          ? '<div class="field"><label>对方的 ID</label><input class="input" id="af" placeholder="6 位短号，如 7F3K2M"></div>' +
            '<div class="small muted">让朋友在「我的」页看一眼自己的 ID 报给你。填用户名也能加（老账号兼容）。</div>'
          : '<div class="field"><label>好友昵称 / 邀请码</label><input class="input" id="af" placeholder="输入邀请码，如 8F2K9Q"></div>' +
            '<div class="small muted">还没连接服务器，先加个本地示例好友。到「我的 → 社交服务器」填上地址，就能加真实好友。</div>';
        openSheet('添加好友', body,
          '<button class="btn" data-act="' + (conn ? 'add-friend-real' : 'fake-add') + '">' +
          (conn ? '发送好友请求' : '添加') + '</button>');
        break;
      }
      case 'add-friend-real': {
        var uname = ($('#af').value || '').trim();
        if (!uname) { toast('填一下对方的 ID'); break; }
        // 看着像 6 位短号就按 ID 加；不是就退回按用户名加（老账号还能用）
        var looksUid = /^#?[A-Za-z0-9]{6}$/.test(uname);
        var send = looksUid
          ? api.addFriendByUid(serverCfg(), uname)
          : api.addFriend(serverCfg(), uname);
        send.then(function (res) {
          if (res.error && looksUid) {
            // 6 位但查不到人 —— 可能其实是个 6 字符的老用户名，再给一次机会
            api.addFriend(serverCfg(), uname).then(function (r2) {
              if (r2.error) { toast(r2.error); return; }
              closeSheet(); render(); toast('好友请求已发出，等对方同意');
            });
            return;
          }
          if (res.error) { toast(res.error); return; }
          closeSheet();
          render();
          toast('好友请求已发出，等对方同意');
          refreshFriendRequests(true);
        });
        break;
      }
      case 'accept-friend':        answerFriendRequest(Number(el.getAttribute('data-id')), true);
        break;
      case 'reject-friend':
        answerFriendRequest(Number(el.getAttribute('data-id')), false);
        break;
      case 'copy-uid': {
        var myId = state.server.uid || '';
        if (!myId) { toast('登录后会分配一个 6 位 ID'); break; }
        var okCopy = false;
        try {
          var ta = document.createElement('textarea');
          ta.value = myId;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          okCopy = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) { okCopy = false; }
        toast(okCopy ? '已复制 ID：' + myId : '我的 ID 是 ' + myId);
        break;
      }
      case 'fake-add': {
        var code = ($('#af').value || '').trim() || '新好友';
        state.friends.push({
          id: 'f_' + uid(), name: code.slice(0, 6), letter: code.slice(0, 1).toUpperCase(),
          goalText: '刚加入', streak: 0, online: true
        });
        save(); closeSheet(); render(); toast('已添加好友：' + code);
        break;
      }
      case 'invite':
        toast('邀请链接已复制（demo 占位）');
        break;
      case 'profile':
        state.view = 'me'; render();
        break;
      case 'fav':
        break;
      case 'export': {
        var json = JSON.stringify({ entries: state.entries, custom: state.custom });
        try {
          if (bridge && bridge.set) bridge.set('export', json);
          else localStorage.setItem('dietdiary.export', json);
        } catch (err) { /* ignore */ }
        toast('已导出 ' + state.entries.length + ' 条记录（本地）');
        break;
      }
      case 'reset': {
        var body = '<div class="small muted">会清空这台手机上的<b>全部饮食记录和收藏</b>，' +
          '并<b>退出当前账号</b>，然后重新走一遍注册引导。' +
          '<br><br><b>自定义食物会保留</b> —— 那是你自己一样样填的，删了得重填；' +
          '想清掉它们请到「食物库 → 我的自定义食物」里逐个删。' +
          '<br><br>记录本身清完就没了（同一个账号重新登录后，服务器上已有的那份还会拉回来）。</div>';
        openSheet('清空并重新开始？', body,
          '<button class="btn ghost" data-act="cancel">取消</button>' +
          '<button class="btn danger" data-act="reset-yes">确认清空</button>');
        break;
      }
      case 'reset-yes':
        resetEverything();
        break;
      default: break;
    }
  }

  /**
   * 「清空并重新开始」：把本机状态恢复成刚装好 App 的样子 ——
   * 记录/自定义食物/收藏/好友全清，退出账号，连引导标记一起重置，
   * 然后立刻弹回注册引导。老版本装过来的人手里带着当年的演示数据，
   * 覆盖安装又不会删本地数据（那是为了不丢记录），所以必须留一个显式的出口。
   */
  function resetEverything() {
    // 自定义食物是用户自己一样样填出来的，清空记录不该把它们一起删掉
    var keepCustom = state.custom.slice();
    emptyState();
    state.custom = keepCustom;
    state.onboarded = false;
    state.server = { baseUrl: DEFAULT_SERVER, token: '', userId: null, uid: '', displayName: '' };
    state.diaryStamps = {};
    state.diarySynced = {};
    state.profile = { name: '我', letter: '我', goalText: '保持', streak: 0 };
    state.body = { sex: 'f', age: 25, height: 165, weight: 60, activity: 'light', goal: 'keep' };
    state.weights = [];
    state.goalsManual = false;
    state.bodyConfirmed = false;
    state.profileUpdatedAt = 0;
    state.profileSyncedAt = 0;
    state.update = { checkedAt: 0, latest: null, dismissed: 0 };
    state.view = 'today';
    state.date = today();
    save();
    closeSheet();
    render();
    showOnboarding();
    toast('已清空，重新开始');
  }

  function bind() {
    document.addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-act]');
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'toggle' && el.tagName === 'INPUT') return;
      if (act === 'toggle') {
        var inner = el.querySelector('input[data-act="toggle"]');
        if (inner && ev.target !== inner && !ev.target.classList.contains('slider')) {
          inner.checked = !inner.checked;
        }
      }
      handleAction(act, el, ev);
    });
    document.addEventListener('change', function (ev) {
      var el = ev.target.closest('[data-act="toggle"]');
      if (el && el.tagName === 'INPUT') handleAction('toggle', el.parentNode.parentNode, ev);
    });
    // 食物库的搜索框：只重绘列表那一块，不重绘整个页面 ——
    // 否则每敲一个字输入框就被换掉，焦点和光标都会丢。
    // 重绘合并到下一帧：238 种食物时打字快，一个字一次全量重排会掉帧。
    var foodsSearchTick = 0;
    document.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || el.id !== 'food-search') return;
      foodsFilter.q = el.value;
      if (foodsSearchTick) return;
      foodsSearchTick = requestAnimationFrame(function () {
        foodsSearchTick = 0;
        var box = $('#foods-body');
        if (box) box.innerHTML = foodsBodyHtml();
      });
    });
    $('#scrim').addEventListener('click', closeSheet);
    // The FAB lives in index.html, not in a render() string, so its icon has to
    // be injected once here. Without it the button is a bare green circle.
    $('#fab').innerHTML = svg('plus');
    $('#fab').addEventListener('click', function () {
      if (state.view === 'foods') openNewFood();
      else openAddFood(pickNextMeal());
    });
    document.addEventListener('focusin', function (ev) {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') {
        setTimeout(function () { ev.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 250);
      }
    });
    window.__onAndroidBack = function () {
      if ($('#sheet').classList.contains('show')) { closeSheet(); return true; }
      if (state.view !== 'today') { state.view = 'today'; render(); return true; }
      return false;
    };
    /* 安卓壳在「相机没把照片存下来」时会主动喊一声：网页这边收不到 change 事件，
     * 不喊就只能看着按钮发呆。 */
    window.__onPhotoFail = function (msg) {
      toast(msg || '这张图没拿到，换一张试试');
    };
  }

  function pickNextMeal() {
    var h = new Date().getHours();
    if (h < 10) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snack';
  }

  /* ---------------------------------------------------------------- boot */
  // Views are reflected in location.hash (e.g. #foods) so a reload keeps the
  // tab the user was on; the app is a single page either way.
  function syncHash() {
    var want = '#' + state.view;
    if (location.hash !== want) {
      try { history.replaceState(null, '', want); } catch (e) { location.hash = want; }
    }
  }

  function viewFromHash() {
    var v = (location.hash || '').replace(/^#/, '');
    var ids = TABS.map(function (t) { return t[0]; });
    return ids.indexOf(v) >= 0 ? v : null;
  }

  function boot() {
    load();
    // Query flags are read from a snapshot: ?skipOnboarding=1 rewrites the URL
    // via history.replaceState to clean the query out of the address bar, and
    // reading location.search afterwards would silently lose every other flag.
    var search = location.search || '';
    if (/[?&]skipOnboarding=1/.test(search)) {
      // 跳过引导（截图/自测用）：只是不再弹注册页，不会造任何数据
      state.onboarded = true;
      state.autoSync = false;
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    }
    var fromHash = viewFromHash();
    if (fromHash) state.view = fromHash;
    // Deep-linkable theme/mode, used by the screenshot tooling and by anyone who
    // wants to share a look: ?theme=ocean&dark=1 / ?dark=0
    var themeQ = /[?&]theme=([a-z]+)/.exec(search);
    if (themeQ && window.themeById(themeQ[1])) state.theme = themeQ[1];
    // 主题从 8 套减到 6 套：老用户存的 matcha / coral 已经不存在了，
    // 不归一化的话「我的」页里一个都不高亮，配色也会退回默认。
    var known = window.ACCENTS.map(function (a) { return a.id; });
    if (known.indexOf(state.theme) < 0) state.theme = known[0];
    if (themeQ) state.month = today().slice(0, 7);
    var darkQ = /[?&]dark=([01])/.exec(search);
    if (darkQ) state.mode = darkQ[1] === '1' ? 'dark' : 'light';
    window.applyTheme(state.theme, state.mode);
    bind();
    syncHash();
    render();
    if (!state.onboarded) showOnboarding();
    // 启动 4 秒后静默查一次更新（每 12 小时最多一次），有新版才弹浮层
    var stale = Date.now() - (state.update.checkedAt || 0) > 12 * 3600 * 1000;
    if (stale && !/[?&]debug=1/.test(search)) setTimeout(function () { checkUpdate({ silent: true }); }, 4000);
    // 登录状态下开 App 就补一次当天记录的同步：上次退出时可能没网，或者
    // 记录是在另一台设备上改的。静默进行，失败会自己退避重试。
    if (autoSyncReady() && !/[?&]debug=1/.test(search)) {
      // 以前是 3s / 5s / 5.5s / 6.5s 一串错开的定时器，等于打开 App 后
      // 六七秒才开始有数据。现在基本同时发（节流表保证不会重复打），
      // 冷启动时也能第一屏就把请求放出去。
      setTimeout(function () { doBackgroundSync(); }, 400);
      setTimeout(function () { pullDiary(true); }, 600);
      setTimeout(function () { pullProfile(true); }, 900);
      setTimeout(function () { refreshFriendRequests(true); }, 1200);
      if (!window.__reqTimer) {
        window.__reqTimer = setInterval(function () {
          if (serverOn() && state.server.token) {
            refreshFriendRequests(true);
            pullFriends('');       // 对方同意了，我这边最多 60 秒就能看到
          }
        }, 60000);
      }
    }
    // 已登录的话顺手把短号补到本地（老版本存的 server 里没有 uid）
    if (autoSyncReady() && !state.server.uid && !/[?&]debug=1/.test(search)) {
      setTimeout(function () {
        api.me(serverCfg()).then(function (res) {
          if (!res || res.error || !res.data || !res.data.user) return;
          state.server.uid = res.data.user.uid || '';
          if (state.server.uid) { save(); if (state.view === 'me') render(); }
        });
      }, 1200);
    }
    // ?debug=1&sheet=<portion|picker|newfood|goals|profile|onboarding|server|day|update>
    // lets the headless-Chrome visual checks photograph a sheet; ignored otherwise.
    if (/[?&]debug=1/.test(search) && window.__diet) {
      var sm = /[?&]sheet=([a-z]+)/.exec(search);
      var fm = /[?&]food=([^&]+)/.exec(search);
      if (sm) window.__diet.sheet(sm[1], fm ? decodeURIComponent(fm[1]) : null);
    }
  }

  /**
   * 首次打开 App 的引导页：一个盖住整个 App 的独立整页。
   * 目前是强制要求 —— 必须注册或登录才能进主界面（没有「先随便看看」）。
   * 注册成功后立刻把手机连上服务器，不用再去「我的 → 社交服务器」填地址。
   */
  var obMode = 'register';   // 'register' | 'login'
  var obServerOpen = false;  // 服务器地址默认收起
  var obDraft = { user: '', pass: '', name: '', url: '' };

  function showOnboarding() {
    var box = $('#onboard');
    if (!box) return;
    obMode = 'register';
    obServerOpen = false;
    obDraft = { user: '', pass: '', name: '', url: '' };
    box.classList.remove('hidden');
    document.body.classList.add('no-scroll');
    renderOnboarding();
  }

  function hideOnboarding() {
    var box = $('#onboard');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    document.body.classList.remove('no-scroll');
  }

  function obHost(u) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(String(u || ''));
    return m ? m[1] : String(u || '');
  }

  function renderOnboarding() {
    var box = $('#onboard');
    if (!box) return;
    var isReg = obMode === 'register';
    var url = obDraft.url || state.server.baseUrl || DEFAULT_SERVER;

    var html = '<div class="ob-inner">';
    html += '<div class="ob-mark">食</div>';
    html += '<div class="ob-brand"><h1>' + (isReg ? '先建个账号' : '欢迎回来') + '</h1>';
    html += '<div class="ob-sub">' + (isReg
      ? '记录、每日目标、好友都在账号里，换手机登录就还在。'
      : '用注册时的用户名和密码登录，记录会从服务器拉回这台手机。') + '</div></div>';

    html += '<div class="ob-tabs">' +
      '<button class="ob-tab' + (isReg ? ' on' : '') + '" data-act="ob-mode" data-mode="register">注册</button>' +
      '<button class="ob-tab' + (!isReg ? ' on' : '') + '" data-act="ob-mode" data-mode="login">登录</button>' +
      '</div>';

    html += '<div class="ob-form">';
    html += '<div class="field"><label>用户名</label>' +
      '<input class="input" id="ob-user" autocomplete="username" placeholder="3-24 位字母或数字" value="' + esc(obDraft.user) + '"></div>';
    html += '<div class="field"><label>密码</label>' +
      '<input class="input" id="ob-pass" type="password" autocomplete="' + (isReg ? 'new-password' : 'current-password') +
      '" placeholder="至少 6 位" value="' + esc(obDraft.pass) + '"></div>';
    if (isReg) {
      html += '<div class="field"><label>昵称（好友看到的名字）</label>' +
        '<input class="input" id="ob-name" placeholder="不填就用用户名" value="' + esc(obDraft.name) + '"></div>';
    }
    html += '</div>';

    html += '<button class="btn ob-submit" data-act="' + (isReg ? 'ob-register' : 'ob-login') + '">' +
      (isReg ? '注册并登录' : '登录') + '</button>';

    html += '<div class="ob-server">' +
      '<button class="ob-link" data-act="ob-server">' +
      (obServerOpen ? '收起服务器地址' : '服务器：' + esc(obHost(url)) + '（可改）') + '</button>' +
      '<div class="ob-server-body' + (obServerOpen ? '' : ' hidden') + '">' +
      '<div class="field"><label>服务器地址</label>' +
      '<input class="input" id="ob-url" value="' + esc(url) + '"></div></div></div>';

    html += '<div class="ob-foot">' + esc(APP_NAME) + ' 把记录存在你的账号上，不再只存在这台手机里。' +
      '免费服务器第一次唤醒可能要几十秒，点下去请稍等一下。</div>';
    html += '</div>';

    box.innerHTML = html;
  }

  /**
   * 引导页的注册/登录。成功后：写入 token → 连接服务器 → 拉一次好友动态，
   * 也就是用户说的「注册登录后就顺便把浏览器也连上去」。
   */
  function doOnboard(isRegister) {
    var url = window.dietApi.trimBase($('#ob-url') ? $('#ob-url').value : '') || DEFAULT_SERVER;
    var user = ($('#ob-user') && $('#ob-user').value || '').trim();
    var pass = ($('#ob-pass') && $('#ob-pass').value || '');
    var name = ($('#ob-name') && $('#ob-name').value || '').trim();
    if (!user) { toast('先填用户名'); return; }
    if (pass.length < 6) { toast('密码至少 6 位'); return; }
    state.server.baseUrl = url;
    toast('连接服务器中…（免费实例唤醒要几十秒）');
    var cfg = serverCfg();
    var call = isRegister
      ? api.register(cfg, user, pass, name || user)
      : api.login(cfg, user, pass);
    call.then(function (res) {
      if (!res || res.offline) { toast((res && res.error) || '连不上服务器'); return; }
      if (res.error) { toast(res.error); return; }
      var u = (res.data && res.data.user) || {};
      state.server.token = res.data.token;
      state.server.userId = u.id || null;
      state.server.uid = u.uid || '';
      state.server.displayName = u.displayName || user;
      state.profile.name = state.server.displayName;
      state.profile.letter = String(state.server.displayName).slice(0, 1);
      state.onboarded = true;
      state.autoSync = true;
      save();
      obDraft = { user: '', pass: '', name: '', url: '' };
      obMode = 'register';
      hideOnboarding();
      render();
      toast(isRegister ? '注册成功，已登录' : '登录成功');
      // 登进来就把记录同步走（本机推上去 + 服务器上的拉下来）
      pullDiary(true, true);
      pullProfile(true);
      pullFriends('', true);
      // 连上了才去拉动态；这一步失败也不该把用户卡在引导页
      refreshFeed();
      refreshFriendRequests(true, true);
    });
  }

  /**
   * 网页版（PWA）：把界面外壳注册成 Service Worker，断网也能打开。
   * APK 里是 file:// 打开的资源，navigator.serviceWorker 注册会失败，所以先判协议。
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    try {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 没 SW 也能用 */ });
    } catch (e) { /* 忽略：不影响使用 */ }
  }
  registerServiceWorker();

  window.__onAndroidBack = function () { return false; };

  /* Screenshot/QA hook, only wired up when the page is opened with ?debug=1
   * (used by the headless-Chrome visual checks). Never exposed otherwise. */
  if (/[?&]debug=1/.test(location.search)) {
    window.__diet = {
      state: state,
      flush: flushSave,
      saveNow: saveNow,
      matchFood: matchFood,
      aiDraft: aiDraft,
      /* 出错了怎么提示、以及「断网时把图存下来」这条退路，也要能被测到 */
      recogErrHtml: recogErrHtml,
      recogListHtml: recogListHtml,
      sendRecognize: sendRecognize,
      loadPendingPhoto: loadPendingPhoto,
      /* B 需求（备注/价格/吃了多少）与 A 组（EXIF/清晰度）的纯函数，给 jsdom 测试用 */
      eatenOf: eatenOf,
      eatLabel: eatLabel,
      spentOf: spentOf,
      money: money,
      monthSpendText: monthSpendText,
      exifOrientation: exifOrientation,
      qualityHint: qualityHint,
      /* 动态里的照片与打分：渲染函数和上传入口都单独暴露，免得测试去摸真实网络 */
      photoStrip: photoStrip,
      rateButton: rateButton,
      openRateSheet: openRateSheet,
      openPhotoView: openPhotoView,
      savePhotoToFeed: savePhotoToFeed,
      /* 照片墙：渲染 + 「最近拍的」本地缓存，测试用假数据直接断言 HTML */
      photoWallHtml: photoWallHtml,
      loadRecentPhotos: loadRecentPhotos,
      pushRecentPhoto: pushRecentPhoto,
      dropRecentPhoto: dropRecentPhoto,
      setPhotoFeed: function (list, hasMore) {
        photoFeed = list || [];
        photoHasMore = !!hasMore;
        photoFetchedAt = Date.now();
      },
      wallSend: function (img, cap, day) { wallImage = img || ''; wallDay = day || 'today'; sendWallPhoto(); },
      /* 照片详情：点开后的那一页（点赞 / 打分 / 评论 / 文案） */
      openWallPhoto: openWallPhoto,
      photoDetailBody: photoDetailBody,
      photoStarsHtml: photoStarsHtml,
      photoLike: photoLike,
      photoRate: photoRate,
      photoComment: photoComment,
      delPhotoComment: delPhotoComment,
      saveCaption: saveCaption,
      openCaptionEditor: openCaptionEditor,
      getPhotoCur: function () { return photoCur; },
      getPhotoFeed: function () { return photoFeed; },
      view: function (v) { state.view = v; syncHash(); render(); },
      sheet: function (which, arg) {
        if (which === 'portion') beginEntry(arg || '鸡胸肉');
        else if (which === 'picker') openPickerSheet();
        else if (which === 'newfood') openNewFood();
        else if (which === 'goals') editGoals();
        else if (which === 'profile') editProfile();
        else if (which === 'onboarding' || which === 'onboard') { state.onboarded = false; showOnboarding(); }
        else if (which === 'server') openServerSheet();
        else if (which === 'day') openDayDetail(arg || state.date);
        else if (which === 'update') showUpdateSheet({
          versionName: appVersionName(), code: appVersionCode(), notes: '新增月视图与日期详情；食物图标全部独立；好友动态排行榜移除。', size: 62000, url: 'https://example.com/x.apk'
        });
        else if (which === 'about') openAbout();
        else if (which === 'settings') openSettings();
        else if (which === 'themepick' || which === 'theme-sheet') openThemeSheet();
        else if (which === 'up-to-date') { checkUpdate({ silent: false }); }
        else if (which === 'close') closeSheet();
        var el = document.querySelector('#sheet');
        return !!el && el.innerHTML.length;
      },
      theme: function (id, mode) { state.theme = id; state.mode = mode || state.mode; window.applyTheme(state.theme, state.mode); save(); render(); },
      /* 测试用：手动触发一次拉取，验证「对方同意后我这边能补上好友」 */
      refresh: function (which) {
        if (which === 'social') return refreshSocial(true);
        if (which === 'requests') return refreshFriendRequests(true, true);
        if (which === 'friends') return pullFriends('', true);
        return refreshSocial(true);
      },
      counts: function () {
        return { foods: window.FOODS.length, entries: state.entries.length, custom: state.custom.length, view: state.view };
      },
      /* 装在手机上时读 PackageManager，浏览器里退回打包常量 */
      version: function () { return { code: appVersionCode(), name: appVersionName() }; },
      /* 截图用：假装已经连上 Turso + Render，并拉一次好友动态。
         同时填几天像样的记录，否则截图全是空页面 —— 这纯粹是截图工具，
         真实用户首启永远是空的（load() 里不再预置任何数据）。 */
      demoServer: function () {
        window.__demoServer = true;
        state.server.baseUrl = DEFAULT_SERVER;
        state.server.token = 'demo-token';
        state.server.userId = 1;
        state.server.displayName = '我';
        // 让「自动同步」那一行看起来是刚同步过的样子（截图用）
        state.server.lastSyncOk = true;
        state.server.lastSyncAt = Date.now();
        this.demoData();
        save();
        refreshFeed();
        return true;
      },
      /* 截图用：铺 8 天真实记录（走和手动记录完全相同的 makeEntry/recalc） */
      demoData: function () {
        var plan = [
          [0, [['breakfast', '全麦面包', 2, '片'], ['breakfast', '鸡蛋', 2, '个'],
               ['breakfast', '牛奶（全脂）', 1, '杯'], ['breakfast', '蓝莓', 60, '克'],
               ['lunch', '米饭（熟）', 1, '碗'], ['lunch', '宫保鸡丁', 1.5, '份'], ['lunch', '清炒时蔬', 1, '份'],
               ['snack', '苹果', 1, '个'],
               ['dinner', '鸡胸肉', 150, '克'], ['dinner', '西兰花', 150, '克'], ['dinner', '红薯', 1, '个']]],
          [1, [['breakfast', '燕麦片（干）', 50, '克'], ['breakfast', '希腊酸奶', 1, '杯'], ['breakfast', '香蕉', 1, '个'],
               ['lunch', '藜麦（熟）', 1, '碗'], ['lunch', '鸡胸肉', 130, '克'], ['lunch', '牛油果', 0.5, '个'],
               ['postworkout', '鸡胸肉', 100, '克'], ['postworkout', '米饭（熟）', 1, '碗'],
               ['dinner', '鳕鱼', 150, '克'], ['dinner', '西兰花', 200, '克'], ['dinner', '橄榄油', 1, '勺']]],
          [2, [['breakfast', '全麦面包', 2, '片'], ['breakfast', '鸡蛋', 3, '个'],
               ['lunch', '米饭（熟）', 1, '碗'], ['lunch', '番茄炒蛋', 1, '份'], ['lunch', '虾仁', 150, '克'],
               ['snack', '酸奶（原味）', 1, '杯'],
               ['dinner', '意大利面（熟）', 1, '碗'], ['dinner', '三文鱼', 130, '克'], ['dinner', '蔬菜沙拉', 1, '份']]],
          [3, [['breakfast', '燕麦片（干）', 60, '克'], ['breakfast', '牛奶（全脂）', 1, '杯'], ['breakfast', '苹果', 1, '个'],
               ['lunch', '米饭（熟）', 1.5, '碗'], ['lunch', '红烧肉', 1, '份'], ['lunch', '清炒时蔬', 1, '份'],
               ['snack', '薯片', 1, '袋'],
               ['dinner', '炸鸡（带皮）', 1, '份'], ['dinner', '薯条', 1, '份'], ['dinner', '可乐', 1, '罐']]],
          [4, [['breakfast', '鸡蛋', 2, '个'], ['breakfast', '香蕉', 1, '个'],
               ['lunch', '鸡胸肉', 120, '克'], ['lunch', '西兰花', 150, '克'],
               ['dinner', '红薯', 1, '个'], ['dinner', '酸奶（原味）', 1, '杯']]],
          [5, [['breakfast', '全麦面包', 2, '片'], ['breakfast', '花生酱', 2, '勺'], ['breakfast', '香蕉', 1, '个'],
               ['lunch', '米饭（熟）', 1.5, '碗'], ['lunch', '牛肉（瘦）', 150, '克'], ['lunch', '清炒时蔬', 1, '份'],
               ['snack', '苹果', 1, '个'],
               ['dinner', '意大利面（熟）', 1, '碗'], ['dinner', '虾仁', 150, '克'], ['dinner', '橄榄油', 1, '勺']]],
          [6, [['breakfast', '燕麦片（干）', 50, '克'], ['breakfast', '希腊酸奶', 1, '杯'], ['breakfast', '蓝莓', 80, '克'],
               ['lunch', '米饭（熟）', 1, '碗'], ['lunch', '鸡腿肉', 150, '克'], ['lunch', '西兰花', 150, '克'],
               ['snack', '酸奶（原味）', 1, '杯'],
               ['dinner', '红薯', 1, '个'], ['dinner', '鸡胸肉', 120, '克'], ['dinner', '蔬菜沙拉', 1, '份']]],
          [7, [['breakfast', '鸡蛋', 2, '个'], ['breakfast', '牛奶（全脂）', 1, '杯'], ['breakfast', '全麦面包', 2, '片'],
               ['lunch', '米饭（熟）', 1, '碗'], ['lunch', '三文鱼', 120, '克'], ['lunch', '蔬菜沙拉', 1, '份'],
               ['dinner', '鸡胸肉', 140, '克'], ['dinner', '西兰花', 150, '克'], ['dinner', '红薯', 1, '个']]]
        ];
        var foods = allFoods();
        var added = [];
        for (var d = 0; d < plan.length; d++) {
          var date = shiftDay(today(), -plan[d][0]);
          var picks = plan[d][1];
          for (var i = 0; i < picks.length; i++) {
            var p = picks[i];
            var food = foods[p[1]];
            if (!food) continue;
            var unit = p[3];
            var grams = (unit === '克') ? p[2] : p[2] * gramsPerUnit(food.n, unit);
            var e = makeEntry(date, food, p[0], grams, unit, p[2]);
            recalc(e);
            state.entries.push(e);
            if (plan[d][0] === 0) added.push(food.n);
          }
        }
        state.favorites = ['鸡胸肉', '西兰花', '鸡蛋', '米饭（熟）'];
        state.recent = added.slice(0, 8);
        state.profile.streak = plan.length;
        invalidateFoods();
        render();
        return state.entries.length;
      },
      /* 截图/联调用：让「检查更新」走完整流程，看装着的这版会不会提示新版。
         默认值必须**从当前版本算出来**，不能写死——写死的话每次发版把
         versionCode 一改，它就变成「和本机同号」，于是只会回一句
         「已是最新版本」，这个调试入口就悄悄失效了（真踩过）。 */
      checkUpdateDemo: function (payload) {
        var nextCode = appVersionCode() + 1;
        var seg = String(appVersionName()).split('.');
        var nextName = seg.length === 3
          ? seg[0] + '.' + seg[1] + '.' + (parseInt(seg[2], 10) + 1)
          : nextCode + '.0.0';
        window.__demoServer = true;
        window.__demoVersion = payload || {
          versionCode: nextCode, versionName: nextName,
          notes: '演示用的更新说明：这里会显示这次改了什么。',
          size: 62000, url: 'https://example.com/shike-' + nextName + '.apk',
          sha256: 'demo', force: false
        };
        return checkUpdate({ silent: false });
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

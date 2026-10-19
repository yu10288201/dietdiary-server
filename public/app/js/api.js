/* =========================================================================
 * api.js - 社交后端客户端 + 更新检查
 *
 * 后端是 Turso（数据库）+ Render（Node 服务）的免费组合，接口契约见
 * server/README.md。没有配服务器地址时，App 完全用本地示例数据，所有
 * 网络函数直接返回 {offline:true}，UI 不报错。
 *
 * 注意：Render 免费实例 15 分钟无流量会休眠，冷启动要 30-60 秒，
 * 所以默认超时给到 25 秒，并且第一次失败后会提示「服务器唤醒中」。
 * ========================================================================= */
(function (root) {
  'use strict';

  // 15 秒：Render 免费实例唤醒通常 30-60 秒，但那不该让界面白等 ——
  // 超时后 request() 会自动把超时放宽一倍再试一次，用户看到的是「转一下就好」。
  var TIMEOUT_MS = 15000;

  function trimBase(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/+$/, '');
  }

  /* ------------------------------------------------------------ 演示模式
   * 截图和离线演示要展示「已连接真实后端」的样子，但又不能真的依赖一台
   * 跑着的 Render 实例。打开 __demoServer 后，请求不发出网络，直接返回
   * 一份形状和后端完全一致的假数据。
   * ---------------------------------------------------------------------- */
  function demoReply(path, opts) {
    var demoProfile = null;
    var demoProfileAt = 0;
    var LIKES = ['鸡胸肉', '西兰花', '鸡蛋', '牛油果', '三文鱼', '希腊酸奶', '蓝莓', '燕麦片（干）'];
    function pick(n, off) {
      var out = [];
      for (var i = 0; i < n; i++) out.push(LIKES[(off + i) % LIKES.length]);
      return out;
    }
    function mealsOf(names, kcal) {
      var per = kcal / names.length;
      var split = { breakfast: names.slice(0, 2), lunch: names.slice(2, 5), dinner: names.slice(5) };
      var meals = { breakfast: [], lunch: [], dinner: [], snack: [], extra: [] };
      Object.keys(split).forEach(function (k) {
        meals[k] = split[k].map(function (nm) {
          return { name: nm, amount: '1 份', kcal: Math.round(per), p: 12, f: 6, ch: 22 };
        });
      });
      return meals;
    }
    var people = [
      { id: 2, username: 'anna', displayName: 'Anna', avatarColor: '#4DB6AC', goalText: '减脂中' },
      { id: 3, username: 'leo', displayName: '李奥', avatarColor: '#7986CB', goalText: '增肌期' },
      { id: 4, username: 'momo', displayName: '沫沫', avatarColor: '#F06292', goalText: '保持' }
    ];
    var today = new Date();
    var dstr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
    var kcal = [1480, 2610, 1720];

    if (path.indexOf('/api/recognize/status') === 0) {
      return { data: { ok: true, enabled: true, mock: false, model: 'demo', remainingToday: 5, dailyLimit: 5 } };
    }
    if (path.indexOf('/api/recognize') === 0) {
      // 离线演示：假装看了一张「一荤一素加碗饭」的桌子。
      // 第三条故意用库里没有的名字，好把「AI 估算」这条分支也演示出来。
      return {
        data: {
          ok: true, model: 'demo', remainingToday: 4, dailyLimit: 5, elapsedMs: 900, note: '演示数据',
          items: [
            { name: '米饭', grams: 200, kcal100: 116, protein100: 2.6, fat100: 0.3, carbs100: 25.9, confidence: 'high' },
            { name: '番茄炒蛋', grams: 180, kcal100: 120, protein100: 6, fat100: 8, carbs100: 6, confidence: 'mid' },
            { name: '清蒸鲈鱼', grams: 150, kcal100: 105, protein100: 18.6, fat100: 3.4, carbs100: 0, confidence: 'low' }
          ]
        }
      };
    }
    if (path.indexOf('/api/friends/requests') === 0) {
      // 演示数据里放一条待处理请求，好让「接受 / 拒绝」这条链在无网络时也能看到
      return {
        data: {
          incoming: [{
            id: 9001, status: 'pending', createdAt: Date.now(),
            user: { id: 91, uid: 'AB12CD', username: 'newbie', displayName: '新朋友', avatarColor: '#F0763B', goalText: '想一起记录' }
          }],
          outgoing: []
        }
      };
    }
    if (path.indexOf('/api/friends/accept') === 0 || path.indexOf('/api/friends/reject') === 0) {
      return { data: { ok: true } };
    }
    if (path.indexOf('/api/friends') === 0 && (opts.method || 'GET') === 'GET') {
      return { data: { friends: people } };
    }
    if (path.indexOf('/api/feed') === 0) {
      var posts = people.map(function (u, i) {
        return {
          id: 100 + i, userId: u.id, username: u.username, displayName: u.displayName,
          avatarColor: u.avatarColor, date: dstr, goalText: u.goalText,
          meals: mealsOf(pick(8, i * 3), kcal[i]),
          totals: { kcal: kcal[i], p: 132 + i * 9, f: 54 + i * 6, ch: 210 + i * 20 },
          likes: [5, 2, 0][i], likedByMe: false, commentCount: [2, 1, 0][i],
          comments: [
            { id: 1, userId: 1, displayName: '我', avatarColor: '#5C8D5A', text: '今天蛋白很足，稳！', createdAt: Date.now() - 3600000 },
            { id: 2, userId: 9, displayName: '小陈', avatarColor: '#F0763B', text: '这个搭配值得抄一下', createdAt: Date.now() - 1800000 }
          ].slice(0, [2, 1, 0][i])
        };
      });
      return { data: { date: dstr, posts: posts } };
    }
    if (/\/api\/posts\/\d+\/like$/.test(path)) return { data: { liked: true, likes: 6 } };
    if (/\/api\/posts\/\d+\/rate$/.test(path)) {
      var stars = Number((opts.body && opts.body.stars) || 0);
      return { data: { rating: { avg: stars ? 4.5 : 4, count: stars ? 2 : 1, mine: stars } } };
    }
    // 对象存储：演示模式下说「开着」，让上传这条路径也能走通
    if (path.indexOf('/api/storage/status') === 0) {
      return { data: { ok: true, enabled: true, ready: true, bucket: 'demo', endpoint: 'demo', private: false, hasKey: true, dailyLimit: 30, usedToday: 0 } };
    }
    if (path.indexOf('/api/photos/feed') === 0) {
      return { data: {
        photos: [
          { id: 1, date: dstr, meal: 'lunch', url: '', caption: '番茄炒蛋 + 米饭', createdAt: Date.now(), mine: true,
            author: { id: 1, displayName: '我', avatarColor: '#5BA67C', uid: 'DEMO01' } },
          { id: 2, date: dstr, meal: 'dinner', url: '', caption: '楼下小碗菜', createdAt: Date.now() - 3600000, mine: false,
            author: { id: 2, displayName: '演示好友', avatarColor: '#E08A3C', uid: 'DEMO02' } }
        ],
        hasMore: false, nextBefore: 0 } };
    }
    if (path.indexOf('/api/photos') === 0) {
      var cap = (opts.body && opts.body.caption) || '';
      var w = (opts.body && opts.body.width) || 0;
      var h = (opts.body && opts.body.height) || 0;
      return { data: { ok: true, photo: { id: Date.now(), date: dstr, meal: (opts.body && opts.body.meal) || 'lunch', url: '', width: w, height: h, bytes: 0, caption: cap, createdAt: Date.now() } } };
    }
    if (/\/api\/posts\/\d+\/comments$/.test(path)) {
      return { data: { comment: { id: 99, displayName: '我', text: (opts.body && opts.body.text) || '', createdAt: Date.now() } } };
    }
    if (/\/cheer$/.test(path)) return { data: { ok: true } };
    if (path.indexOf('/api/posts') === 0) return { data: { post: { id: 200, date: dstr } } };
    // 演示模式下的注册/登录：让「首启注册」这条路径能在不联网的情况下跑完
    if (/\/api\/auth\/(register|login)$/.test(path)) {
      var who = (opts.body && opts.body.username) || 'demo';
      return { data: { token: 'demo-token', user: { id: 1, uid: 'DEMO01', username: who, displayName: (opts.body && opts.body.displayName) || who } } };
    }
    // 记录同步（演示模式只回空，不造数据）
    if (path.indexOf('/api/diary') === 0) {
      if ((opts.method || 'GET') === 'POST' || opts.method === 'PUT') {
        var pushed = (opts.body && opts.body.days) || [];
        return { data: { ok: true, saved: pushed.length, dates: pushed.map(function (d) { return d.date; }) } };
      }
      return { data: { days: [], uid: 'DEMO01' } };
    }
    // 身体档案 + 体重：演示模式也有「服务器」，用来验证上云和拉回
    if (path.indexOf('/api/profile') === 0) {
      if (opts.method === 'PUT') {
        demoProfile = (opts.body && opts.body.data) || demoProfile;
        demoProfileAt = (opts.body && opts.body.updatedAt) || Date.now();
        return { data: { ok: true, updatedAt: demoProfileAt } };
      }
      return { data: { ok: true, data: demoProfile, updatedAt: demoProfileAt } };
    }
    if (path.indexOf('/api/users/by-uid/') === 0) {
      var q = path.split('/').pop().toUpperCase();
      return { data: { user: { id: 7, uid: q, username: 'demo_friend', displayName: '示例好友', avatarColor: '#4DB6AC', goalText: '保持' } } };
    }
    if (path.indexOf('/api/me') === 0) {
      return { data: { user: { id: 1, uid: 'DEMO01', username: 'demo', displayName: '我', avatarColor: '#5C8D5A', goalText: '保持' } } };
    }
    if (path.indexOf('/api/version') === 0) {
      // 调试入口可以用 __demoVersion 覆盖，用来演「有新版本」的完整流程。
      // 这里不要写死某个版本号：写死以后每次发版都会变成「和本机同号」，
      // 于是永远只回「已是最新版本」（真踩过这个坑）。
      if (root.__demoVersion) return { data: root.__demoVersion };
      return { data: { versionCode: 0, versionName: '0.0.0', url: '', notes: '', force: false, minSupported: 1 } };
    }
    return { data: {} };
  }

  function fetchJSON(url, init) {
    if (root.__demoServer) {
      var path = String(url).replace(/^https?:\/\/[^/]+/, '');
      var opts = { method: (init && init.method) || 'GET', body: null };
      try { opts.body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { opts.body = null; }
      return new Promise(function (resolve) { setTimeout(function () { resolve(demoReply(path, opts)); }, 30); });
    }
    if (typeof root.fetch !== 'function') return Promise.reject(new Error('no fetch'));
    return root.fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return { data: data === null ? {} : data };
      });
    });
  }

  function request(cfg, path, opts) {
    opts = opts || {};
    var base = trimBase(cfg.baseUrl);
    if (!base) return Promise.resolve({ offline: true, error: '还没有配置服务器' });
    var url = base + path;
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    var body = opts.body === undefined ? null : JSON.stringify(opts.body);
    var method = opts.method || 'GET';
    // 只重试「安全」的方法：GET/PUT 重发不会多出一条记录，
    // POST（发动态、点赞）重发会重复，宁可让用户自己再点一次。
    // 例外是带 clientId 的 POST：服务端认得这个 id，重发只会拿回同一次结果。
    var mayRetry = method === 'GET' || method === 'PUT' || !!opts.idempotent;

    function attempt(timeoutMs, isRetry) {
      var ctrl = null;
      var timer = null;
      var init = { method: method, headers: headers, cache: 'no-store' };
      if (body) init.body = body;
      if (typeof root.AbortController === 'function') {
        ctrl = new root.AbortController();
        init.signal = ctrl.signal;
        timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      }
      return fetchJSON(url, init).then(function (res) {
        if (timer) { clearTimeout(timer); timer = null; }
        return { status: 200, data: res.data };
      }).catch(function (err) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (err && err.status) return { status: err.status, error: err.message, data: err.data };
        var aborted = err && err.name === 'AbortError';
        // 超时 / 断网：先自己再试一次（超时放宽一倍），多半是免费实例刚被唤醒
        if (!isRetry && mayRetry) return attempt(timeoutMs * 2, true);
        var msg = aborted
          ? '连接超时（免费实例可能正在唤醒，再试一次）' : '连不上服务器';
        return { error: msg, network: true, detail: String(err && err.message || err) };
      });
    }

    return attempt(opts.timeout || TIMEOUT_MS, false);
  }

  var api = {
    version: '0.1.0',

    request: request,

    health: function (cfg) { return request(cfg, '/api/health'); },

    register: function (cfg, username, password, displayName) {
      return request(cfg, '/api/auth/register', {
        method: 'POST',
        body: { username: username, password: password, displayName: displayName || username }
      });
    },

    login: function (cfg, username, password) {
      return request(cfg, '/api/auth/login', { method: 'POST', body: { username: username, password: password } });
    },

    logout: function (cfg) { return request(cfg, '/api/auth/logout', { method: 'POST' }); },

    me: function (cfg) { return request(cfg, '/api/me'); },

    updateMe: function (cfg, patch) { return request(cfg, '/api/me', { method: 'PUT', body: patch }); },

    friends: function (cfg) { return request(cfg, '/api/friends'); },

    addFriend: function (cfg, username) {
      return request(cfg, '/api/friends/request', { method: 'POST', body: { username: username } });
    },

    /** 按 6 位短号加好友（新方式） */
    addFriendByUid: function (cfg, uid) {
      return request(cfg, '/api/friends/request', { method: 'POST', body: { uid: uid } });
    },

    /** 按短号查人：加好友前先确认是谁 */
    userByUid: function (cfg, uid) {
      return request(cfg, '/api/users/by-uid/' + encodeURIComponent(String(uid || '').replace(/^#/, '')));
    },

    /** 拉一段日期区间的饮食记录（服务器是真正存数据的地方） */
    diaryList: function (cfg, from, to) {
      var q = [];
      if (from) q.push('from=' + encodeURIComponent(from));
      if (to) q.push('to=' + encodeURIComponent(to));
      return request(cfg, '/api/diary' + (q.length ? '?' + q.join('&') : ''), { timeout: 30000 });
    },

    /** 推一段日期区间到服务器；days = [{date, entries, updatedAt}] */
    diaryPush: function (cfg, days) {
      return request(cfg, '/api/diary', { method: 'PUT', body: { days: days }, timeout: 30000 });
    },

    /** 身体档案 + 体重（一人一份 JSON，按 updatedAt 取新的） */
    profileGet: function (cfg) {
      return request(cfg, '/api/profile', { timeout: 30000 });
    },

    profileSave: function (cfg, data, updatedAt) {
      return request(cfg, '/api/profile', {
        method: 'PUT', body: { data: data, updatedAt: updatedAt }, timeout: 30000
      });
    },

    friendRequests: function (cfg) { return request(cfg, '/api/friends/requests'); },

    acceptFriend: function (cfg, requestId) {
      return request(cfg, '/api/friends/accept', { method: 'POST', body: { requestId: requestId } });
    },

    rejectFriend: function (cfg, requestId) {
      return request(cfg, '/api/friends/reject', { method: 'POST', body: { requestId: requestId } });
    },

    feed: function (cfg, date, scope) {
      return request(cfg, '/api/feed?date=' + encodeURIComponent(date || '') + '&scope=' + (scope || 'friends'));
    },

    publish: function (cfg, payload) { return request(cfg, '/api/posts', { method: 'POST', body: payload }); },

    like: function (cfg, postId) {
      return request(cfg, '/api/posts/' + encodeURIComponent(postId) + '/like', { method: 'POST' });
    },

    comment: function (cfg, postId, text) {
      return request(cfg, '/api/posts/' + encodeURIComponent(postId) + '/comments', {
        method: 'POST',
        body: { text: text }
      });
    },

    cheer: function (cfg, postId) {
      return request(cfg, '/api/posts/' + encodeURIComponent(postId) + '/cheer', { method: 'POST' });
    },

    /** 给好友这顿饭打分：1–5 星，0 = 取消 */
    ratePost: function (cfg, postId, stars) {
      return request(cfg, '/api/posts/' + encodeURIComponent(postId) + '/rate', {
        method: 'POST',
        body: { stars: stars }
      });
    },

    /** 对象存储开没开 + 今天已经传了几张 */
    storageStatus: function (cfg) {
      return request(cfg, '/api/storage/status', { timeout: 20000 });
    },

    /** 上传一张照片（data URL）。图片会先到自己的后端，再由后端签名转存 OSS。 */
    uploadPhoto: function (cfg, payload) {
      return request(cfg, '/api/photos', {
        method: 'POST',
        body: payload,
        timeout: 60000,
        idempotent: !!(payload && payload.clientId)
      });
    },

    /** 我某天已经存了哪些照片 */
    photosOfDay: function (cfg, date) {
      return request(cfg, '/api/photos?date=' + encodeURIComponent(date || ''), { timeout: 30000 });
    },

    /** 朋友圈：我 + 好友的照片，按时间倒序。before = 上一页最后一张的 createdAt */
    photoFeed: function (cfg, before, limit) {
      var q = [];
      if (before) q.push('before=' + encodeURIComponent(before));
      if (limit) q.push('limit=' + encodeURIComponent(limit));
      return request(cfg, '/api/photos/feed' + (q.length ? '?' + q.join('&') : ''), { timeout: 30000 });
    },

    deletePhoto: function (cfg, id) {
      return request(cfg, '/api/photos/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    cheers: function (cfg) { return request(cfg, '/api/cheers'); },

    /**
     * 拍照识别。payload = { image: 'data:image/jpeg;base64,...', meal }
     * 返回 { items: [{name, grams, kcal100, protein100, fat100, carbs100, confidence}], note }
     * 超时给到 60 秒：免费实例冷启动 + 视觉模型本身慢，15 秒会误判成失败。
     */
    recognize: function (cfg, payload) {
      // payload.clientId 让服务端认得出「这是同一次识别」，断了重发不会扣两次次数
      var idem = !!(payload && payload.clientId);
      return request(cfg, '/api/recognize', { method: 'POST', body: payload, timeout: 60000, idempotent: idem });
    },

    /** 识别功能是否可用（服务端有没有配 Key / 今天还剩几次） */
    recognizeStatus: function (cfg) { return request(cfg, '/api/recognize/status'); },

    /**
     * 检查更新。baseUrl 为空时走「离线清单」：让调用方回退到 GitHub 直链。
     * 返回 {versionCode, versionName, url, notes, force, minSupported} 或 {error}
     */
    checkVersion: function (cfg, platform) {
      return request(cfg, '/api/version?platform=' + (platform || 'android'));
    },

    trimBase: trimBase,
    fetchJSON: fetchJSON
  };

  root.dietApi = api;
})(window);

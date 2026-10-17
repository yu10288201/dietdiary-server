// server/src/index.js
// 饮食记录 App · 社交功能后端（Express + Turso/libSQL）
// 本地跑：cp .env.example .env && npm install && npm start

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { all, get, initDb, run, dbUrl } from './db.js';
import {
  backfillUserUids,
  cleanupExpiredSessions,
  createSession,
  destroySession,
  ensureUserUid,
  findUserById,
  findUserByUid,
  findUserByUsername,
  hashPassword,
  mapUsersByIds,
  normalizeUid,
  requireAuth,
  toPublicUser,
  verifyPassword
} from './auth.js';

const PORT = Number(process.env.PORT || 3000);

const app = express();
app.disable('x-powered-by');
app.use(cors());                                  // App 直连，放开跨域
app.use(express.json({ limit: '1mb' }));          // 动态体不大，1MB 足够

// ---------------------------------------------------------------- 通用工具

const MEAL_KEYS = ['breakfast', 'lunch', 'dinner', 'snack', 'extra'];
const MAX_MEAL_ITEMS = 60;
const MAX_COMMENT_CHARS = 500;
/** feed / post 里每条动态最多带回最近 N 条评论（正序） */
const FEED_COMMENTS_LIMIT = 20;
const AVATAR_COLORS = [
  '#FF8A65', '#4DB6AC', '#7986CB', '#FFB74D', '#A1887F',
  '#4FC3F7', '#81C784', '#F06292', '#BA68C8', '#90A4AE'
];

function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

function cleanString(value, maxLen) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function parseJsonSafe(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return parseJsonSafe(Buffer.from(value).toString('utf8'), fallback);
    }
    return value;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeMealItem(raw) {
  if (typeof raw === 'string') {
    const only = cleanString(raw, 60);
    return only ? { name: only, amount: '', kcal: 0, p: 0, f: 0, ch: 0, note: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanString(raw.name ?? raw.title ?? raw.food ?? '', 60);
  if (!name) return null;
  return {
    name,
    amount: cleanString(raw.amount ?? raw.quantity ?? raw.portion ?? '', 30),
    kcal: round1(raw.kcal ?? raw.calories ?? 0),
    p: round1(raw.p ?? raw.protein ?? 0),
    f: round1(raw.f ?? raw.fat ?? 0),
    ch: round1(raw.ch ?? raw.carb ?? raw.carbs ?? raw.carbohydrate ?? 0),
    note: cleanString(raw.note ?? raw.remark ?? '', 120)
  };
}

/**
 * 任意 meals 输入 -> 固定 5 个 key 的规范结构。
 * 前端会把「练前餐 / 练后餐 / 夜宵」之类塞进自定义 key，这些 key 里的数据不能丢：
 * 未知 key 的条目一律合并进 extra（每条 entry 的 name 里本来就带餐次字样）。
 */
function normalizeMeals(input) {
  const src = typeof input === 'string' ? parseJsonSafe(input, {}) : input;
  const meals = {};
  for (const key of MEAL_KEYS) meals[key] = [];
  if (!src || typeof src !== 'object') return meals;
  for (const [rawKey, rawValue] of Object.entries(src)) {
    const key =
      MEAL_KEYS.find((k) => k === rawKey) ||
      MEAL_KEYS.find((k) => k.toLowerCase() === String(rawKey).toLowerCase());
    const bucket = key || 'extra'; // 未知 key -> extra，不丢数据
    const list = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
    const items = list.map(normalizeMealItem).filter(Boolean);
    meals[bucket] = meals[bucket].concat(items).slice(0, MAX_MEAL_ITEMS);
  }
  return meals;
}

/** 计算营养合计；totals 传了就用传的，没传就按餐次累加 */
function computeTotals(meals, providedTotals) {
  const provided = typeof providedTotals === 'string'
    ? parseJsonSafe(providedTotals, null)
    : providedTotals;
  const totals = { kcal: 0, p: 0, f: 0, ch: 0 };
  let hasItems = false;
  for (const key of MEAL_KEYS) {
    for (const item of meals[key] || []) {
      hasItems = true;
      totals.kcal += num(item.kcal);
      totals.p += num(item.p);
      totals.f += num(item.f);
      totals.ch += num(item.ch);
    }
  }
  const summed = {
    kcal: Math.round(totals.kcal),
    p: round1(totals.p),
    f: round1(totals.f),
    ch: round1(totals.ch)
  };
  if (provided && typeof provided === 'object') {
    const merged = {
      kcal: Math.round(num(provided.kcal) || (hasItems ? summed.kcal : 0)),
      p: round1(num(provided.p) || (hasItems ? summed.p : 0)),
      f: round1(num(provided.f) || (hasItems ? summed.f : 0)),
      ch: round1(num(provided.ch) || (hasItems ? summed.ch : 0))
    };
    return merged;
  }
  return summed;
}

function randomAvatarColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 路由包装：把 async 抛出的错误交给统一错误处理 */
function h(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * 更新清单里「最新版本」的来源，优先级从高到低：
 *   1. Turso 的 app_versions 表（有人手动写了行就以它为准，方便热改）
 *   2. 仓库里的 version.json（**发版脚本会自动改它并 push**，Render 收到 push
 *      自动重新部署，所以日常发版只要一条命令，不用再进 Render 面板改环境变量）
 *   3. 环境变量 APK_*（保留给不想改文件的部署方式）
 *   4. 内置默认值
 * url 默认指向 GitHub 的 releases/latest/download/shike.apk —— 这个地址**永不改变**，
 * 每次发版只要把同一文件名传上去就行，不用再改配置。
 */
const DEFAULT_APK_URL = 'https://raw.githubusercontent.com/yu10288201/dietdiary-server/main/public/shike.apk';

let versionFileCache = { mtimeMs: 0, data: null };

/* 本文件是 ESM，没有 __dirname，必须从 import.meta.url 推 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 读 version.json（按 mtime 缓存，改了文件不用重启进程） */
function readVersionFile() {
  try {
    const file = path.join(HERE, '..', 'version.json');
    const st = fs.statSync(file);
    if (versionFileCache.data && versionFileCache.mtimeMs === st.mtimeMs) return versionFileCache.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = raw && (raw.android || raw);
    versionFileCache = { mtimeMs: st.mtimeMs, data: data || null };
    return data || null;
  } catch {
    return null; // 文件缺失/写坏了都不能影响启动，直接回退到环境变量
  }
}

function versionPayload() {
  const f = readVersionFile() || {};
  const pick = (fileVal, envVal, dflt) => {
    if (fileVal !== undefined && fileVal !== null && fileVal !== '') return fileVal;
    if (envVal !== undefined && envVal !== '') return envVal;
    return dflt;
  };
  return {
    versionCode: Number(pick(f.versionCode, process.env.APK_VERSION_CODE, 1)),
    versionName: String(pick(f.versionName, process.env.APK_VERSION_NAME, '0.1.0')),
    url: String(pick(f.url, process.env.APK_URL, DEFAULT_APK_URL)),
    notes: String(pick(f.notes, process.env.APK_NOTES, '')),
    force: String(pick(f.force, process.env.APK_FORCE, 'false')).toLowerCase() === 'true',
    minSupported: Number(pick(f.minSupported, process.env.APK_MIN_SUPPORTED, 1)),
    // 指纹和大小必须一起返回：App 只有拿到 sha256 才会在安装前校验。
    // 少了它就会出现「提示是新版、装上去还是旧版」—— 因为 GitHub raw 有
    // 最长 5 分钟的 CDN 缓存，下拉到的是上一个包也不会被拦下。
    sha256: String(pick(f.sha256, process.env.APK_SHA256, '')),
    size: Number(pick(f.size, process.env.APK_SIZE, 0))
  };
}

// -------------------------------------------------------- 好友关系小工具

/** 取“我”的好友 id 集合（只含 status = accepted） */
async function acceptedFriendIds(userId) {
  const rows = await all(
    `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS friend_id
       FROM friendships
      WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
    [userId, userId, userId]
  );
  return rows.map((r) => Number(r.friend_id));
}

/** 判断两人是否是已接受的好友 */
async function areFriends(a, b) {
  const row = await get(
    `SELECT id FROM friendships
      WHERE status = 'accepted'
        AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
      LIMIT 1`,
    [a, b, b, a]
  );
  return Boolean(row);
}

// ------------------------------------------------------------ 健康检查

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'dietdiary-server', version: versionPayload().versionName });
});

// GET /api/health -> {ok:true, db:"connected"|"error"}（探活时真 ping 一次数据库）
app.get(['/api/health', '/healthz'], h(async (_req, res) => {
  let db = 'connected';
  try {
    await get('SELECT 1 AS ok');
  } catch (err) {
    db = 'error';
    console.warn('[health] 数据库探测失败:', err.message);
  }
  res.json({ ok: true, db, service: 'dietdiary-server', time: new Date().toISOString() });
}));

// ------------------------------------------------------------ /api/auth

app.post('/api/auth/register', h(async (req, res) => {
  const body = req.body || {};
  const username = cleanString(body.username, 64).toLowerCase();
  const password = String(body.password ?? '');
  const displayName = cleanString(body.displayName ?? body.display_name ?? username, 64);

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new HttpError(400, '用户名需为 3-24 位字母、数字或下划线');
  }
  if (password.length < 6) {
    throw new HttpError(400, '密码至少 6 位');
  }
  if (!displayName) throw new HttpError(400, '昵称不能为空');
  if (displayName.length > 24) throw new HttpError(400, '昵称最长 24 个字符');

  if (await findUserByUsername(username)) {
    throw new HttpError(409, '该用户名已被注册');
  }

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  let userId;
  try {
    const result = await run(
      `INSERT INTO users (username, display_name, password_hash, avatar_color, goal_text, created_at)
       VALUES (?, ?, ?, ?, '', ?)`,
      [username, displayName, passwordHash, randomAvatarColor(), now]
    );
    userId = result.lastInsertRowid;
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, '该用户名已被注册');
    throw err;
  }

  const token = await createSession(userId);
  // 注册即分配永久短号（社交加好友只认它，不认登录名）
  await ensureUserUid(userId);
  const user = toPublicUser(await findUserById(userId));
  res.status(201).json({ token, user });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const body = req.body || {};
  const username = cleanString(body.username, 24).toLowerCase();
  const password = String(body.password ?? '');
  if (!username || !password) throw new HttpError(400, '用户名和密码不能为空');

  const row = await findUserByUsername(username);
  // 用户不存在也走一次哈希校验，避免用响应时间探测用户名是否存在
  const ok = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!row || !ok) throw new HttpError(401, '用户名或密码错误');

  const token = await createSession(Number(row.id));
  // 老用户第一次在新版本上登录：补发短号（幂等，有就返回原来的）
  if (!row.uid) await ensureUserUid(Number(row.id));
  const fresh = await findUserById(Number(row.id));
  res.json({ token, user: toPublicUser(fresh || row) });
}));

app.post('/api/auth/logout', requireAuth, h(async (req, res) => {
  await destroySession(req.token);
  res.json({ ok: true });
}));

// -------------------------------------------------------------- /api/me

app.get('/api/me', requireAuth, h(async (req, res) => {
  res.json({ user: req.user });
}));

app.put('/api/me', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  const row = await findUserById(req.user.id);
  if (!row) throw new HttpError(404, '用户不存在');

  let displayName = row.display_name;
  if (body.displayName !== undefined || body.display_name !== undefined) {
    displayName = cleanString(body.displayName ?? body.display_name, 64);
    if (!displayName) throw new HttpError(400, '昵称不能为空');
    if (displayName.length > 24) throw new HttpError(400, '昵称最长 24 个字符');
  }

  let goalText = row.goal_text;
  if (body.goalText !== undefined || body.goal_text !== undefined) {
    goalText = cleanString(body.goalText ?? body.goal_text, 200);
  }

  let avatarColor = row.avatar_color;
  if (body.avatarColor !== undefined || body.avatar_color !== undefined) {
    const candidate = cleanString(body.avatarColor ?? body.avatar_color, 16);
    if (!/^#[0-9a-fA-F]{6}$/.test(candidate)) {
      throw new HttpError(400, 'avatarColor 需为 #RRGGBB 格式');
    }
    avatarColor = candidate.toLowerCase();
  }

  await run(
    'UPDATE users SET display_name = ?, goal_text = ?, avatar_color = ? WHERE id = ?',
    [displayName, goalText, avatarColor, req.user.id]
  );
  res.json({ user: toPublicUser(await findUserById(req.user.id)) });
}));

// ------------------------------------------------------------ /api/diary
//
// 记录本体存服务器，一人一天一行。客户端策略：
//   * 本机改动立刻保存，再防抖推上来（带本地 updatedAt）
//   * 登录/开 App 时按区间拉一次，服务端更新就覆盖本机，本机更新就推上去
// 冲突用「谁的时间戳新谁赢」，不做合并 —— 同一天两台设备各改一半的场景先不管。

/** 一天一条记录最多多少字节（防止有人拿它当文件存储） */
const DIARY_MAX_BYTES = 200 * 1024;
/** 一次最多推多少天 */
const DIARY_MAX_DAYS = 400;

function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanString(item.id, 64);
    const name = cleanString(item.name, 64);
    if (!id || !name) continue;
    out.push({
      id,
      name,
      meal: cleanString(item.meal, 16) || 'snack',
      date: cleanString(item.date, 10),
      foodId: cleanString(item.foodId, 64),
      cat: cleanString(item.cat, 32),
      unit: cleanString(item.unit, 8),
      qty: num(item.qty),
      grams: num(item.grams) || num(item.amount),
      kcal: num(item.kcal),
      p: num(item.p),
      f: num(item.f),
      ch: num(item.ch),
      ts: Math.trunc(num(item.ts))
    });
  }
  return out;
}

app.get('/api/diary', requireAuth, h(async (req, res) => {
  const from = isValidDate(req.query.from) ? String(req.query.from) : todayStr(-365);
  const to = isValidDate(req.query.to) ? String(req.query.to) : todayStr(1);
  const rows = await all(
    'SELECT date, entries_json, updated_at FROM diary WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date',
    [req.user.id, from, to]
  );
  res.json({
    from,
    to,
    uid: req.user.uid || '',
    days: rows.map((r) => {
      let entries = [];
      try { entries = JSON.parse(r.entries_json); } catch { entries = []; }
      return { date: r.date, entries, updatedAt: Number(r.updated_at) };
    })
  });
}));

app.put('/api/diary', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  const days = Array.isArray(body.days) ? body.days : [];
  if (!days.length) throw new HttpError(400, 'days 不能为空');
  if (days.length > DIARY_MAX_DAYS) throw new HttpError(400, `一次最多推 ${DIARY_MAX_DAYS} 天`);

  const now = Date.now();
  const saved = [];
  for (const day of days) {
    const date = String((day || {}).date || '');
    if (!isValidDate(date)) continue;
    const entries = sanitizeEntries((day || {}).entries);
    const json = JSON.stringify(entries);
    if (json.length > DIARY_MAX_BYTES) {
      throw new HttpError(413, `${date} 这一天的记录太大了（上限 200 KB）`);
    }
    const updatedAt = Math.trunc(num((day || {}).updatedAt)) || now;
    // 只有新的才覆盖：两台设备来回推不会把新数据盖回旧的
    await run(
      `INSERT INTO diary (user_id, date, entries_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         entries_json = excluded.entries_json,
         updated_at   = excluded.updated_at
       WHERE excluded.updated_at >= diary.updated_at`,
      [req.user.id, date, json, updatedAt]
    );
    saved.push(date);
  }
  res.json({ ok: true, saved: saved.length, dates: saved });
}));

/* 身体档案 + 体重记录：一人一份，整块 JSON 存。
   跟 diary 一样按 updated_at 取新的 —— 两台设备来回推不会把新数据盖回旧的，
   手机离线也能改，联网后补推。 */
const PROFILE_MAX_BYTES = 64 * 1024;

app.get('/api/profile', requireAuth, h(async (req, res) => {
  const row = await get('SELECT data_json, updated_at FROM user_profile WHERE user_id = ?', [req.user.id]);
  if (!row) return res.json({ ok: true, data: null, updatedAt: 0 });
  let data = {};
  try { data = JSON.parse(row.data_json); } catch { data = {}; }
  res.json({ ok: true, data, updatedAt: Number(row.updated_at) });
}));

app.put('/api/profile', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : null;
  if (!data) throw new HttpError(400, 'data 不能为空');
  const json = JSON.stringify(data);
  if (json.length > PROFILE_MAX_BYTES) throw new HttpError(413, '身体档案太大了（上限 64 KB）');
  const updatedAt = Math.trunc(num(body.updatedAt)) || Date.now();
  await run(
    `INSERT INTO user_profile (user_id, data_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       data_json  = excluded.data_json,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= user_profile.updated_at`,
    [req.user.id, json, updatedAt]
  );
  res.json({ ok: true, updatedAt });
}));

// 按短号查人（加好友前先看一眼是谁）
app.get('/api/users/by-uid/:uid', requireAuth, h(async (req, res) => {
  const user = await findUserByUid(req.params.uid);
  if (!user) throw new HttpError(404, `找不到 ID 为 ${normalizeUid(req.params.uid)} 的用户`);
  res.json({ user: toPublicUser(user) });
}));

// --------------------------------------------------------- /api/friends

app.get('/api/friends', requireAuth, h(async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.goal_text, u.created_at, f.updated_at
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
      ORDER BY u.display_name COLLATE NOCASE ASC`,
    [req.user.id, req.user.id, req.user.id]
  );
  res.json({ friends: rows.map(toPublicUser) });
}));

app.post('/api/friends/request', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  // 新方式：按 6 位短号加（uid）；老方式按登录名加（username）继续兼容
  const uid = normalizeUid(body.uid);
  const username = cleanString(body.username, 24).toLowerCase();
  if (!uid && !username) throw new HttpError(400, '请填对方的 ID 或用户名');

  const target = uid ? await findUserByUid(uid) : await findUserByUsername(username);
  if (!target) throw new HttpError(404, uid ? `找不到 ID 为 ${uid} 的用户` : '找不到该用户');
  const targetId = Number(target.id);
  if (targetId === req.user.id) throw new HttpError(400, '不能加自己为好友');

  const existing = await get(
    `SELECT * FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
      LIMIT 1`,
    [req.user.id, targetId, targetId, req.user.id]
  );
  const now = Date.now();

  if (existing) {
    if (existing.status === 'accepted') throw new HttpError(409, '你们已经是好友了');
    if (Number(existing.requester_id) === req.user.id) {
      if (existing.status === 'pending') throw new HttpError(409, '好友请求已发送，等待对方接受');
      // 我之前被拒绝过，现在重新发起
      await run(
        "UPDATE friendships SET status = 'pending', updated_at = ? WHERE id = ?",
        [now, Number(existing.id)]
      );
      return res.status(201).json({
        ok: true,
        status: 'pending',
        request: { id: Number(existing.id), userId: targetId, displayName: target.display_name,
          avatarColor: target.avatar_color, status: 'pending', direction: 'outgoing',
          createdAt: now, updatedAt: now }
      });
    }
    // 对方已经先申请过我了 —— 直接算互相接受
    await run(
      "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?",
      [now, Number(existing.id)]
    );
    return res.json({ ok: true, status: 'accepted', autoAccepted: true,
      friend: toPublicUser(target) });
  }

  const result = await run(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?)`,
    [req.user.id, targetId, now, now]
  );
  res.status(201).json({
    ok: true,
    status: 'pending',
    request: {
      id: result.lastInsertRowid,
      userId: targetId,
      displayName: target.display_name,
      avatarColor: target.avatar_color,
      status: 'pending',
      direction: 'outgoing',
      createdAt: now,
      updatedAt: now
    }
  });
}));

app.get('/api/friends/requests', requireAuth, h(async (req, res) => {
  const incoming = await all(
    `SELECT f.id, f.requester_id AS other_id, f.created_at, f.updated_at,
            u.username, u.display_name, u.avatar_color, u.goal_text, u.created_at AS user_created_at
       FROM friendships f JOIN users u ON u.id = f.requester_id
      WHERE f.addressee_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC`,
    [req.user.id]
  );
  const outgoing = await all(
    `SELECT f.id, f.addressee_id AS other_id, f.created_at, f.updated_at,
            u.username, u.display_name, u.avatar_color, u.goal_text, u.created_at AS user_created_at
       FROM friendships f JOIN users u ON u.id = f.addressee_id
      WHERE f.requester_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC`,
    [req.user.id]
  );

  const shape = (row) => ({
    id: Number(row.id),
    status: 'pending',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    user: toPublicUser({
      id: row.other_id,
      username: row.username,
      display_name: row.display_name,
      avatar_color: row.avatar_color,
      goal_text: row.goal_text,
      created_at: row.user_created_at
    })
  });

  res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
}));

/** 找到一条写给我（或我发的）的好友请求，且必须是 pending */
async function loadPendingRequest(requestId, userId, { asAddressee }) {
  const id = Number(requestId);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'requestId 无效');
  const column = asAddressee ? 'addressee_id' : 'requester_id';
  const row = await get(
    `SELECT * FROM friendships WHERE id = ? AND ${column} = ?`,
    [id, userId]
  );
  if (!row) throw new HttpError(404, '好友请求不存在');
  if (row.status !== 'pending') throw new HttpError(409, `该请求已处理（${row.status}）`);
  return row;
}

app.post('/api/friends/accept', requireAuth, h(async (req, res) => {
  const row = await loadPendingRequest((req.body || {}).requestId, req.user.id, {
    asAddressee: true
  });
  const now = Date.now();
  await run("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?", [
    now,
    Number(row.id)
  ]);
  const friend = await findUserById(row.requester_id);
  res.json({ ok: true, status: 'accepted', friend: toPublicUser(friend) });
}));

app.post('/api/friends/reject', requireAuth, h(async (req, res) => {
  const row = await loadPendingRequest((req.body || {}).requestId, req.user.id, {
    asAddressee: true
  });
  const now = Date.now();
  await run("UPDATE friendships SET status = 'rejected', updated_at = ? WHERE id = ?", [
    now,
    Number(row.id)
  ]);
  res.json({ ok: true, status: 'rejected' });
}));

// 删除好友 / 取消自己发出的请求
// :id 既接受「好友关系 id」（friendships.id），也接受「对方 userId」——
// 前端按 DELETE /api/friends/:userId 调，先按关系 id 找，找不到再按对方 userId 找。
app.delete('/api/friends/:id', requireAuth, h(async (req, res) => {
  const value = Number(req.params.id);
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'id 无效');

  let row = await get(
    'SELECT * FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)',
    [value, req.user.id, req.user.id]
  );
  if (!row) {
    row = await get(
      `SELECT * FROM friendships
        WHERE status = 'accepted'
          AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
        LIMIT 1`,
      [req.user.id, value, value, req.user.id]
    );
  }
  if (!row) throw new HttpError(404, '好友关系不存在');
  await run('DELETE FROM friendships WHERE id = ?', [Number(row.id)]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- /api/posts

/** 发布 / 覆盖当天动态 */
app.post('/api/posts', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  const date = cleanString(body.date, 10) || todayStr();
  if (!isValidDate(date)) throw new HttpError(400, 'date 需为 YYYY-MM-DD 格式');
  if (date > todayStr(1)) throw new HttpError(400, '不能发布未来日期的动态');

  const meals = normalizeMeals(body.meals ?? body.meals_json ?? {});
  const totals = computeTotals(meals, body.totals ?? body.totals_json);
  const goalText = cleanString(
    body.goalText ?? body.goal_text ?? req.user.goalText ?? '',
    200
  );
  const now = Date.now();

  // 同一天再发一次 = 覆盖：先删旧的（级联清掉赞和评论），再插新的
  await run('DELETE FROM posts WHERE user_id = ? AND date = ?', [req.user.id, date]);
  const result = await run(
    `INSERT INTO posts (user_id, date, goal_text, meals_json, totals_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, date, goalText, JSON.stringify(meals), JSON.stringify(totals), now, now]
  );

  res.status(201).json({
    post: {
      id: result.lastInsertRowid,
      userId: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      avatarColor: req.user.avatarColor,
      date,
      goalText,
      meals,
      totals,
      likes: 0,
      likedByMe: false,
      commentCount: 0,
      comments: [],
      createdAt: now,
      updatedAt: now
    }
  });
}));

// 删掉自己某天的动态
app.delete('/api/posts/:id', requireAuth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const row = await get('SELECT * FROM posts WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, '动态不存在');
  if (Number(row.user_id) !== req.user.id) throw new HttpError(403, '只能删除自己的动态');
  await run('DELETE FROM posts WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ----------------------------------------------------------------- /api/feed

/** 把 posts 表行批量转成前端消费的 post 对象（点赞 / 评论聚合，评论最多最近 20 条） */
async function shapePosts(viewerId, postRows) {
  if (!postRows.length) return [];

  const postIds = postRows.map((p) => Number(p.id));
  const postPlaceholders = postIds.map(() => '?').join(', ');

  const likeRows = await all(
    `SELECT post_id, user_id FROM likes WHERE post_id IN (${postPlaceholders})`,
    postIds
  );
  const commentRows = await all(
    `SELECT id, post_id, user_id, text, created_at FROM comments
      WHERE post_id IN (${postPlaceholders}) ORDER BY created_at ASC, id ASC`,
    postIds
  );

  const likeCount = new Map();
  const likedByMe = new Set();
  for (const row of likeRows) {
    const pid = Number(row.post_id);
    likeCount.set(pid, (likeCount.get(pid) || 0) + 1);
    if (Number(row.user_id) === viewerId) likedByMe.add(pid);
  }

  const commentCount = new Map();
  const commentsByPost = new Map();
  for (const row of commentRows) {
    const pid = Number(row.post_id);
    commentCount.set(pid, (commentCount.get(pid) || 0) + 1);
    if (!commentsByPost.has(pid)) commentsByPost.set(pid, []);
    commentsByPost.get(pid).push(row);
  }

  const authorMap = await mapUsersByIds(postRows.map((p) => p.user_id));
  const commentUserMap = await mapUsersByIds(commentRows.map((c) => c.user_id));

  return postRows.map((post) => {
    const pid = Number(post.id);
    const author = authorMap.get(Number(post.user_id)) || {};
    const meals = normalizeMeals(parseJsonSafe(post.meals_json, {}));
    const totals = computeTotals(meals, parseJsonSafe(post.totals_json, null));
    const comments = (commentsByPost.get(pid) || []).slice(-FEED_COMMENTS_LIMIT).map((c) => {
      const cu = commentUserMap.get(Number(c.user_id)) || {};
      return {
        id: Number(c.id),
        userId: Number(c.user_id),
        displayName: cu.displayName || '',
        avatarColor: cu.avatarColor || '#9E9E9E',
        text: c.text,
        createdAt: Number(c.created_at),
        mine: Number(c.user_id) === viewerId
      };
    });
    return {
      id: pid,
      userId: Number(post.user_id),
      username: author.username || '',
      displayName: author.displayName || '',
      avatarColor: author.avatarColor || '#9E9E9E',
      date: post.date,
      goalText: post.goal_text,
      meals,
      totals,
      likes: likeCount.get(pid) || 0,
      likedByMe: likedByMe.has(pid),
      commentCount: commentCount.get(pid) || 0,
      comments,
      createdAt: Number(post.created_at),
      updatedAt: Number(post.updated_at)
    };
  });
}

async function buildFeed(viewerId, date, scope) {
  const authorIds = [viewerId];
  if (scope === 'friends') {
    authorIds.push(...(await acceptedFriendIds(viewerId)));
  }
  const placeholders = authorIds.map(() => '?').join(', ');
  const rows = await all(
    `SELECT * FROM posts WHERE date = ? AND user_id IN (${placeholders}) ORDER BY updated_at DESC`,
    [date, ...authorIds]
  );
  return shapePosts(viewerId, rows);
}

app.get('/api/feed', requireAuth, h(async (req, res) => {
  const date = cleanString(req.query.date, 10) || todayStr();
  if (!isValidDate(date)) throw new HttpError(400, 'date 需为 YYYY-MM-DD 格式');
  const scope = req.query.scope === 'me' ? 'me' : 'friends';
  const posts = await buildFeed(req.user.id, date, scope);
  res.json({ date, scope, posts });
}));

/** GET /api/posts/:id —— 本人或已接受好友才能看 */
app.get('/api/posts/:id', requireAuth, h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isFinite(postId) || postId <= 0) throw new HttpError(400, 'id 无效');
  const row = await loadVisiblePost(postId, req.user.id);
  const [post] = await shapePosts(req.user.id, [row]);
  res.json({ post });
}));

// ------------------------------------------------------- 点赞 / 评论 / 催更

/** 动态必须可见：自己发的，或者已接受好友发的 */
async function loadVisiblePost(postId, viewerId) {
  const row = await get('SELECT * FROM posts WHERE id = ?', [postId]);
  if (!row) throw new HttpError(404, '动态不存在');
  if (Number(row.user_id) !== viewerId && !(await areFriends(viewerId, Number(row.user_id)))) {
    throw new HttpError(403, '只能操作自己和好友的动态');
  }
  return row;
}

app.post('/api/posts/:id/like', requireAuth, h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isFinite(postId) || postId <= 0) throw new HttpError(400, 'id 无效');
  await loadVisiblePost(postId, req.user.id);

  const existing = await get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [
    postId,
    req.user.id
  ]);
  let liked;
  if (existing) {
    await run('DELETE FROM likes WHERE id = ?', [Number(existing.id)]);
    liked = false;
  } else {
    await run('INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)', [
      postId,
      req.user.id,
      Date.now()
    ]);
    liked = true;
  }
  const countRow = await get('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?', [postId]);
  res.json({ liked, likes: Number(countRow?.c || 0) });
}));

app.post('/api/posts/:id/comments', requireAuth, h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isFinite(postId) || postId <= 0) throw new HttpError(400, 'id 无效');
  await loadVisiblePost(postId, req.user.id);

  const text = String((req.body || {}).text ?? '').trim();
  if (!text) throw new HttpError(400, '评论内容不能为空');
  if (text.length > MAX_COMMENT_CHARS) {
    throw new HttpError(400, `评论最多 ${MAX_COMMENT_CHARS} 字`);
  }

  const now = Date.now();
  const result = await run(
    'INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)',
    [postId, req.user.id, text, now]
  );
  res.status(201).json({
    comment: {
      id: result.lastInsertRowid,
      postId,
      userId: req.user.id,
      displayName: req.user.displayName,
      avatarColor: req.user.avatarColor,
      text,
      createdAt: now
    }
  });
}));

/** GET /api/posts/:id/comments —— 本人或好友可见，全部评论按时间正序 */
app.get('/api/posts/:id/comments', requireAuth, h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isFinite(postId) || postId <= 0) throw new HttpError(400, 'id 无效');
  await loadVisiblePost(postId, req.user.id);

  const rows = await all(
    `SELECT c.id, c.post_id, c.user_id, c.text, c.created_at,
            u.display_name, u.avatar_color
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC, c.id ASC`,
    [postId]
  );
  res.json({
    comments: rows.map((c) => ({
      id: Number(c.id),
      postId: Number(c.post_id),
      userId: Number(c.user_id),
      displayName: c.display_name,
      avatarColor: c.avatar_color,
      text: c.text,
      createdAt: Number(c.created_at),
      mine: Number(c.user_id) === req.user.id
    }))
  });
}));

app.delete('/api/comments/:id', requireAuth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const row = await get('SELECT * FROM comments WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, '评论不存在');

  const isAuthor = Number(row.user_id) === req.user.id;
  // 动态主人也可以删自己动态下的评论
  let isPostOwner = false;
  if (!isAuthor) {
    const post = await get('SELECT user_id FROM posts WHERE id = ?', [Number(row.post_id)]);
    isPostOwner = Boolean(post) && Number(post.user_id) === req.user.id;
  }
  if (!isAuthor && !isPostOwner) throw new HttpError(403, '只能删除自己的评论');

  await run('DELETE FROM comments WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/** 催更：给指定好友（或当天还没发动态的好友）发一条提醒 */
app.post('/api/posts/:id/cheer', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  const message = cleanString(body.message, 120);

  let post = null;
  let toUserId;
  let date = cleanString(body.date, 10) || todayStr();

  if (req.params.id && req.params.id !== 'me' && req.params.id !== '0') {
    const postId = Number(req.params.id);
    if (!Number.isFinite(postId) || postId <= 0) throw new HttpError(400, 'id 无效');
    post = await loadVisiblePost(postId, req.user.id);
    toUserId = Number(post.user_id);
    date = post.date;
  } else if (body.toUserId !== undefined || body.username !== undefined) {
    const target = body.username
      ? await findUserByUsername(cleanString(body.username, 24).toLowerCase())
      : await findUserById(Number(body.toUserId));
    if (!target) throw new HttpError(404, '找不到该用户');
    toUserId = Number(target.id);
  } else {
    throw new HttpError(400, '缺少目标用户（postId / toUserId / username）');
  }

  if (toUserId === req.user.id) throw new HttpError(400, '不能催更自己');
  if (!(await areFriends(req.user.id, toUserId))) {
    throw new HttpError(403, '只能催更好友');
  }
  if (!isValidDate(date)) throw new HttpError(400, 'date 需为 YYYY-MM-DD 格式');

  // 同一天对同一个人只算一次，避免刷屏
  const startOfDay = new Date(`${date}T00:00:00`).getTime();
  const endOfDay = startOfDay + 86400000;
  const dup = await get(
    `SELECT id FROM cheers
      WHERE from_user_id = ? AND to_user_id = ? AND created_at >= ? AND created_at < ?`,
    [req.user.id, toUserId, startOfDay, endOfDay]
  );
  if (dup) {
    return res.json({ ok: true, duplicate: true, message: '今天已经催过 TA 了' });
  }

  const now = Date.now();
  const result = await run(
    `INSERT INTO cheers (from_user_id, to_user_id, post_id, date, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.user.id, toUserId, post ? Number(post.id) : null, date, message, now]
  );
  const target = await findUserById(toUserId);
  res.status(201).json({
    ok: true,
    cheer: {
      id: result.lastInsertRowid,
      fromUserId: req.user.id,
      toUserId,
      toDisplayName: target?.display_name || '',
      postId: post ? Number(post.id) : null,
      date,
      message,
      createdAt: now
    }
  });
}));

/** 我收到的催更（App 用来做提醒红点） */
app.get('/api/cheers', requireAuth, h(async (req, res) => {
  const rows = await all(
    `SELECT c.id, c.post_id, c.date, c.message, c.created_at,
            u.id AS from_id, u.username AS from_username,
            u.display_name AS from_display_name, u.avatar_color AS from_avatar_color
       FROM cheers c JOIN users u ON u.id = c.from_user_id
      WHERE c.to_user_id = ?
      ORDER BY c.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({
    cheers: rows.map((r) => ({
      id: Number(r.id),
      from: {
        id: Number(r.from_id),
        username: r.from_username,
        displayName: r.from_display_name,
        avatarColor: r.from_avatar_color
      },
      // 兼容老前端：同时保留平铺字段
      fromUserId: Number(r.from_id),
      displayName: r.from_display_name,
      avatarColor: r.from_avatar_color,
      postId: r.post_id === null ? null : Number(r.post_id),
      date: r.date,
      message: r.message,
      createdAt: Number(r.created_at)
    }))
  });
}));

// ---------------------------------------------------------------- /api/version

/** 启动时检查更新用，无需鉴权 */
app.get('/api/version', h(async (req, res) => {
  const platform = cleanString(req.query.platform, 20) || 'android';
  const fallback = versionPayload();
  try {
    const row = await get('SELECT * FROM app_versions WHERE platform = ?', [platform]);
    if (row) {
      // 指纹只跟「同一版」配套给出去：库里那行和 version.json 说的版本不一样时，
      // 说明两个来源有一个是旧的，这时宁可返回空指纹（App 不做校验），
      // 也不能返回别版包的 sha256 把正常下载判成「校验不一致」。
      const sameVersion = Number(row.version_code) === fallback.versionCode;
      return res.json({
        platform,
        versionCode: Number(row.version_code),
        versionName: row.version_name,
        url: row.url || fallback.url,
        notes: row.notes || fallback.notes,
        force: Number(row.force) === 1,
        minSupported: Number(row.min_supported),
        sha256: sameVersion ? fallback.sha256 : '',
        size: sameVersion ? fallback.size : 0
      });
    }
  } catch {
    // 表还没建好 / 查库失败也照样返回，App 启动不能被这个接口卡住
  }
  return res.json({ platform, ...fallback });
}));

// ------------------------------------------------------- /api/download/apk
//
// 安装包直接放在仓库里（server/public/shike.apk，只有 ~75 KB），由本服务发出去。
// 这样 APK 的地址**永远不变**，也不用每次发版去 GitHub 建 Release 传附件 ——
// 发版脚本把新包覆盖到这里、push 一下，Render 自动重新部署就完成了。
// 注意：Render 免费实例 15 分钟无流量会休眠，第一个下载请求可能要等 30-60 秒唤醒。
app.get('/api/download/apk', (req, res) => {
  const file = path.join(HERE, '..', 'public', 'shike.apk');
  if (!fs.existsSync(file)) return res.status(404).json({ error: '安装包还没上传' });
  const st = fs.statSync(file);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', 'attachment; filename="shike.apk"');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
});

// -------------------------------------------------------------- 兜底处理

app.use((req, res) => {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err?.message || '服务器内部错误' });
});

// ---------------------------------------------------------------- 启动

const server = app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}  (db: ${dbUrl})`);
});

initDb()
  .then(() => backfillUserUids())
  .then(() => cleanupExpiredSessions())
  .catch((err) => {
    console.error('[fatal] 数据库初始化失败，请检查 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN：', err);
    // 不退出进程：Render 上还能靠 / 和 /api/version 做存活探测，DB 恢复后自动可用
  });

// Render 免费实例会休眠，定时器在冷启动场景下没有意义：会话清理只在启动时跑一次
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  // 只记日志，保持进程存活（Render 会自己重启崩溃的实例）
  console.error('[uncaughtException]', err);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[server] 收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export default app;

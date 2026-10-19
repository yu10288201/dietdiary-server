// server/src/photos.js
// 饭菜照片：上传到阿里云 OSS，数据库只存「谁、哪天、哪一餐、对象 key、多大」。
//
// 为什么图片不存数据库：Turso 免费额度 5 GB，按一个用户一天 3 张、一张 150 KB 算，
// 100 个活跃用户每月就是 1.35 GB，三四个月就满；而且每次看图都要过一遍数据库和
// 这个 512 MB 的免费实例，没法用 CDN 缓存。图片放对象存储、库里只存 key，
// 是这件事的标准做法。
//
// 为什么上传走自己的服务器而不是「客户端直传 + 预签名」：直传要用户在自己手机浏览器里
// PUT 到 OSS，得先给 Bucket 配 CORS，配错就是一个看不懂的跨域错误。现在的图压到
// 100–200 KB，过一下服务器也就几十毫秒、几百 KB 流量，先用最不容易出错的方式；
// 等真到了带宽吃紧那天再换直传（接口形状不用变，客户端只改一行 URL 来源）。

import express from 'express';
import { requireAuth } from './auth.js';
import { all, get, run } from './db.js';
import { deleteObject, keyBelongsTo, newObjectKey, publicUrl, putObject, storageReady, storageInfo } from './storage.js';

const router = express.Router();

/* 图片走 base64 传，1.4 倍膨胀；4 MB 对应原图约 2.9 MB，客户端的 896px JPEG 远小于此 */
router.use(express.json({ limit: '4mb' }));

const TZ_OFFSET_H = Number(process.env.RECOGNIZE_TZ_OFFSET_HOURS || 8);
const MAX_BYTES = Math.max(64 * 1024, Number(process.env.PHOTO_MAX_BYTES || 3 * 1024 * 1024));
/* 每人每天最多传几张：防有人拿它当免费图床。一天三顿 + 两张加餐，30 张很宽松 */
const DAILY_LIMIT = Math.max(1, Math.floor(Number(process.env.PHOTO_DAILY_LIMIT || 30)));
const MAX_CAPTION = 120;
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack', 'preworkout', 'postworkout', 'latenight'];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

function h(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function todayStr() {
  return new Date(Date.now() + TZ_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

function cleanString(v, maxLen) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** 从 data URL 里解出二进制 + 真实类型（按文件头猜，不信客户端给的 MIME） */
function decodeImage(raw) {
  const s = String(raw || '');
  if (!s.startsWith('data:')) throw new HttpError(400, 'image 需要是 data:image/jpeg;base64,... 形式');
  const comma = s.indexOf(',');
  if (comma < 0) throw new HttpError(400, 'data URL 格式不对');
  const header = s.slice(0, comma);
  if (!/;base64$/i.test(header)) throw new HttpError(400, '只支持 base64 编码的 data URL');
  let buf;
  try {
    buf = Buffer.from(s.slice(comma + 1), 'base64');
  } catch (e) {
    throw new HttpError(400, 'base64 解码失败');
  }
  if (!buf.length) throw new HttpError(400, '图片是空的');
  if (buf.length > MAX_BYTES) {
    throw new HttpError(413, `图片太大了（${Math.round(buf.length / 1024)} KB），压缩后应小于 ${Math.round(MAX_BYTES / 1024)} KB`);
  }

  // 魔数嗅探：JPEG FFD8FF / PNG 89504E47 / WEBP RIFF....WEBP
  let mime = '';
  let ext = '';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    mime = 'image/jpeg'; ext = 'jpg';
  } else if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    mime = 'image/png'; ext = 'png';
  } else if (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    mime = 'image/webp'; ext = 'webp';
  } else {
    throw new HttpError(415, '只支持 JPEG / PNG / WebP 图片');
  }
  return { buf, mime, ext };
}

function shapePhoto(row) {
  return {
    id: Number(row.id),
    date: row.date,
    meal: row.meal,
    url: publicUrl(row.object_key),
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    bytes: Number(row.bytes) || 0,
    caption: row.caption || '',
    createdAt: Number(row.created_at)
  };
}

/* --------------------------------------------------------------- 状态 */
/* 客户端打开拍照/相册前先问一声，没配存储就把入口藏掉，别让用户传完了才报错 */
router.get('/storage/status', requireAuth, h(async (req, res) => {
  const today = todayStr();
  const used = await get('SELECT COUNT(*) AS n FROM photos WHERE user_id = ? AND date = ?',
    [req.user.id, today]);
  res.json({
    ok: true,
    enabled: storageReady(),
    ...storageInfo(),
    dailyLimit: DAILY_LIMIT,
    usedToday: Number(used && used.n) || 0
  });
}));

/* --------------------------------------------------------------- 上传 */
router.post('/photos', requireAuth, h(async (req, res) => {
  const body = req.body || {};
  if (!storageReady()) {
    throw new HttpError(503, '服务端还没配对象存储（OSS_ACCESS_KEY_ID / OSS_BUCKET 等），照片功能没开');
  }

  const date = cleanString(body.date, 10) || todayStr();
  if (!isValidDate(date)) throw new HttpError(400, 'date 需为 YYYY-MM-DD 格式');
  if (date > todayStr(1)) throw new HttpError(400, '不能给未来日期存照片');
  const meal = MEALS.includes(String(body.meal || '')) ? String(body.meal) : 'lunch';
  const caption = cleanString(body.caption, MAX_CAPTION);
  const width = Math.max(0, Math.min(12000, Math.round(Number(body.width) || 0)));
  const height = Math.max(0, Math.min(12000, Math.round(Number(body.height) || 0)));

  // 每天限额：直接数 photos 表，不用额外的计数表，也不会因为重启清零
  const usedRow = await get('SELECT COUNT(*) AS n FROM photos WHERE user_id = ? AND date = ?',
    [req.user.id, date]);
  if ((Number(usedRow && usedRow.n) || 0) >= DAILY_LIMIT) {
    throw new HttpError(429, `今天存的照片到上限了（每天 ${DAILY_LIMIT} 张）`);
  }

  const { buf, mime, ext } = decodeImage(body.image);
  const key = newObjectKey(req.user.id, ext);

  try {
    await putObject(key, buf, mime);
  } catch (err) {
    console.error('[photos] 上传失败:', err.message);
    throw new HttpError(502, '照片存不上去：' + err.message);
  }

  const now = Date.now();
  const result = await run(
    `INSERT INTO photos (user_id, date, meal, object_key, mime, bytes, width, height, caption, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, date, meal, key, mime, buf.length, width, height, caption, now]
  );

  const row = await get('SELECT * FROM photos WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json({ photo: shapePhoto(row), ok: true });
}));

/* --------------------------------------------------------------- 我某天的照片 */
router.get('/photos', requireAuth, h(async (req, res) => {
  const date = cleanString(req.query.date, 10) || todayStr();
  if (!isValidDate(date)) throw new HttpError(400, 'date 需为 YYYY-MM-DD 格式');
  const rows = await all(
    'SELECT * FROM photos WHERE user_id = ? AND date = ? ORDER BY created_at ASC',
    [req.user.id, date]
  );
  res.json({ date, photos: rows.map(shapePhoto) });
}));

/* --------------------------------------------------------------- 删一张 */
router.delete('/photos/:id', requireAuth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const row = await get('SELECT * FROM photos WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, '照片不存在');
  if (Number(row.user_id) !== req.user.id) throw new HttpError(403, '只能删自己的照片');

  await run('DELETE FROM photos WHERE id = ?', [id]);
  if (keyBelongsTo(row.object_key, req.user.id)) await deleteObject(row.object_key);
  res.json({ ok: true });
}));

/* ------------------------------------------------- 朋友圈：我和好友的照片流 */
/* 按时间倒序、游标分页（before = 上一页最后一张的 createdAt）。
   不加 offset 分页：翻页时有人新传了照片，offset 会漏拍或重拍。 */
router.get('/photos/feed', requireAuth, h(async (req, res) => {
  const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 24));
  const before = Number(req.query.before) || 0;

  const ids = await visibleAuthorIds(req.user.id);
  const marks = ids.map(() => '?').join(', ');
  const args = ids.slice();
  let where = `WHERE user_id IN (${marks})`;
  if (before > 0) { where += ' AND created_at < ?'; args.push(before); }

  const rows = await all(
    `SELECT * FROM photos ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    args
  );

  const photos = await decoratePhotos(rows, req.user.id);
  const last = rows.length === limit ? photos[photos.length - 1] : null;
  res.json({
    photos,
    hasMore: rows.length === limit,
    nextBefore: last ? last.createdAt : 0
  });
}));

/* --------------------------------------------------------- 单张照片的详情 */
router.get('/photos/:id', requireAuth, h(async (req, res) => {
  const row = await loadVisiblePhoto(req.params.id, req.user.id);
  const [photo] = await decoratePhotos([row], req.user.id);
  const comments = await listComments(Number(row.id), req.user.id);
  res.json({ photo, comments });
}));

/* ------------------------------------------------------------- 点赞（切换） */
router.post('/photos/:id/like', requireAuth, h(async (req, res) => {
  const row = await loadVisiblePhoto(req.params.id, req.user.id);
  const pid = Number(row.id);
  const mine = await get('SELECT 1 AS x FROM photo_likes WHERE photo_id = ? AND user_id = ?',
    [pid, req.user.id]);
  let liked;
  if (mine) {
    await run('DELETE FROM photo_likes WHERE photo_id = ? AND user_id = ?', [pid, req.user.id]);
    liked = false;
  } else {
    await run('INSERT INTO photo_likes (photo_id, user_id, created_at) VALUES (?, ?, ?)',
      [pid, req.user.id, Date.now()]);
    liked = true;
  }
  const c = await get('SELECT COUNT(*) AS n FROM photo_likes WHERE photo_id = ?', [pid]);
  res.json({ ok: true, liked, likes: Number(c && c.n) || 0 });
}));

/* ------------------------------------------------------------- 打分（1–5 星） */
router.post('/photos/:id/rate', requireAuth, h(async (req, res) => {
  const row = await loadVisiblePhoto(req.params.id, req.user.id);
  const pid = Number(row.id);
  const stars = Math.round(Number((req.body || {}).stars));
  if (!Number.isFinite(stars) || stars < 0 || stars > 5) {
    throw new HttpError(400, 'stars 需要是 0–5 的整数（0 表示取消打分）');
  }
  if (stars === 0) {
    await run('DELETE FROM photo_ratings WHERE photo_id = ? AND rater_id = ?', [pid, req.user.id]);
  } else {
    await run(
      `INSERT INTO photo_ratings (photo_id, rater_id, stars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(photo_id, rater_id) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`,
      [pid, req.user.id, stars, Date.now()]
    );
  }
  res.json({ ok: true, rating: await ratingOf(pid, req.user.id) });
}));

/* --------------------------------------------------------------- 评论 */
router.post('/photos/:id/comments', requireAuth, h(async (req, res) => {
  const row = await loadVisiblePhoto(req.params.id, req.user.id);
  const pid = Number(row.id);
  const body = cleanString((req.body || {}).text, 200);
  if (!body) throw new HttpError(400, '评论不能为空');
  const now = Date.now();
  const r = await run(
    'INSERT INTO photo_comments (photo_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
    [pid, req.user.id, body, now]
  );
  const u = await get('SELECT id, username, display_name, avatar_color, uid FROM users WHERE id = ?',
    [req.user.id]);
  res.status(201).json({
    ok: true,
    comment: {
      id: Number(r.lastInsertRowid),
      body,
      createdAt: now,
      mine: true,
      author: shapeAuthor(u)
    }
  });
}));

router.get('/photos/:id/comments', requireAuth, h(async (req, res) => {
  const row = await loadVisiblePhoto(req.params.id, req.user.id);
  res.json({ comments: await listComments(Number(row.id), req.user.id), ok: true });
}));

router.delete('/photo-comments/:id', requireAuth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const c = await get('SELECT * FROM photo_comments WHERE id = ?', [id]);
  if (!c) throw new HttpError(404, '评论不存在');
  const photo = await get('SELECT * FROM photos WHERE id = ?', [Number(c.photo_id)]);
  const canDelete = Number(c.user_id) === req.user.id || (photo && Number(photo.user_id) === req.user.id);
  if (!canDelete) throw new HttpError(403, '只能删自己的评论或自己照片下的评论');
  await run('DELETE FROM photo_comments WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/* --------------------------------------------------------- 改文案（只有作者） */
router.patch('/photos/:id', requireAuth, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const row = await get('SELECT * FROM photos WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, '照片不存在');
  if (Number(row.user_id) !== req.user.id) throw new HttpError(403, '只能改自己照片的文案');
  const caption = cleanString((req.body || {}).caption, MAX_CAPTION);
  await run('UPDATE photos SET caption = ? WHERE id = ?', [caption, id]);
  const [photo] = await decoratePhotos([{ ...row, caption }], req.user.id);
  res.json({ ok: true, photo });
}));

/* ----------------------------------------------------------- 小工具 */
function shapeAuthor(u) {
  return {
    id: Number(u && u.id) || 0,
    username: (u && u.username) || '',
    displayName: (u && u.display_name) || '',
    avatarColor: (u && u.avatar_color) || '#9E9E9E',
    uid: (u && u.uid) || ''
  };
}

/** 我 + 已接受的好友，这批人的照片对我可见 */
async function visibleAuthorIds(userId) {
  const friendRows = await all(
    `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS fid
       FROM friendships
      WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
    [userId, userId, userId]
  );
  const ids = [userId];
  for (const r of friendRows) {
    const fid = Number(r.fid);
    if (fid && ids.indexOf(fid) < 0) ids.push(fid);
  }
  return ids;
}

/** 取一张照片并鉴权：自己的，或者好友的；否则 403/404 */
async function loadVisiblePhoto(rawId, viewerId) {
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'id 无效');
  const row = await get('SELECT * FROM photos WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, '照片不存在');
  if (Number(row.user_id) !== viewerId) {
    const ids = await visibleAuthorIds(viewerId);
    if (ids.indexOf(Number(row.user_id)) < 0) throw new HttpError(403, '看不到这张照片');
  }
  return row;
}

async function ratingOf(photoId, viewerId) {
  const agg = await get(
    'SELECT COUNT(*) AS count, AVG(stars) AS avg FROM photo_ratings WHERE photo_id = ?', [photoId]);
  const mine = await get(
    'SELECT stars FROM photo_ratings WHERE photo_id = ? AND rater_id = ?', [photoId, viewerId]);
  const count = Number(agg && agg.count) || 0;
  const avg = count ? Math.round(Number(agg.avg) * 10) / 10 : 0;
  return { avg, count, mine: mine ? Number(mine.stars) : 0 };
}

async function listComments(photoId, viewerId) {
  const rows = await all(
    `SELECT c.*, u.username, u.display_name, u.avatar_color, u.uid
       FROM photo_comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.photo_id = ? ORDER BY c.id ASC`,
    [photoId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    body: r.body,
    createdAt: Number(r.created_at),
    mine: Number(r.user_id) === viewerId,
    userId: Number(r.user_id),
    author: shapeAuthor({ id: r.user_id, username: r.username, display_name: r.display_name,
      avatar_color: r.avatar_color, uid: r.uid })
  }));
}

/** 一批照片补齐：作者、点赞数、我点没点、评论数、打分 */
async function decoratePhotos(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const marks = ids.map(() => '?').join(', ');

  const authorIds = [];
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (authorIds.indexOf(uid) < 0) authorIds.push(uid);
  }
  const userMap = new Map();
  if (authorIds.length) {
    const userRows = await all(
      `SELECT id, username, display_name, avatar_color, uid FROM users
        WHERE id IN (${authorIds.map(() => '?').join(', ')})`,
      authorIds
    );
    for (const u of userRows) userMap.set(Number(u.id), u);
  }

  const likeRows = await all(
    `SELECT photo_id, COUNT(*) AS n FROM photo_likes WHERE photo_id IN (${marks}) GROUP BY photo_id`,
    ids
  );
  const likeMap = new Map(likeRows.map((r) => [Number(r.photo_id), Number(r.n) || 0]));

  const mineRows = await all(
    `SELECT photo_id FROM photo_likes WHERE user_id = ? AND photo_id IN (${marks})`,
    [viewerId].concat(ids)
  );
  const mineSet = new Set(mineRows.map((r) => Number(r.photo_id)));

  const cmtRows = await all(
    `SELECT photo_id, COUNT(*) AS n FROM photo_comments WHERE photo_id IN (${marks}) GROUP BY photo_id`,
    ids
  );
  const cmtMap = new Map(cmtRows.map((r) => [Number(r.photo_id), Number(r.n) || 0]));

  const rateRows = await all(
    `SELECT photo_id, COUNT(*) AS c, AVG(stars) AS a FROM photo_ratings
      WHERE photo_id IN (${marks}) GROUP BY photo_id`,
    ids
  );
  const rateMap = new Map(rateRows.map((r) => [Number(r.photo_id),
    { avg: Number(r.c) ? Math.round(Number(r.a) * 10) / 10 : 0, count: Number(r.c) || 0 }]));

  const myRateRows = await all(
    `SELECT photo_id, stars FROM photo_ratings WHERE rater_id = ? AND photo_id IN (${marks})`,
    [viewerId].concat(ids)
  );
  const myRateMap = new Map(myRateRows.map((r) => [Number(r.photo_id), Number(r.stars)]));

  return rows.map((row) => {
    const pid = Number(row.id);
    const r = rateMap.get(pid) || { avg: 0, count: 0 };
    return {
      ...shapePhoto(row),
      mine: Number(row.user_id) === viewerId,
      author: shapeAuthor(userMap.get(Number(row.user_id))),
      likes: likeMap.get(pid) || 0,
      likedByMe: mineSet.has(pid),
      commentCount: cmtMap.get(pid) || 0,
      rating: { avg: r.avg, count: r.count, mine: myRateMap.get(pid) || 0 }
    };
  });
}

/* 给 index.js 的 feed 用：按 (user_id, date) 批量取照片，一条 SQL 解决 */
export async function photosByOwners(pairs) {
  if (!pairs || !pairs.length) return new Map();
  const clauses = [];
  const args = [];
  for (const p of pairs) {
    clauses.push('(user_id = ? AND date = ?)');
    args.push(Number(p.userId), p.date);
  }
  const rows = await all(
    `SELECT * FROM photos WHERE ${clauses.join(' OR ')} ORDER BY created_at ASC`,
    args
  );
  const map = new Map();
  for (const row of rows) {
    const k = `${Number(row.user_id)}|${row.date}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(shapePhoto(row));
  }
  return map;
}

export { router as photosRouter };

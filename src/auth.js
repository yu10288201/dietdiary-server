// server/src/auth.js
// 极简鉴权：
//   * 密码用 node:crypto 的 scrypt 加盐哈希（不需要额外依赖）
//   * 登录成功签发一个 32 字节随机 token，存进 sessions 表（服务端可随时作废）
//   * 每个请求带 Authorization: Bearer <token>，中间件查 sessions 表得到 user
//
// 注意：不需要 JWT_SECRET 也能跑；JWT_SECRET 只是额外掺进 token 派生里，
// 让「换密钥即等于旧 token 全部失效」（更保险，也方便强制下线）。

import crypto from 'node:crypto';
import { all, get, run } from './db.js';

// scrypt 参数：N=16384, r=8, p=1（Node 默认 maxmem 之内）
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

const SESSION_TTL_MS =
  Math.max(1, Number(process.env.SESSION_TTL_DAYS || 90)) * 24 * 60 * 60 * 1000;

const PEPPER = process.env.JWT_SECRET || '';

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** 生成 "scrypt$N$r$p$saltB64$hashB64" 形式的密码哈希 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    Buffer.from(derived).toString('base64')
  ].join('$');
}

/** 校验密码，时间复杂度与哈希时一致 */
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = Buffer.from(
      await scryptAsync(password, salt, expected.length, { N, r, p })
    );
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 签发会话 token 并落库 */
export async function createSession(userId) {
  const token = crypto
    .createHmac('sha256', PEPPER)
    .update(crypto.randomBytes(32))
    .digest('base64url');
  const now = Date.now();
  await run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, userId, now, now + SESSION_TTL_MS]
  );
  // 顺手清掉这个用户已过期的会话，省得表无限长大
  await run('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?', [userId, now]);
  return token;
}

/** 注销会话 */
export async function destroySession(token) {
  if (!token) return;
  await run('DELETE FROM sessions WHERE token = ?', [token]);
}

/**
 * 清理所有过期会话。只在服务启动时跑一次。
 * Render 免费实例会休眠，进程内定时器在冷启动场景下没有意义，所以不注册 setInterval。
 */
export async function cleanupExpiredSessions() {
  const { changes } = await run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  if (changes > 0) console.log(`[auth] 清理过期会话 ${changes} 条`);
  return changes;
}

export const USER_COLUMNS =
  'id, username, display_name, avatar_color, goal_text, created_at';

/** 把数据库行转成对外返回的 user 对象 */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    goalText: row.goal_text,
    createdAt: Number(row.created_at)
  };
}

export async function findUserByUsername(username) {
  return get(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`,
    [username]
  );
}

export async function findUserById(id) {
  return get(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [Number(id)]);
}

/** 按 id 批量取用户，返回 Map<id, publicUser> */
export async function mapUsersByIds(ids) {
  const unique = [...new Set(ids.map((v) => Number(v)).filter((v) => Number.isFinite(v)))];
  const map = new Map();
  if (!unique.length) return map;
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await all(
    `SELECT ${USER_COLUMNS} FROM users WHERE id IN (${placeholders})`,
    unique
  );
  for (const row of rows) {
    const user = toPublicUser(row);
    map.set(user.id, user);
  }
  return map;
}

function extractToken(req) {
  const header = req.get('authorization') || req.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  const alt = req.get('x-auth-token');
  return alt ? String(alt).trim() : '';
}

/**
 * Express 中间件：必须带合法 token，成功时挂 req.user / req.token。
 */
export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: '缺少登录凭证（Authorization: Bearer <token>）' });
    }
    const row = await get(
      `SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.avatar_color, u.goal_text, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
      [token]
    );
    if (!row) {
      return res.status(401).json({ error: '登录已失效，请重新登录' });
    }
    if (Number(row.expires_at) <= Date.now()) {
      await destroySession(token);
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    req.token = token;
    req.user = toPublicUser(row);
    return next();
  } catch (err) {
    return next(err);
  }
}

/** 可选鉴权：带了 token 就解析，没带/无效也放行（给 /api/version 之类的公开接口用） */
export async function optionalAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      const row = await get(
        `SELECT s.expires_at, u.id, u.username, u.display_name, u.avatar_color, u.goal_text, u.created_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`,
        [token]
      );
      if (row && Number(row.expires_at) > Date.now()) {
        req.token = token;
        req.user = toPublicUser(row);
      }
    }
  } catch {
    // 忽略：可选鉴权失败不影响主流程
  }
  return next();
}

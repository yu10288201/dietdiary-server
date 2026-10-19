// server/src/db.js
// Turso（libSQL）客户端初始化 + 建表兜底。
//
// 环境变量：
//   TURSO_DATABASE_URL  libsql://xxx.turso.io   取法：turso db show <db> --url
//   TURSO_AUTH_TOKEN    eyJ...                  取法：turso db tokens create <db>
// 两者都缺省时退化成本地文件库 file:./local.db，方便本机开发；
// 但 Render 免费实例的磁盘是临时的、重启即清空，线上必须配 Turso。

import { createClient } from '@libsql/client';

const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

let url = rawUrl;
if (!url) {
  url = 'file:./local.db';
  console.warn('[db] 未设置 TURSO_DATABASE_URL，退化为本地文件数据库 file:./local.db（仅供本地开发）');
} else if (url.startsWith('http://') || url.startsWith('https://')) {
  // Turso 控制台有时给的是 https:// 形式，转成 libsql:// 让 SDK 走正确的协议
  url = url.replace(/^https?:\/\//, 'libsql://');
}

export const db = createClient(
  authToken ? { url, authToken } : { url }
);

export const dbUrl = url;

// 与 schema.sql 完全一致的建表语句，进程启动时执行一遍，保证表一定存在。
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    avatar_color  TEXT    NOT NULL DEFAULT '#FF8A65',
    goal_text     TEXT    NOT NULL DEFAULT '',
    uid           TEXT,
    created_at    INTEGER NOT NULL
  )`,
  // 唯一短号（6 位）。老库建表语句里没有这列，靠下面的 ALTER 补；补不进就是已经存在。
  `ALTER TABLE users ADD COLUMN uid TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS friendships (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT    NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (requester_id, addressee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status)`,
  `CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT    NOT NULL,
    goal_text   TEXT    NOT NULL DEFAULT '',
    meals_json  TEXT    NOT NULL DEFAULT '{}',
    totals_json TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_user_date ON posts(user_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date)`,
  `CREATE TABLE IF NOT EXISTS likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (post_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
  `CREATE TABLE IF NOT EXISTS cheers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id      INTEGER,
    date         TEXT    NOT NULL DEFAULT '',
    message      TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cheers_to ON cheers(to_user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cheers_from ON cheers(from_user_id, created_at)`,
  // 饮食记录本体：一人一天一行。老版本只把当天记录当「动态」推给好友看，
  // 没有回拉接口，换手机就丢；这张表才是真正存数据的地方。
  `CREATE TABLE IF NOT EXISTS diary (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,
    entries_json TEXT    NOT NULL DEFAULT '[]',
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary(user_id, date)`,
  // 身体档案（身高体重/目标）和体重记录：一人一份，整块 JSON 存，按 updated_at 取新的
  // 拍照识别的每日计数：一人一天一行。
  // 为什么不放进程内存：Render 免费实例空闲十几分钟就休眠，一醒来内存清零，
  // 限额等于没有。进库才能真正做到「每人每天 N 次」，重启/多实例都算同一本账。
  // 主键 (user_id, date) 让它能用一句 UPSERT 原子地「占一次额度」。
  `CREATE TABLE IF NOT EXISTS recognize_usage (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    n          INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, date)
  )`,
  // 饭菜照片：一行一张，object_key 指向阿里云 OSS 里的对象。
  // 图片本体不放这里（5 GB 免费额度几个月就满，而且看图要过服务器、没法上 CDN）。
  // 按 (user_id, date) 关联而不是 post_id：重新发布当天动态时 posts 是删了重插的，
  // 照片不该跟着掉；发布/覆盖只影响可见性，不影响照片本身。
  `CREATE TABLE IF NOT EXISTS photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    meal       TEXT    NOT NULL DEFAULT 'lunch',
    object_key TEXT    NOT NULL,
    mime       TEXT    NOT NULL DEFAULT 'image/jpeg',
    bytes      INTEGER NOT NULL DEFAULT 0,
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    caption    TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_photos_user_date ON photos(user_id, date)`,
  // 给好友的这顿饭打分（1–5 星）。主键 (作者, 日期, 打分人) 而不是 post_id：
  // 理由同 photos —— 重新发布动态不该把别人打过的分丢掉。
  `CREATE TABLE IF NOT EXISTS post_ratings (
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,
    rater_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars      INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (author_id, date, rater_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_profile (
    user_id    INTEGER NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data_json  TEXT    NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_versions (
    platform      TEXT    NOT NULL,
    version_code  INTEGER NOT NULL,
    version_name  TEXT    NOT NULL,
    url           TEXT    NOT NULL DEFAULT '',
    notes         TEXT    NOT NULL DEFAULT '',
    force         INTEGER NOT NULL DEFAULT 0,
    min_supported INTEGER NOT NULL DEFAULT 1,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (platform)
  )`
];

let initPromise = null;

/** 确保所有表都存在；进程内只会真正执行一次，失败可重试。 */
export function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      for (const sql of SCHEMA_STATEMENTS) {
        try {
          await db.execute(sql);
        } catch (err) {
          // ALTER TABLE ... ADD COLUMN 在列已存在时会报 duplicate column name，
          // 那是正常情况（老库升级一次后就不再需要），其它错误照旧抛出。
          const msg = String(err?.message || '');
          const isAddColumn = /^\s*ALTER\s+TABLE/i.test(sql);
          if (isAddColumn && /duplicate column|already exists/i.test(msg)) continue;
          throw err;
        }
      }
      // libSQL 默认外键级联是关闭的，本地/远端都显式打开（失败不影响主流程）
      try {
        await db.execute('PRAGMA foreign_keys = ON');
      } catch (err) {
        console.warn('[db] PRAGMA foreign_keys 设置失败（可忽略）:', err.message);
      }
      console.log(`[db] schema 就绪 -> ${url}`);
    })().catch((err) => {
      initPromise = null; // 允许下一个请求重试
      throw err;
    });
  }
  return initPromise;
}

/**
 * 查询封装。
 * @param {string} sql 带 ? 占位符的参数化 SQL
 * @param {Array<any>} args 参数
 * @returns {Promise<Array<object>>} 行数组（普通对象）
 */
export async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

/** 查询单行，没有则返回 null。 */
export async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

/**
 * 写操作（INSERT / UPDATE / DELETE）。
 * @returns {Promise<{changes:number,lastInsertRowid:number}>} lastInsertRowid 是 Number
 */
export async function run(sql, args = []) {
  const result = await db.execute({ sql, args });
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0)
  };
}

/** 一次事务写多条（批量动态等场景）。传 [{sql, args}]。 */
export async function batch(statements) {
  return db.batch(statements, 'write');
}

-- 饮食记录 · 社交功能后端 建表语句
-- 数据库：Turso（libSQL / SQLite）
-- 用法（可选，服务启动时 src/db.js 也会自动执行一遍同样的语句）：
--   turso db shell dietdiary < server/schema.sql
--
-- 说明：
--   * 所有时间戳都是毫秒级 Unix 时间（INTEGER）
--   * date 字段是 'YYYY-MM-DD' 文本，按用户本地日期算，服务端做格式校验

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,          -- 登录名，存小写归一化后的值
  display_name  TEXT    NOT NULL,                 -- 昵称
  password_hash TEXT    NOT NULL,                 -- scrypt: scrypt$N$r$p$saltB64$hashB64
  avatar_color  TEXT    NOT NULL DEFAULT '#FF8A65',
  goal_text     TEXT    NOT NULL DEFAULT '',      -- 个人目标（展示在动态卡片上）
  uid           TEXT,                             -- 6 位永久短号（如 7F3K2M），社交用它加好友
  created_at    INTEGER NOT NULL
);
-- 老库升级：把短号列补上（已存在时报 duplicate column name，忽略即可）
ALTER TABLE users ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- 会话（随机 token 直接存库，服务端可随时作废）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 好友关系（一对用户最多一条记录）
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);

-- 每日动态（同一个人同一天只保留一条，再发就是覆盖）
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,                    -- YYYY-MM-DD
  goal_text  TEXT    NOT NULL DEFAULT '',
  meals_json TEXT    NOT NULL DEFAULT '{}',       -- {"breakfast":[...],"lunch":[...]}
  totals_json TEXT   NOT NULL DEFAULT '{}',       -- {"kcal":0,"p":0,"f":0,"ch":0}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 部分唯一索引：同一用户同一天只允许一条「有效动态」
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_user_date ON posts(user_id, date);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);

-- 点赞
CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

-- 评论
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- 饮食记录本体（一人一天一行）。posts 只是给好友看的「动态快照」，
-- 换手机要能还原自己的记录，就必须有这张真正存数据的表。
CREATE TABLE IF NOT EXISTS diary (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL,                  -- YYYY-MM-DD
  entries_json TEXT    NOT NULL DEFAULT '[]',     -- [{id,name,meal,grams,kcal,p,f,ch,ts,...}]
  updated_at   INTEGER NOT NULL,                  -- 最后一次改动时间（毫秒）
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary(user_id, date);

-- 催更（给好友发一条提醒）CREATE TABLE IF NOT EXISTS cheers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id      INTEGER,
  date         TEXT    NOT NULL DEFAULT '',
  message      TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cheers_to ON cheers(to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cheers_from ON cheers(from_user_id, created_at);

-- 版本信息（GET /api/version 用，没配置环境变量时 fallback 也读这张表）
CREATE TABLE IF NOT EXISTS app_versions (
  platform     TEXT    NOT NULL,
  version_code INTEGER NOT NULL,
  version_name TEXT    NOT NULL,
  url          TEXT    NOT NULL DEFAULT '',
  notes        TEXT    NOT NULL DEFAULT '',
  force        INTEGER NOT NULL DEFAULT 0,
  min_supported INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (platform)
);

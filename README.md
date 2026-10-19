# 饮食记录 · 社交功能后端（Express + Turso）

给「饮食记录」Android App 用的社交后端：注册登录、好友、每日动态 feed、点赞、评论、催更、App 版本检查。
全部跑在**免费额度**上：数据库 **Turso**（libSQL，免费档 100 个库 / 共 5 GB 存储 / 每月 5 亿次行读、1000 万次行写），
服务托管 **Render**（Free Web Service，750 实例小时/月，15 分钟无流量休眠）。

技术栈就四个依赖：`express`、`@libsql/client`、`cors`、`dotenv`。Node 18+，ESM。

---

## 目录结构

```
server/
├── package.json          # 依赖 + npm start
├── .env.example          # 环境变量模板（复制成 .env）
├── schema.sql            # 建表语句（可选，服务启动时也会自动建表）
├── version.json          # App 更新清单示例（字段说明见第三节；服务运行时并不读它，它只是模板）
├── README.md
└── src/
    ├── index.js          # Express 应用 + 全部路由
    ├── db.js             # Turso 客户端初始化 + 建表兜底
    └── auth.js           # scrypt 密码哈希 + 会话 token
```

---

## 一、本地跑起来

```bash
cd server
cp .env.example .env        # Windows: copy .env.example .env
# 编辑 .env，填入 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN / JWT_SECRET
npm install
npm start
# -> [server] listening on :3000
```

**没有 Turso 账号也想先跑通？** 把 `.env` 里的 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN` 两行都注释掉，
`db.js` 会自动退化成本地文件库 `file:./local.db`，接口行为完全一致。**但 Render 上必须用 Turso**，
因为免费实例的磁盘是临时的，重启/重新部署就清空。

自测：

```bash
curl http://localhost:3000/api/version?platform=android
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123","displayName":"小爱"}'
```

---

## 二、创建 Turso 数据库并拿到 URL / Token

### 1. 安装并登录 Turso CLI

```bash
# macOS / Linux
curl -sSfL https://get.tur.so/install.sh | bash

# Windows（PowerShell，需要 WSL 或直接用下面的 npm 方式）
npm install -g turso        # 或者用官方安装脚本

turso auth login            # 会打开浏览器授权（GitHub 账号即可）
```

### 2. 建库

```bash
turso db create dietdiary
```

### 3. 取数据库 URL

```bash
turso db show dietdiary --url
# 输出形如： libsql://dietdiary-yourname.turso.io
```

> `--url` 给的是 `libsql://` 连接地址，直接填 `TURSO_DATABASE_URL`。
> （还有 `--http-url` 是 HTTP API 地址，本项目不需要。）

### 4. 取鉴权 token

```bash
turso db tokens create dietdiary
# 输出形如： eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoi...
```

> token 只在创建时显示一次，**复制好**。填 `TURSO_AUTH_TOKEN`。
> 建议给 token 加过期时间：`turso db tokens create dietdiary --expiration 1y`（或 `never`）。
> 想作废重发：`turso db tokens invalidate dietdiary` —— 换完记得同步更新 Render 环境变量。

### 5.（可选）提前建表

服务启动时会自动执行 `src/db.js` 里的建表语句，**这一步可以跳过**。
想手动建或想检查表结构：

```bash
turso db shell dietdiary < server/schema.sql
turso db shell dietdiary ".tables"
turso db shell dietdiary ".schema posts"
```

---

## 三、部署到 Render（免费 Web Service）

### 1. 把代码推到 GitHub

```bash
git init
git add .
git commit -m "dietdiary social backend"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dietdiary-server.git
git push -u origin main
```

> `.gitignore` 里别把 `.env` 提交上去（`.env.example` 可以提交）。

### 2. 在 Render 建 Web Service

1. 登录 <https://dashboard.render.com> → 右上角 **New +** → **Web Service**
2. **Connect a repository**：选你的 GitHub 仓库并授权（首次需要 Install Render GitHub App）
3. 填写：

   | 字段 | 值 |
   |---|---|
   | **Name** | `dietdiary-api`（随你起，会变成域名前缀） |
   | **Region** | 选离用户近的，例如 `Singapore` |
   | **Branch** | `main` |
   | **Root Directory** | `server` ← **重要**：仓库根目录就是工程根目录时留空；如果 `server/` 是子目录，必须填 `server` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | `Free` |

4. 展开 **Environment Variables**（Advanced），逐条 **Add Environment Variable**：

   | Key | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://dietdiary-xxx.turso.io`（第 2 步 `turso db show --url` 的输出） |
   | `TURSO_AUTH_TOKEN` | `eyJhbGciOi...`（第 2 步 `turso db tokens create` 的输出） |
   | `JWT_SECRET` | 随机长字符串，见下面生成方法 |
   | `SESSION_TTL_DAYS` | `90` |
   | `APK_VERSION_CODE` | `1` |
   | `APK_VERSION_NAME` | `0.1.0` |
   | `APK_URL` | `https://<你的域名>/dietdiary-0.1.0.apk` |
   | `APK_NOTES` | 首个内测版本 |
   | `APK_FORCE` | `false` |
   | `APK_MIN_SUPPORTED` | `1` |
   | `DASHSCOPE_API_KEY` | 拍照识别用的百炼 Key（**可先不填**，不填则识别接口返回 503，其它功能不受影响） |
   | `VISION_MODEL` | `qwen3-vl-plus`（想省钱换 `qwen3-vl-flash`） |

   拍照识别的其余可选项（都有默认值，不填也能跑）：

   | Key | 默认 | 说明 |
   |---|---|---|
   | `BAILIAN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 也可以用控制台给的专属地址 `https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；末尾别带 `/chat/completions` |
   | `RECOGNIZE_DAILY_LIMIT` | `5` | 每个账号每天最多识别几次。计数存 `recognize_usage` 表，重启不丢 |
   | `RECOGNIZE_TZ_OFFSET_HOURS` | `8` | 「每天」按哪个时区清零，8 = 中国时间零点 |
   | `RECOGNIZE_MAX_IMAGE_BYTES` | `4194304` | 单张图片上限（4 MB） |
   | `RECOGNIZE_TIMEOUT_MS` | `45000` | 等模型的时间 |
   | `RECOGNIZE_MOCK` | 不设 | 设成 `1` 返回一份假数据，链路照走，用来演示/测试；设成 `empty` 返回空结果，专用于测试「没结果就退额度」 |

   > ⚠️ `DASHSCOPE_API_KEY` 是按**地域**绑定的：用北京地址就得用北京地域建的 Key，
   > 否则报 401 `invalid_api_key`。Key 只放在这里（Render 环境变量），**绝不能进 App**。

   **不要**自己设 `PORT` —— Render 会自动注入，代码里读的就是 `process.env.PORT`。

   生成 `JWT_SECRET`：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. 点 **Create Web Service**，等日志出现：

   ```
   [db] schema 就绪 -> libsql://dietdiary-xxx.turso.io
   [server] listening on :10000
   ```

6. 拿到域名 `https://dietdiary-api.onrender.com`，验证：

   ```bash
   curl https://dietdiary-api.onrender.com/api/version?platform=android
   # {"platform":"android","versionCode":1,"versionName":"0.1.0",...}
   ```

### 3. 更新版本 / 发新 APK

APK 文件别放 Render 免费实例上（磁盘会被清空）。放到 GitHub Releases、Cloudflare R2、或对象存储，
然后把 `APK_URL` / `APK_VERSION_CODE` / `APK_VERSION_NAME` / `APK_NOTES` 改成新值，
在 Render 面板 **Environment → Save Changes**，服务自动重启，App 下次启动就会收到更新提示。

改这两项之外的也可以直接写 `app_versions` 表（按 platform 一行）：

```bash
turso db shell dietdiary "INSERT INTO app_versions
 (platform, version_code, version_name, url, notes, force, min_supported, updated_at)
 VALUES ('android', 2, '0.2.0', 'https://example.com/dietdiary-0.2.0.apk', '修复若干问题', 0, 1, 0)
 ON CONFLICT(platform) DO UPDATE SET version_code=excluded.version_code, version_name=excluded.version_name,
 url=excluded.url, notes=excluded.notes, force=excluded.force, min_supported=excluded.min_supported,
 updated_at=excluded.updated_at;"
```

数据库里的记录**优先于**环境变量；表里没这个 platform 时才回退到环境变量。

### 4. `server/version.json` 是什么

它是**给人看的模板**（服务运行时不读它，只读 `app_versions` 表和 `APK_*` 环境变量），
用来记录每次发版的元信息、方便对账：

| 字段 | 含义 |
|---|---|
| `versionCode` | 整数，App 端比较大小的依据，**每次发版必须 +1** |
| `versionName` | 展示给用户看的版本号，如 `0.2.0` |
| `url` | APK 的直链（GitHub Releases / R2 / 对象存储均可） |
| `sha256` | APK 的 SHA-256，App 下载后可校验完整性 |
| `size` | APK 字节数，用于显示下载体积 |
| `notes` | 更新说明（App 弹窗里显示） |
| `force` | `true` 时 App 必须更新才能继续用 |
| `minSupported` | 低于这个 versionCode 的 App 强制更新 |
| `publishedAt` | 发布时间（ISO 8601） |
| `channel` | 发布通道，如 `stable` / `beta`（App 可选择只跟某个通道） |

真正让 App 拿到更新的还是上面第 3 步的 `app_versions` 表（或 `APK_*` 环境变量）。

---

## 四、Render 免费实例的两个坑（一定要告诉 App 端）

1. **15 分钟无流量会休眠**：免费 Web Service 在 15 分钟没有收到请求后会被挂起（spin down）。
2. **冷启动约 30–60 秒**：休眠后再来的第一个请求要等实例重新拉起，通常 **30–60 秒**才返回，
   期间可能直接超时或 502。之后恢复正常（毫秒级）。

App 端建议：

* 网络层把**连接/读取超时设到 90 秒**，并且把「首次请求慢」当成正常情况，不要直接弹「网络错误」。
* 冷启动窗口里失败一次就**自动重试 1–2 次**（指数退避 2s / 5s）。
* `/api/version` 和首页 feed 请求都按上面的超时处理；可以先请求极轻量的 `/` 或 `/healthz` 把实例唤醒。
* 想让服务常驻就得升级到付费实例；免费额度下没有官方保活手段（用外部定时器每 10 分钟 ping 一次
  能减少休眠，但每月 750 小时额度是共享的，长期挂两个服务会超）。

另外：免费实例**每次部署/重启磁盘都重置**，所以数据必须全放 Turso；本地 `local.db` 只用于开发。

---

## 五、接口一览

统一约定：

* 请求/响应都是 UTF-8 JSON。
* 需要鉴权的接口带 header：`Authorization: Bearer <token>`。
* 出错一律返回 `{"error":"..."}`，状态码：`400` 参数错、`401` 未登录/登录失效、`403` 无权操作、
  `404` 资源不存在、`409` 冲突（用户名已注册、已是好友等）、`500` 服务端异常。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | `{username,password,displayName}` → `{token,user}` |
| POST | `/api/auth/login` | 否 | `{username,password}` → `{token,user}` |
| POST | `/api/auth/logout` | 是 | 作废当前 token |
| GET | `/api/me` | 是 | `{user}` |
| PUT | `/api/me` | 是 | `{displayName?,goalText?,avatarColor?}` → `{user}` |
| GET | `/api/friends` | 是 | `{friends:[user]}` |
| POST | `/api/friends/request` | 是 | `{username}` 发起好友请求，返回 `{ok,status,request}`；对方已先申请则自动互为好友 |
| GET | `/api/friends/requests` | 是 | `{incoming:[...],outgoing:[...]}` |
| POST | `/api/friends/accept` | 是 | `{requestId}` |
| POST | `/api/friends/reject` | 是 | `{requestId}` |
| DELETE | `/api/friends/:id` | 是 | 删好友 / 撤回自己发出的请求 |
| GET | `/api/feed?date=YYYY-MM-DD&scope=friends\|me` | 是 | 见下 |
| GET | `/api/posts/:id` | 是 | 单条动态 `{post}`；只能看本人或好友的，否则 403 |
| POST | `/api/posts` | 是 | `{date,meals,totals,goalText?}`，同一天再发即覆盖 |
| DELETE | `/api/posts/:id` | 是 | 只能删自己的 |
| POST | `/api/posts/:id/like` | 是 | 切换点赞 → `{liked,likes}` |
| POST | `/api/posts/:id/comments` | 是 | `{text}`（1-500 字）→ `201 {comment}` |
| GET | `/api/posts/:id/comments` | 是 | `{comments:[...]}` 全部评论，按时间正序 |
| DELETE | `/api/comments/:id` | 是 | 评论作者或动态主人可删 |
| POST | `/api/posts/:id/cheer` | 是 | 催更；也支持 `POST /api/posts/me/cheer {toUserId\|username, date?, message?}` |
| GET | `/api/cheers` | 是 | 我收到的催更列表（最近 50 条），每项含 `from:{id,username,displayName,avatarColor}` |
| GET | `/api/version?platform=android` | **否** | 启动检查更新 |
| GET | `/api/health`（别名 `/healthz`） | 否 | `{ok:true, db:"connected"\|"error"}`，会真 ping 一次数据库 |
| GET | `/api/recognize/status` | 是 | `{ok,enabled,mock,model,remainingToday,dailyLimit}`，App 用它决定是否显示入口 |
| POST | `/api/recognize` | 是 | `{image:"data:image/jpeg;base64,..." \| 纯base64, meal?, clientId?}` → `{ok,items:[...],remainingToday,dailyLimit,cached?,refunded?,elapsedMs}` |

### 拍照识别接口

模型只负责「认菜 + 估克数 + 给一份粗营养」，最终数值由 App 用本地食物库覆盖，
库里没有的才用模型给的值并标「AI 估算」。

```json
// POST /api/recognize  请求
// meal 可省；给了就会在提示词里补一句「这是用户的早餐/夜宵」，估重更靠谱
// clientId 可省；给了就有幂等保护（见下）
{ "image": "data:image/jpeg;base64,/9j/4AAQ...", "meal": "lunch", "clientId": "m1x2y3z4" }

// 200
{
  "ok": true,
  "items": [
    { "name": "番茄炒蛋", "grams": 180, "kcal100": 120,
      "protein100": 6, "fat100": 8, "carbs100": 6, "confidence": "high" }
  ],
  "remainingToday": 4,
  "elapsedMs": 3120
}
```

响应里可能多出两个字段：

| 字段 | 什么时候出现 | 意思 |
|---|---|---|
| `cached: true` | 同一个 `clientId` 在 90 秒内重复提交 | 这是上次那份结果，**没有扣次数、没有调模型** |
| `refunded: true` | `items` 是空数组（一条都没认出来） | 这次不算数，额度已经加回去了 |

出错时的状态码：`400` 没图/格式不对、`401` 未登录、`413` 图片过大、`415` 不是
JPEG/PNG/WebP（HEIC 要先转）、`429` 当天次数用完（每人每天默认 5 次，中国时间零点重置）、
`502` 模型返回看不懂、`503` 服务器没配 `DASHSCOPE_API_KEY`。

### 幂等（重发不会重复扣）

手机信号差的时候，「服务端算完了、回包丢了」是常态。客户端那边看起来就是超时，
用户再点一次、或者 `api.js` 自动重发一次 —— 没有幂等键的话，这顿饭扣两次次数、
模型也白调一次。

做法：客户端每次识别带一个随机 `clientId`（`api.js` 的 `recognize()` 会把它转成
`idempotent: true`，允许 POST 失败重发一次）。服务端在内存里记 90 秒，
同一个 `userId:clientId` 再来就把上次的回包原样吐回去。

> 只放内存：进程重启就没了 —— 但重启后本来也没有「刚发出去的那次」在等着重试。
> 不带 `clientId` 的老客户端照旧工作，只是没有这层保护。

### 数字体检（Atwater 自洽）

模型最容易犯的错不是数字越界，而是「热量和宏量各编一套」：300 kcal 配
30 g 蛋白 + 20 g 脂肪 + 40 g 碳水，每个数单看都合法，合起来是 460 kcal。

服务端按 `蛋白×4 + 脂肪×9 + 碳水×4` 算一遍，和模型给的热量差超过 30% 就以宏量为准，
`confidence` 降成 `low`，`note` 里写明「N 条的热量和营养对不上，已重算」。
名字里带酒（啤酒/白酒/清酒…）的跳过 —— 酒精 7 kcal/g 不在 Atwater 公式里，
硬套会把啤酒从 43 kcal 改成 15。

单元测试：`cd tools/.devtest; node nutrition-check.mjs`（21 条）。

> 限额的计数在 `recognize_usage` 表里（一人一天一行），不是进程内存 ——
> Render 免费实例一休眠内存就清空，那样限额等于没有。
> 只有真的拿到结果才扣次数；超时、报错、返回的不是 JSON 都会把这次额度退回去。

> 计费按图片 token 算（不是 Search 计费）：一张压到 896px 的图约 1000 token 上下，
> 用 `qwen3-vl-plus` 大概 ¥0.002–0.005/张；300 元券够跑几万张。

> 「吃了多少 / 花了多少钱 / 备注」这三样只存在 App 本地和用户自己的日记里，
> 服务端不参与计算，也不进模型提示词 —— 热量是按「份量 × 吃了多少」在前端算的。

### feed 返回结构

```json
{
  "date": "2026-10-16",
  "scope": "friends",
  "posts": [
    {
      "id": 12,
      "userId": 2,
      "username": "bob",
      "displayName": "鲍勃",
      "avatarColor": "#FF8A65",
      "date": "2026-10-16",
      "goalText": "每日 1800 kcal",
      "meals": {
        "breakfast": [{"name":"燕麦粥","amount":"1碗","kcal":320,"p":12,"f":6,"ch":54,"note":""}],
        "lunch": [], "dinner": [], "snack": [], "extra": []
      },
      "totals": {"kcal": 970, "p": 57, "f": 18, "ch": 134},
      "likes": 3,
      "likedByMe": true,
      "commentCount": 1,
      "comments": [
        {"id": 5, "userId": 1, "displayName": "小爱", "avatarColor": "#4DB6AC",
         "text": "好健康！", "createdAt": 1792165969901, "mine": false}
      ]
    }
  ]
}
```

* `scope=friends`（默认）= 我 + 我已接受的好友；`scope=me` = 只有我自己。
* `date` 缺省 = 服务端当天（按服务器本地时区算，建议 App 每次都显式传）。
* `posts` 按 `updatedAt` 倒序；`commentCount` 是该动态的**全部**评论数，
  而 `comments` 为了控制响应体积只带**最近 20 条**（正序）。要看全部评论用 `GET /api/posts/:id/comments`。
* `meals` 里的餐次 key 固定为 `breakfast / lunch / dinner / snack / extra`，没填的返回空数组。
* 单条餐次条目字段：`name`(必填) / `amount` / `kcal` / `p` / `f` / `ch` / `note`。
* `totals` 里传了非 0 值就用你传的，否则服务端按 meals 自动累加。

### /api/version 返回

```json
{"versionCode":1,"versionName":"0.1.0","url":"https://.../dietdiary-0.1.0.apk",
 "notes":"...","force":false,"minSupported":1}
```

App 端判断：`versionCode > 本地 versionCode` 就提示更新；`minSupported > 本地 versionCode` 或 `force == true` 时强制更新。

---

## 六、数据表结构

| 表 | 作用 | 关键列 |
|---|---|---|
| `users` | 用户 | `id`, `username`(唯一，小写), `display_name`, `password_hash`(scrypt), `avatar_color`, `goal_text`, `created_at` |
| `sessions` | 登录会话 | `token`(主键), `user_id`, `created_at`, `expires_at` |
| `friendships` | 好友关系，一对待两个用户只有一行 | `requester_id`, `addressee_id`, `status`(`pending`/`accepted`/`rejected`), `UNIQUE(requester_id,addressee_id)` |
| `posts` | 每日动态，一人一天一条 | `user_id`, `date`, `goal_text`, `meals_json`, `totals_json`, `UNIQUE(user_id,date)` |
| `likes` | 点赞 | `post_id`, `user_id`, `UNIQUE(post_id,user_id)` |
| `comments` | 评论 | `post_id`, `user_id`, `text`, `created_at` |
| `cheers` | 催更记录 | `from_user_id`, `to_user_id`, `post_id`, `date`, `message` |
| `app_versions` | 版本信息（可选，优先于环境变量） | `platform`(主键), `version_code`, `version_name`, `url`, `notes`, `force`, `min_supported` |

所有时间戳都是**毫秒级 Unix 时间**（INTEGER）；`date` 是 `YYYY-MM-DD` 文本。
删用户/删动态时 `sessions` / `likes` / `comments` / `cheers` 通过外键 `ON DELETE CASCADE` 一起清掉。
全部 SQL 都用 `?` 占位符参数化（`client.execute({sql, args})`），没有字符串拼接，防注入。

---

## 七、免费额度与已知限制

* **Turso 免费档**：100 个数据库、合计 5 GB 存储、每月 5 亿次行读 / 1000 万次行写
  （超限的查询会直接失败，所以别写全表扫描）。个人/小团队用完全够；超了要升级付费套餐。
* **Render 免费档**：750 实例小时/月、512 MB 内存、共享 CPU、**15 分钟无流量休眠、冷启动约 30–60 秒**、
  磁盘非持久化、带宽 100 GB/月。
* **Turso 是 HTTP/WebSocket 协议访问**，所以每次查询都有网络往返；本项目每个 feed 请求约 5 次查询，
  免费档延迟通常在几十毫秒量级。要更快就把 `date` 索引用好（`idx_posts_date` 已建）。
* **输入限制**：用户名 3-24 位 `[a-zA-Z0-9_]`（存库前统一转小写）、密码 ≥ 6 位、昵称 1-24 字、
  目标文案 ≤ 200 字、评论 1-500 字、单条动态最多 5 个餐次 × 每餐 60 条（超出截断，
  未知餐次 key 的条目合并进 `extra`）、请求体上限 1 MB。
* **催更去重**：同一天对同一好友只会记录一次，重复调用返回 `{"ok":true,"duplicate":true}`。
* **`/api/version` 永远不抛错**：数据库挂了也会用环境变量兜底返回，避免 App 启动被卡住。
* 会话默认 90 天过期（`SESSION_TTL_DAYS`），**只在进程启动时**清理一次过期记录；
  不注册 `setInterval` 是因为 Render 免费实例会休眠，冷启动场景下定时器没有意义。
  `POST /api/auth/logout` 可立即作废当前 token。

### 大概能撑多少用户

按「每个活跃用户每天 1 条动态 + 平均 5 个点赞/评论」的用量估算（一个 feed 请求 ≈ 5 次行读）：

| 指标 | 免费额度 | 折算 |
|---|---|---|
| Turso 行读 5 亿/月 | 每次 feed ≈ 5 读 | ≈ 1 亿次 feed 请求/月 |
| Turso 行写 1000 万/月 | 一次发动态 ≈ 6 写（删旧+插新+……） | ≈ 150 万次发动态/月 |
| Turso 存储 5 GB | 一条动态（含 meals JSON）≈ 1-2 KB | ≈ 250 万-500 万条动态 |
| Render 750 实例小时/月 | 一个月 744 小时 | **单实例**刚好够常驻；开两个免费服务就会超 |

结论：**写额度先耗尽**。200 个日活用户（每人每天发 1 条 + 20 次读写）大约每月用掉
1000 万行写中的三成上下，也就是说免费档舒服地跑 **500-1000 个日活用户**没问题；
存储要跑满 5 GB 需要累计几百万条动态，按 1000 日活的节奏是**数年**量级。
真正的瓶颈是 Render 那 750 小时和 15 分钟休眠——一旦被大量用户访问（有流量就不会休眠）就够用，
但冷启动那 30-60 秒的体验是免费档无法消除的。

---

## 八、常见问题

**注册报 `UNIQUE constraint failed`？** 用户名已存在（接口会先查一次，并发下兜底转成 `409`）。

**一直 401？** 检查 header 是不是 `Authorization: Bearer <token>`（注意 `Bearer` 后的空格），
或者 token 是否已在别的设备上 `logout`。改过 `JWT_SECRET` 不会让旧 token 立刻失效
（sessions 表才是权威），但 token 的派生密钥变了——保险起见换密钥后清空 sessions 表：
`turso db shell dietdiary "DELETE FROM sessions;"`。

**Render 部署后请求 502 / 超时？** 大概率是冷启动，等 30–60 秒重试即可。看 Render 的 **Logs** 标签页
确认 `[db] schema 就绪` 有打印出来；没打印就是 Turso 的 URL/token 填错了。

**想换端口/域名？** 不要设 `PORT`，Render 自己注入；自定义域名在 **Settings → Custom Domains** 加。

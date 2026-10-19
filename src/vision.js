// server/src/vision.js
// 拍照识别：照片 → 「有哪些吃的 + 每样大概多少克 + 每 100 克营养」。
//
// 为什么放在服务端：百炼的 API Key 是钱。放进 App（assets/www 里）等于
// 把 Key 发给所有装了这个包的人 —— 反编译一层就能拿到，几百块的额度几分钟能被刷光。
// 所以 Key 只存在这里的 process.env 里，App 只把压缩过的图片发到自己的后端。
//
// 走的接口是百炼的 OpenAI 兼容模式（/compatible-mode/v1/chat/completions），
// 这样不用引阿里云的 SDK，一个 fetch 就够。
//
// 模型只负责「认菜 + 估重量 + 给个粗营养」，最终数值由 App 用本地食物库
// （238 种，《中国食物成分表》口径）覆盖；库里没有的才用模型给的值，并在
// 界面上标成「AI 估算」，免得把猜的数字当成称过的。
//
// 这个文件自带 h()/HttpError（index.js 里那两个不导出），换成 import 要动
// 那个文件的结构，收益不大。

import express from 'express';
import { requireAuth } from './auth.js';
import { get, run } from './db.js';

const router = express.Router();

/* --------------------------------------------------------------- 配置 */
const API_KEY = String(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || '').trim();
/* 不填就用官方通用地址；控制台给的专属地址（含 WorkspaceId）填在这里也行，两条都通 */
const BASE_URL = String(process.env.BAILIAN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  .trim().replace(/\/+$/, '');
/* 想省钱就换成 qwen3-vl-flash；改名/下线时后面的候选会接着试 */
const MODEL_PRIMARY = String(process.env.VISION_MODEL || 'qwen3-vl-plus').trim();
const MODEL_FALLBACKS = ['qwen3-vl-plus', 'qwen-vl-plus', 'qwen-vl-max', 'qwen2.5-vl-72b-instruct'];
/* 一张 896px 的 JPEG 大概 100–200 KB，base64 后 1.4 倍；4 MB 够用且不至于被人当图床 */
const MAX_IMAGE_BYTES = Number(process.env.RECOGNIZE_MAX_IMAGE_BYTES || 4 * 1024 * 1024);
/* 每个账号每天最多识别几次 —— 300 元券被人拿去刷就没了，留个闸门。
   默认 5：一天三顿加两次加餐刚好够，正常人不会不够用；
   真不够用自己改 .env 里的 RECOGNIZE_DAILY_LIMIT。 */
const DAILY_LIMIT = Math.max(1, Math.floor(Number(process.env.RECOGNIZE_DAILY_LIMIT || 5)));
/* 「每天」按中国时间的零点重置。Render 跑在 UTC，直接用 toISOString() 的话
   限额会在北京时间早上 8 点悄悄重置 —— 半夜想吃夜宵的人会发现次数没了。 */
const TZ_OFFSET_H = Number(process.env.RECOGNIZE_TZ_OFFSET_HOURS || 8);
const TIMEOUT_MS = Number(process.env.RECOGNIZE_TIMEOUT_MS || 45000);
/* 没配 Key / 想离线跑测试时：返回一份假数据，链路本身仍然是通的。
   RECOGNIZE_MOCK=empty 是专门给测试用的变体：返回一份「什么都没认出来」的空结果，
   用来验证「没结果就退额度」那条路。 */
const MOCK_RAW = String(process.env.RECOGNIZE_MOCK || '').trim();
const MOCK = MOCK_RAW === '1' || MOCK_RAW === 'empty';

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

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

/* ------------------------------------------------------------ 每日计数 */
/* 计数存在库里（表 recognize_usage，一人一天一行），不存进程内存：
   Render 免费实例空闲十几分钟就休眠，一醒内存清零，限额等于不存在；
   以后要开两个实例也还是同一本账。 */
function todayStr() {
  return new Date(Date.now() + TZ_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

async function usedToday(userId, day) {
  const row = await get('SELECT n FROM recognize_usage WHERE user_id = ? AND date = ?', [userId, day]);
  return row ? Number(row.n) || 0 : 0;
}

/**
 * 占一次额度：还有次数就 +1 并返回剩余次数，到顶返回 -1。
 * 一句 UPSERT 搞定，`WHERE recognize_usage.n < ?` 让「检查」和「自增」变成
 * 同一个原子操作 —— 两个请求同时进来也不会都从第 5 次挤过去。
 */
async function takeQuota(userId) {
  const day = todayStr();
  const r = await run(
    'INSERT INTO recognize_usage (user_id, date, n, updated_at) VALUES (?, ?, 1, ?) ' +
    'ON CONFLICT(user_id, date) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at ' +
    'WHERE recognize_usage.n < ?',
    [userId, day, Date.now(), DAILY_LIMIT]
  );
  if (!r.changes) return -1;          // WHERE 没过：今天已经用满
  return DAILY_LIMIT - await usedToday(userId, day);
}

/** 模型没跑成功就把这次额度退回去 —— 报错不该算在用户头上 */
async function refundQuota(userId) {
  try {
    await run('UPDATE recognize_usage SET n = n - 1 WHERE user_id = ? AND date = ? AND n > 0',
      [userId, todayStr()]);
  } catch (e) {
    console.warn('[recognize] 退还额度失败（不影响本次报错）:', e.message);
  }
}

async function remainingQuota(userId) {
  return Math.max(0, DAILY_LIMIT - await usedToday(userId, todayStr()));
}

/* --------------------------------------------------------- 幂等（重发不重复扣） */
/* 手机在地铁里、信号一格的时候，一个请求可能「服务端已经算完了，回包却丢了」。
   客户端那边看起来就是超时，要么用户自己再点一次，要么 api.js 自动重发一次。
   没有幂等键的话，这一顿饭就扣了两次次数、而且模型也白调一次（真金白银）。
   做法很小：客户端每次识别带一个随机 clientId，服务端 90 秒内见到同一个 id
   就把上次的响应原样吐回去，不再扣次数、不再调模型。
   只放内存：进程重启就没了，但重启后本来也没有「刚发出去的那次」等着重试。 */
const IDEMPOTENT_TTL_MS = 90 * 1000;
const recentResults = new Map();

function clientKey(userId, raw) {
  const id = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return id ? userId + ':' + id : '';
}

function rememberResult(key, body) {
  if (!key) return;
  recentResults.set(key, { at: Date.now(), body });
  if (recentResults.size > 300) {
    const cutoff = Date.now() - IDEMPOTENT_TTL_MS;
    for (const [k, v] of recentResults) if (v.at < cutoff) recentResults.delete(k);
  }
}

function recallResult(key) {
  if (!key) return null;
  const hit = recentResults.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IDEMPOTENT_TTL_MS) {
    recentResults.delete(key);
    return null;
  }
  return hit.body;
}

/* --------------------------------------------------------------- 提示词 */
/* 几条都是踩过的坑：
   - 「不要用 markdown」：不加这句，模型很爱把 JSON 包进 ```json，解析要多写一堆兜底；
   - 给参照物：不给的话米饭一律 200g、肉一律 100g，看着挺正经其实没用；
   - 允许返回空数组：否则桌上放杯水它也要编出一碗面。 */
/* 餐次的中文名。带上它是因为同一个「一碗」在早餐和夜宵里差得挺远：
   早上一碗粥 300g，夜宵一碗面 500g。模型知道是哪一餐，估重会靠谱一点。 */
const MEAL_NAMES = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐/零食',
  preworkout: '练前加餐', postworkout: '练后加餐', latenight: '夜宵'
};

const PROMPT = [
  '你是一个中文饮食记录 App 的拍照识别助手。看这张照片，找出里面所有能吃、能喝的东西，',
  '估算每一样在照片里实际出现的重量，并给出每 100 克的营养成分。',
  '',
  '规则：',
  '1. name 用中国大陆最常见的叫法，不要带「一份」「约」「适量」这类词；认得出品牌/连锁店的写品牌名。',
  '2. grams 是照片里这一份的总克数（整数）。参照物：一个鸡蛋≈50g，一碗米饭≈200g，',
  '   一听可乐 330ml≈350g，一个手掌大的肉≈100g，一片吐司≈35g。',
  '3. kcal100 / protein100 / fat100 / carbs100 按每 100 克给，单位分别是 kcal 和 g，保留一位小数。',
  '4. 只输出一个 JSON 对象，不要解释，不要 markdown 代码块，不要注释。',
  '5. 看不清、不确定的东西宁可不列，不要编；把握不大的把 confidence 写成 "low"。',
  '6. 照片里没有食物或饮料时，items 返回空数组，note 里写一句原因。',
  '7. 最多列 16 样，同一种东西分两盘也只算一样、把克数加起来。',
  '',
  '输出格式：',
  '{"items":[{"name":"米饭","grams":200,"kcal100":116,"protein100":2.6,"fat100":0.3,"carbs100":25.9,"confidence":"high"}],"note":""}',
  'confidence 只能是 "high" / "mid" / "low"。'
].join('\n');

function buildPrompt(meal) {
  const name = MEAL_NAMES[String(meal || '')];
  if (!name) return PROMPT;
  return PROMPT + '\n\n补充：这张照片是用户的' + name + '。按这个餐次常见的份量估 grams。';
}

/* ------------------------------------------------------------ 小工具 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 模型偶尔会把 ```json 或「好的，这是结果：」带上，这里粗暴地掏第一个 { 到最后一个 } */
function extractJson(text) {
  const s = String(text || '').trim();
  const direct = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(direct);
  } catch (e) { /* 继续往下试 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch (e) { /* 交给调用方报错 */ }
  }
  return null;
}

/** 把模型吐的东西收拾成人能用的形状：名字去空白、数字夹到合理范围、最多 16 项 */
function normalizeItems(raw) {
  const list = raw && Array.isArray(raw.items) ? raw.items : [];
  const out = [];
  const seen = new Set();
  let suspicious = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || it.food || it.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) continue;
    if (seen.has(name)) continue;           // 模型偶尔把同一道菜报两遍
    const gramsRaw = num(it.grams, 0);
    if (!(gramsRaw > 0)) continue;          // 0 克等于没这道菜（clamp 的下限是 1，不能先夹再判）
    const grams = Math.round(clamp(gramsRaw, 1, 3000));
    let kcal100 = clamp(num(it.kcal100, 0), 0, 950);
    const protein100 = round1(clamp(num(it.protein100, 0), 0, 100));
    const fat100 = round1(clamp(num(it.fat100, 0), 0, 100));
    const carbs100 = round1(clamp(num(it.carbs100, 0), 0, 100));
    /* Atwater 自洽校验。模型最容易犯的错不是数字越界，而是「热量和宏量各编一套」：
       比如 300 kcal 配 30 g 蛋白 + 20 g 脂肪 + 40 g 碳水（其实是 460 kcal）。
       每个数单看都合法，合起来不可能。蛋白×4 + 脂肪×9 + 碳水×4 才是这一百克
       真能放出的热量，差得太远就以宏量为准（宏量是它按食材逐项估的）。
       酒类跳过：酒精 7 kcal/g 不在 Atwater 里，啤酒按这个公式会从 43 被改成 15。 */
    const isAlcohol = /酒|啤酒|白酒|红酒|黄酒|清酒|鸡尾|威士忌|伏特加|朗姆|白兰地|香槟/.test(name);
    const atwater = protein100 * 4 + fat100 * 9 + carbs100 * 4;
    let confidence = String(it.confidence || '').toLowerCase();
    confidence = confidence === 'high' || confidence === 'low' ? confidence : 'mid';
    if (!isAlcohol && atwater >= 20 && Math.abs(atwater - kcal100) / Math.max(atwater, kcal100, 1) > 0.3) {
      kcal100 = atwater;
      confidence = 'low';
      suspicious++;
    }
    if (!kcal100) continue; // 热量和宏量都认不出来的条目没意义，宁可少一条
    seen.add(name);
    out.push({
      name,
      grams,
      kcal100: round1(kcal100),
      protein100,
      fat100,
      carbs100,
      confidence
    });
    if (out.length >= 16) break;
  }
  let note = String((raw && raw.note) || '').trim().slice(0, 200);
  if (suspicious) {
    note = (note ? note + ' ' : '') + '（' + suspicious + ' 条的热量和营养对不上，已按蛋白/脂肪/碳水重算）';
  }
  return { items: out, note };
}

/** 把百炼/网络层的错误翻译成用户能看懂的一句话 */
function friendlyError(status, body) {
  const err = (body && body.error) || {};
  const code = String(err.code || '');
  const msg = String(err.message || '');
  const low = (code + ' ' + msg).toLowerCase();
  if (low.includes('invalid_api_key') || low.includes('invalidapikey')) {
    return new HttpError(502, '百炼的 API Key 不对：检查 DASHSCOPE_API_KEY，并确认它和 BASE_URL 是同一个地域（北京的地址要配北京的 Key）');
  }
  if (low.includes('arrearage') || low.includes('insufficient') || low.includes('quota exceeded')) {
    return new HttpError(502, '百炼账户欠费或额度用完了，去控制台看一下余额/代金券');
  }
  if (low.includes('datainspection') || low.includes('inappropriate') || low.includes('content')) {
    return new HttpError(422, '这张图没过百炼的内容审核，换一张再试');
  }
  if (status === 429 || low.includes('throttling') || low.includes('rate')) {
    return new HttpError(429, '调用太频繁了，等十几秒再试');
  }
  if (status === 401) return new HttpError(502, '百炼拒绝了这次请求（Key 或地域不对）');
  return new HttpError(502, '识别服务出错' + (code ? '（' + code + '）' : '') + (msg ? '：' + msg.slice(0, 120) : ''));
}

function looksLikeModelMissing(status, body) {
  const err = (body && body.error) || {};
  const low = (String(err.code || '') + ' ' + String(err.message || '')).toLowerCase();
  if (status === 404) return true;
  return low.includes('model') && (low.includes('not') || low.includes('invalid') || low.includes('unsupported'));
}

/* --------------------------------------------------------- 调模型这一次 */
async function callModel(model, dataUrl, meal) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: buildPrompt(meal) }
        ]
      }],
      temperature: 0.1,
      max_tokens: 1200
    })
  };
  if (ctrl) init.signal = ctrl.signal;
  try {
    const res = await fetch(BASE_URL + '/chat/completions', init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    return { status: res.status, body, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ 路由 */
router.get('/recognize/status', requireAuth, h(async (req, res) => {
  res.json({
    ok: true,
    enabled: !!API_KEY || MOCK,
    mock: MOCK,
    model: MOCK ? 'mock' : MODEL_PRIMARY,
    remainingToday: await remainingQuota(req.user.id),
    dailyLimit: DAILY_LIMIT
  });
}));

/* 单独挂这个解析器（4MB），并且只在路由级挂：
   index.js 里那个全局 express.json 是 1MB，图片 base64 会超。
   路由级解析完 req._body 就是 true，后面那个全局的会自己跳过。 */
router.post('/recognize', express.json({ limit: '4mb' }), requireAuth, h(async (req, res) => {
  if (!API_KEY && !MOCK) {
    throw new HttpError(503, '服务端没配 DASHSCOPE_API_KEY，识别功能没开（见 server/.env.example）');
  }

  const body = req.body || {};
  const image = String(body.image || '').trim();
  if (!image) throw new HttpError(400, 'image 不能为空（传 data:image/...;base64,... 或纯 base64）');

  /* 允许「纯 base64」和「data URL」两种写法 */
  let mime = 'image/jpeg';
  let data = image;
  const m = /^data:([^;]+);base64,(.*)$/i.exec(image);
  if (m) {
    mime = m[1].toLowerCase();
    data = m[2];
  }
  if (ALLOWED_TYPES.indexOf(mime) < 0) {
    throw new HttpError(415, '只支持 JPEG / PNG / WebP，iPhone 的 HEIC 先在相册里转一下');
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw new HttpError(400, 'image 不是合法的 base64');
  /* base64 长度 ×3/4 ≈ 原始字节数 */
  const bytes = Math.floor(data.length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new HttpError(413, '图片太大了（' + Math.round(bytes / 1024) + ' KB，上限 ' +
      Math.round(MAX_IMAGE_BYTES / 1024) + ' KB），App 里会先压到 896px，正常不会碰到这个');
  }

  /* 同一个 clientId 在 90 秒内重复提交：回上次的结果，不扣次数、不调模型。 */
  const ckey = clientKey(req.user.id, body.clientId);
  const cached = recallResult(ckey);
  if (cached) {
    console.log('[recognize] 命中幂等缓存 user=%s', req.user.id);
    return res.json(Object.assign({}, cached, { cached: true }));
  }

  const left = await takeQuota(req.user.id);
  if (left < 0) {
    throw new HttpError(429, '今天识别的次数用完了（每天 ' + DAILY_LIMIT + ' 次，中国时间零点重置），' +
      '明天再来；急着记的话，用餐次里的 + 手动加一条也一样');
  }

  let payload;
  try {
    payload = await runRecognize(req.user.id, { mime, data, left, meal: body.meal });
  } catch (err) {
    /* 模型超时、百炼报错、返回的不是 JSON —— 这次没给用户任何东西，
       额度得还回去，不然「识别失败还扣一次」最招人烦。 */
    await refundQuota(req.user.id);
    throw err;
  }

  /* 一条都没认出来也一样：用户什么都没拿到，不该算他一次。 */
  if (!payload.items.length) {
    await refundQuota(req.user.id);
    payload.refunded = true;
    payload.remainingToday = await remainingQuota(req.user.id);
  }

  rememberResult(ckey, payload);
  res.json(payload);
}));

/** 真正干活的那一段：mock 或调模型、整理结果，返回回包对象。失败一律 throw，由上层退额度。 */
async function runRecognize(userId, ctx) {
  const mime = ctx.mime;
  const data = ctx.data;
  const meal = ctx.meal;
  const left = ctx.left;
  const started = Date.now();

  if (MOCK) {
    /* RECOGNIZE_MOCK=empty 专供测试：模拟「这张图一条都没认出来」，
       用来验证「没结果就退额度」那条路。 */
    const empty = MOCK_RAW === 'empty';
    const fake = normalizeItems(empty ? { items: [], note: '假数据：什么都没认出来' } : {
      items: [
        { name: '米饭', grams: 200, kcal100: 116, protein100: 2.6, fat100: 0.3, carbs100: 25.9, confidence: 'high' },
        { name: '番茄炒蛋', grams: 180, kcal100: 120, protein100: 6, fat100: 8, carbs100: 6, confidence: 'mid' },
        { name: '清蒸鲈鱼', grams: 150, kcal100: 105, protein100: 18.6, fat100: 3.4, carbs100: 0, confidence: 'low' }
      ],
      note: '这是 RECOGNIZE_MOCK=1 的假数据'
    });
    console.log('[recognize] mock user=%s items=%d', userId, fake.items.length);
    return { ok: true, mock: true, model: 'mock', items: fake.items, note: fake.note, remainingToday: left, dailyLimit: DAILY_LIMIT, elapsedMs: Date.now() - started };
  }

  const dataUrl = 'data:' + mime + ';base64,' + data.replace(/\s+/g, '');
  const candidates = [MODEL_PRIMARY].concat(MODEL_FALLBACKS)
    .filter((v, i, a) => v && a.indexOf(v) === i);

  let lastErr = null;
  for (const model of candidates) {
    let r;
    try {
      r = await callModel(model, dataUrl, meal);
    } catch (e) {
      const aborted = e && e.name === 'AbortError';
      if (aborted) throw new HttpError(504, '识别超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒），换个网络或再试一次');
      throw new HttpError(502, '连不上百炼：' + String((e && e.message) || e).slice(0, 120));
    }

    if (r.status === 200) {
      const choice = r.body && r.body.choices && r.body.choices[0];
      const text = choice && choice.message && choice.message.content;
      const parsed = extractJson(typeof text === 'string' ? text : JSON.stringify(text || ''));
      if (!parsed) {
        console.warn('[recognize] 模型没给 JSON: %s', String(text || r.text).slice(0, 200));
        throw new HttpError(502, '模型这次没返回 JSON，再试一次通常就好了');
      }
      const norm = normalizeItems(parsed);
      const u = (r.body && r.body.usage) || {};
      console.log('[recognize] ok user=%s model=%s items=%d prompt=%s completion=%s ms=%d',
        userId, model, norm.items.length, u.prompt_tokens || '?', u.completion_tokens || '?', Date.now() - started);
      return {
        ok: true,
        model,
        items: norm.items,
        note: norm.note,
        remainingToday: left,
        dailyLimit: DAILY_LIMIT,
        usage: { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0 },
        elapsedMs: Date.now() - started
      };
    }

    if (looksLikeModelMissing(r.status, r.body)) {
      console.warn('[recognize] 模型 %s 不可用（HTTP %s），试下一个', model, r.status);
      lastErr = friendlyError(r.status, r.body);
      continue;
    }
    lastErr = friendlyError(r.status, r.body);
    throw lastErr;
  }
  throw lastErr || new HttpError(502, '没有可用的视觉模型，检查 VISION_MODEL');
}

/* normalizeItems 也导出来，供 tools/.devtest/nutrition-check.mjs 直接跑单元测试。 */
export { router as visionRouter, normalizeItems };

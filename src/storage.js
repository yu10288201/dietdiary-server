// server/src/storage.js
// 阿里云 OSS 对象存储（零依赖，用 V1 签名直接打 HTTP 接口）。
//
// 为什么不用 ali-oss SDK：项目依赖只有 express/cors/dotenv/@libsql/client，
// 为了上传一个 150 KB 的图片装一整套 SDK 不值得。V1 签名就三行 HMAC。
//
// 环境变量（server/.env）：
//   OSS_ACCESS_KEY_ID       AccessKey ID（建议用 RAM 子账号，只给这个 Bucket 的读写权限）
//   OSS_ACCESS_KEY_SECRET   AccessKey Secret
//   OSS_BUCKET              Bucket 名，例：shike-photos
//   OSS_ENDPOINT            地域节点，例：oss-cn-beijing.aliyuncs.com（不带 bucket 前缀）
//   OSS_PUBLIC_BASE         可选。对外访问的域名前缀，例：https://cdn.shike.app
//                           不填就默认 https://<bucket>.<endpoint>（OSS 默认域名，能直接访问）
//   OSS_PRIVATE             可选。设为 1 表示 Bucket 是私有的，图片地址改成带签名的临时链接
//   OSS_PREFIX              可选。对象前缀，默认 photos/
//
// 没配 AccessKey 时 storageReady() 返回 false，调用方应回 503 并给出提示，
// 不要抛异常把服务打挂。

import crypto from 'node:crypto';

const ACCESS_KEY_ID = (process.env.OSS_ACCESS_KEY_ID || '').trim();
const ACCESS_KEY_SECRET = (process.env.OSS_ACCESS_KEY_SECRET || '').trim();
const BUCKET = (process.env.OSS_BUCKET || '').trim();
const ENDPOINT = (process.env.OSS_ENDPOINT || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const PUBLIC_BASE = (process.env.OSS_PUBLIC_BASE || '').trim().replace(/\/+$/, '');
const PRIVATE = /^(1|true|yes)$/i.test((process.env.OSS_PRIVATE || '').trim());
const PREFIX = ((process.env.OSS_PREFIX || 'photos/').trim() || 'photos/').replace(/^\/+/, '');
const TIMEOUT_MS = Math.max(3000, Number(process.env.OSS_TIMEOUT_MS || 15000));

/** 是否配好了（缺任何一项都当没配，宁可回 503 也不要在上传时才炸） */
export function storageReady() {
  return !!(ACCESS_KEY_ID && ACCESS_KEY_SECRET && BUCKET && ENDPOINT);
}

export function storageInfo() {
  return {
    ready: storageReady(),
    bucket: BUCKET || '',
    endpoint: ENDPOINT || '',
    private: PRIVATE,
    // 不要把 AccessKey 发出去，只说有没有配
    hasKey: !!ACCESS_KEY_ID
  };
}

/** 对象 key：photos/u12/202610/xxxx.jpg —— 按用户分目录，方便排查和整体删除 */
export function newObjectKey(userId, ext = 'jpg') {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = crypto.randomBytes(9).toString('hex');
  return `${PREFIX}u${Number(userId) || 0}/${ym}/${rand}.${ext}`;
}

/** key 是否看起来是本人生成的（防越权删别人的对象）；前缀 + 用户目录 */
export function keyBelongsTo(key, userId) {
  return typeof key === 'string' && key.startsWith(`${PREFIX}u${Number(userId)}/`) && !key.includes('..');
}

function host() {
  return `${BUCKET}.${ENDPOINT}`;
}

function ossDate() {
  // OSS 要的是 RFC 1123 GMT，例如 Sun, 19 Oct 2026 12:00:00 GMT
  return new Date().toUTCString();
}

/** V1 签名。method=PUT/DELETE/GET，contentType 参与签名，必须和实际请求头一致 */
function sign(method, contentType, date, resource) {
  const stringToSign = `${method}\n\n${contentType || ''}\n${date}\n${resource}`;
  return crypto.createHmac('sha1', ACCESS_KEY_SECRET).update(stringToSign, 'utf8').digest('base64');
}

function objectUrl(key) {
  // key 里只有 [a-z0-9/._-]，但仍然逐段编码，避免意外字符拼出奇怪的 URL
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${host()}/${path}`;
}

/**
 * 上传一个 Buffer。
 * @returns {Promise<void>} 失败抛错，调用方负责转成 502/503
 */
export async function putObject(key, buffer, contentType = 'image/jpeg') {
  if (!storageReady()) throw new Error('对象存储没配（缺 OSS_ACCESS_KEY_ID / OSS_BUCKET 等）');
  const date = ossDate();
  const resource = `/${BUCKET}/${key}`;
  const auth = `OSS ${ACCESS_KEY_ID}:${sign('PUT', contentType, date, resource)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(objectUrl(key), {
      method: 'PUT',
      headers: {
        Date: date,
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        Authorization: auth
      },
      body: buffer,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error(`对象存储超时（${TIMEOUT_MS}ms）`);
    throw new Error(`连不上对象存储：${err && err.message ? err.message : err}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // OSS 的错误体是 XML，<Code>AccessDenied</Code> 这种，截一小段足够排查
    throw new Error(`对象存储返回 ${res.status}：${text.slice(0, 200)}`);
  }
}

/** 删除对象，失败不抛（删图是尽力而为，DB 行删掉就行） */
export async function deleteObject(key) {
  if (!storageReady()) return;
  try {
    const date = ossDate();
    const resource = `/${BUCKET}/${key}`;
    const auth = `OSS ${ACCESS_KEY_ID}:${sign('DELETE', '', date, resource)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    await fetch(objectUrl(key), {
      method: 'DELETE',
      headers: { Date: date, Authorization: auth },
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn('[storage] 删除失败（忽略）：', err && err.message ? err.message : err);
  }
}

/**
 * 对外可访问的地址。
 * - Bucket 公共读（默认）：直接返回 OSS 域名 / 自定义 CDN 域名，能被 CDN 和浏览器缓存
 * - Bucket 私有（OSS_PRIVATE=1）：返回 1 小时有效的签名 URL
 */
export function publicUrl(key) {
  if (!key) return '';
  if (!PRIVATE) {
    const base = PUBLIC_BASE || `https://${host()}`;
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const resource = `/${BUCKET}/${key}`;
  const signature = sign('GET', '', String(expires), resource);
  const path = key.split('/').map(encodeURIComponent).join('/');
  return (
    `https://${host()}/${path}` +
    `?OSSAccessKeyId=${encodeURIComponent(ACCESS_KEY_ID)}` +
    `&Expires=${expires}&Signature=${encodeURIComponent(signature)}`
  );
}

/**
 * OpenAI 兼容图片接口的最小客户端。
 *
 * 只用 Node 22 自带的 fetch / FormData / Blob。响应形态各家不同：
 * 有的给 `data[0].b64_json`，有的给 `data[0].url`，中转站偶尔给
 * `images[0]` / `output[0]` / 直接一个字符串，这里都认。
 */

/** 请求失败；`status` 是 HTTP 状态码，0 表示没走到服务端。 */
export class ImageApiError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ImageApiError';
    this.status = Number(opts.status) || 0;
    this.body = String(opts.body ?? '');
  }
}

const DEFAULT_TIMEOUT = 180000;

/**
 * 云端端点只认 `宽x高` 这种字面尺寸：把 `square` 这类别名原样发过去，
 * 上游会以「无返回」包装成 503（issue #3）。这里先归一化，认不出来就干脆不发。
 * 键都是小写、去掉空格之后的写法。
 */
const CLOUD_SIZE_ALIASES = {
  square: '1024x1024', '1:1': '1024x1024', '方图': '1024x1024', '方形': '1024x1024', '正方形': '1024x1024',
  portrait: '1024x1536', '3:4': '1024x1536', '9:16': '1024x1536', '竖图': '1024x1536', '竖屏': '1024x1536', '竖版': '1024x1536',
  landscape: '1536x1024', '4:3': '1536x1024', '3:2': '1536x1024', '16:9': '1536x1024', '横图': '1536x1024', '横屏': '1536x1024', '横版': '1536x1024',
};

/**
 * 云端那档的 `size` 归一化：返回合法的 `宽x高`，`auto`/空/认不出来返回 ''（调用方就别发这个字段）。
 * 字面尺寸原样保留（`1792x1024` 这类也认），只把 `×`/`*` 统一成 `x`。
 */
export function normalizeCloudSize(size) {
  const raw = String(size ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw || raw === 'auto') return '';
  const wh = /^(\d{2,5})[x×*](\d{2,5})$/.exec(raw);
  if (wh) return `${Number(wh[1])}x${Number(wh[2])}`;
  const alias = CLOUD_SIZE_ALIASES[raw];
  if (alias) return alias;
  // 任意 a:b：按横竖落到云端那三档上（方/横/竖）。
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(raw);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (a > 0 && b > 0) return a === b ? '1024x1024' : (a > b ? '1536x1024' : '1024x1536');
  }
  return '';
}


function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/[/\s]+$/, '');
  if (!base) throw new ImageApiError('没有配置接口地址');
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

function snippet(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 从魔术字节认格式；认不出来给 null。 */
export function sniffMime(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function describeNetworkError(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `等 ${Math.round(timeoutMs / 1000)} 秒没有响应，超时了`;
  }
  const detail = err?.cause?.message ?? err?.message ?? err;
  return `连不上图片接口：${snippet(detail, 200)}`;
}

async function fetchTimed(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ImageApiError(describeNetworkError(err, timeoutMs));
  }
}

/** POST 一次并解析 JSON；非 2xx 抛 ImageApiError，正文带给调用方。 */
async function postJson(url, { apiKey, body, timeoutMs }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchTimed(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const raw = json?.error?.message ?? json?.message ?? json?.msg ?? text;
    const hint = res.status === 401 || res.status === 403
      ? '（密钥不对、没权限，或者这个模型没有开通）'
      : res.status === 404
        ? '（接口地址或模型名写错了）'
        : '';
    throw new ImageApiError(`接口返回 ${res.status}：${snippet(raw, 300)}${hint}`, {
      status: res.status,
      body: snippet(text, 800),
    });
  }
  if (!json) throw new ImageApiError(`接口没有返回 JSON：${snippet(text, 300)}`, { status: res.status });
  return json;
}

async function postForm(url, { apiKey, form, timeoutMs }) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchTimed(url, { method: 'POST', headers, body: form }, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const raw = json?.error?.message ?? json?.message ?? text;
    throw new ImageApiError(`接口返回 ${res.status}：${snippet(raw, 300)}`, {
      status: res.status,
      body: snippet(text, 800),
    });
  }
  if (!json) throw new ImageApiError(`接口没有返回 JSON：${snippet(text, 300)}`, { status: res.status });
  return json;
}

const isHttpUrl = (s) => /^https?:\/\//i.test(String(s ?? ''));

/** 从各家响应里挑出那一张图。 */
function pickEntry(json) {
  const pools = [
    json?.data,
    json?.images,
    json?.output,
    json?.result?.data,
    json?.result?.images,
    json?.artifacts,
    json?.content,
  ];
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length) return pool[0];
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) return pool;
  }
  for (const key of ['image', 'url', 'b64_json', 'image_url', 'imageUrl']) {
    if (typeof json?.[key] === 'string') return json[key];
  }
  return null;
}

function mimeFromFormat(format) {
  const f = String(format ?? '').toLowerCase().replace(/^\./, '');
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  if (f === 'webp') return 'image/webp';
  if (f === 'gif') return 'image/gif';
  return 'image/png';
}

/** 把响应里的那张图变成字节。 */
async function materialize(json, { timeoutMs, format }) {
  const entry = pickEntry(json);
  const errorish = json?.error?.message ?? json?.message;
  if (!entry) {
    throw new ImageApiError(
      errorish ? `接口没给图：${snippet(errorish, 300)}` : `接口没给图：${snippet(JSON.stringify(json ?? {}), 300)}`,
    );
  }
  const obj = typeof entry === 'string' ? null : entry;
  const b64 = obj
    ? (obj.b64_json ?? obj.b64 ?? obj.image_base64 ?? obj.imageBase64 ?? obj.base64 ?? null)
    : (isHttpUrl(entry) ? null : entry);
  const url = obj ? (obj.url ?? obj.image_url ?? obj.imageUrl ?? null) : (isHttpUrl(entry) ? entry : null);
  const revisedPrompt = obj?.revised_prompt ?? obj?.revisedPrompt ?? null;

  if (b64) {
    const cleaned = String(b64).replace(/^data:[^,]+,/, '');
    const bytes = Buffer.from(cleaned, 'base64');
    if (!bytes.length) throw new ImageApiError('接口返回的 base64 是空的');
    return { bytes, mime: sniffMime(bytes) ?? mimeFromFormat(obj?.output_format ?? format), revisedPrompt };
  }
  if (url) {
    const res = await fetchTimed(url, { method: 'GET' }, timeoutMs);
    if (!res.ok) throw new ImageApiError(`下载生成的图失败：HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new ImageApiError('下载到的图是空的');
    const header = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    return {
      bytes,
      mime: (header.startsWith('image/') ? header : null) ?? sniffMime(bytes) ?? mimeFromFormat(format),
      revisedPrompt,
    };
  }
  throw new ImageApiError('接口返回里既没有 base64 也没有图片地址');
}

/** 画图请求体：`n` 固定 1；size 归一化成 `宽x高`（别名云端不认），认不出来就不发；quality 是 auto 也不发。 */
function generationBody(opts) {
  const body = { model: opts.model, prompt: opts.prompt, n: 1 };
  const size = normalizeCloudSize(opts.size);
  if (size) body.size = size;
  const quality = String(opts.quality ?? '').trim();
  if (quality && quality.toLowerCase() !== 'auto') body.quality = quality;
  return body;
}

/**
 * 文生图。`extraBody` 会并进请求体，留给各家的私有参数。
 * @returns {Promise<{bytes: Buffer, mime: string, revisedPrompt: string|null}>}
 */
export async function generateImage(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const body = generationBody(opts);
  if (opts.extraBody && typeof opts.extraBody === 'object') Object.assign(body, opts.extraBody);
  const json = await postJson(joinUrl(opts.baseUrl, 'images/generations'), {
    apiKey: opts.apiKey,
    body,
    timeoutMs,
  });
  return await materialize(json, { timeoutMs, format: opts.format });
}

/** 把本地图片编成 data URI；阿里云百炼那类兼容端点的 `image` 字段认这个。 */
function dataUri(bytes, mime) {
  const type = String(mime ?? '').trim() || 'image/png';
  return `data:${type};base64,${Buffer.from(bytes ?? []).toString('base64')}`;
}

/**
 * 端点没有 `/images/edits` 时的退路：把原图编成 data URI，跟着 prompt 一起
 * 发给 `/images/generations` 的扩展字段 `image`（阿里云百炼的兼容模式就这么改图）。
 * 这条退路只带得动一张图，多张时给回执留一句 `notice`。
 */
async function editViaGenerations(opts, timeoutMs) {
  const refs = refsOf(opts);
  const body = generationBody(opts);
  body.image = dataUri(refs[0].bytes, refs[0].mime);
  if (refs.length > 1) body.images = refs.map((ref) => dataUri(ref.bytes, ref.mime));
  const json = await postJson(joinUrl(opts.baseUrl, 'images/generations'), {
    apiKey: opts.apiKey,
    body,
    timeoutMs,
  });
  const out = await materialize(json, { timeoutMs, format: opts.format });
  if (refs.length > 1) {
    out.notice = `这个端点的改图退路（/images/generations）只认第一张参考图，后面 ${refs.length - 1} 张没参与。`;
  }
  return out;
}

/** 参考图统一成数组：`images` 优先，其次单张 `image`。 */
function refsOf(opts) {
  const list = Array.isArray(opts.images) ? opts.images.filter((it) => it && it.bytes) : [];
  if (list.length) return list;
  if (opts.image) return [{ bytes: opts.image, mime: opts.mime, name: opts.name }];
  throw new ImageApiError('没给参考图：image 或 images 至少给一个。', { status: 400 });
}

/**
 * 图生图 / 改图。先走 `/images/edits` 的 multipart；端点没这条路由（404/405）时
 * 退回 `/images/generations` 的 `image` 扩展字段，见 `editViaGenerations`。
 *
 * 多张参考图按 OpenAI 的写法提交成 `image[]`——这是主流兼容端点（OpenAI、百炼兼容模式、
 * 一些自建网关）都认的形状；只认单张的端点会回 400，世界层会据此说清是谁不吃多图。
 * @returns {Promise<{bytes: Buffer, mime: string, revisedPrompt: string|null, notice?: string}>}
 */
export async function editImage(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const refs = refsOf(opts);
  const form = new FormData();
  form.set('model', String(opts.model ?? ''));
  form.set('prompt', String(opts.prompt ?? ''));
  form.set('n', '1');
  const size = normalizeCloudSize(opts.size);
  if (size) form.set('size', size);
  const quality = String(opts.quality ?? '').trim();
  if (quality && quality.toLowerCase() !== 'auto') form.set('quality', quality);
  for (const [index, ref] of refs.entries()) {
    const blob = new Blob([ref.bytes], { type: ref.mime ?? 'image/png' });
    const name = ref.name ?? `image-${index + 1}.png`;
    if (refs.length === 1) form.set('image', blob, name);
    else form.append('image[]', blob, name);
  }
  try {
    const json = await postForm(joinUrl(opts.baseUrl, 'images/edits'), { apiKey: opts.apiKey, form, timeoutMs });
    return await materialize(json, { timeoutMs, format: opts.format });
  } catch (err) {
    if (!(err instanceof ImageApiError) || (err.status !== 404 && err.status !== 405)) throw err;
    try {
      return await editViaGenerations(opts, timeoutMs);
    } catch (again) {
      if (again instanceof ImageApiError) {
        again.message = `${again.message}（端点也不支持 multipart /images/edits：HTTP ${err.status}）`;
      }
      throw again;
    }
  }
}

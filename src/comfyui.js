/**
 * ComfyUI 客户端：把「画一张图」变成一次 `/prompt` 提交 + 轮询 `/history` + `/view` 取图。
 *
 * **模型文件留在 ComfyUI 那侧**：checkpoint（`models/checkpoints/`）与 LoRA
 * （`models/loras/`）在这里只写名字，插件不读、也不该读权重——SD / Flux 的权重是
 * 绑架构的整套张量，必须在 ComfyUI 自己的 Python 进程里加载。
 *
 * 只用 Node 22 自带的 fetch / FormData / Blob，不装任何依赖。
 */
import { randomUUID } from 'node:crypto';
import { ImageApiError, sniffMime } from './api.js';

/** ComfyUI 侧的失败。`status` 沿用 HTTP 语义：0 = 连不上 / 超时。 */
export class ComfyError extends ImageApiError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ComfyError';
    this.promptId = String(opts.promptId ?? '');
  }
}

const DEFAULT_NEGATIVE = 'lowres, blurry, jpeg artifacts, watermark, text, extra fingers, deformed';

function base(url) {
  const trimmed = String(url ?? '').trim().replace(/[/\s]+$/, '');
  if (!trimmed) throw new ComfyError('没有配置 ComfyUI 地址（例如 http://127.0.0.1:8188）');
  return trimmed;
}

function at(baseUrl, path) {
  return `${base(baseUrl)}/${String(path).replace(/^\/+/, '')}`;
}

function snippet(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 一次 JSON 往返。ComfyUI 慢的时候（加载大模型）自己会先挂一会儿，
 * 所以这里的超时只管「这一跳」，整张图的预算由 waitForImages 管。
 */
async function requestJson(target, { method = 'GET', body, timeoutMs = 30000, what = 'ComfyUI' } = {}) {
  let res;
  try {
    res = await fetch(target, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? '等太久没响应' : (err?.cause?.message ?? err?.message ?? err);
    throw new ComfyError(`${what}连不上：${snippet(detail, 200)}`, { status: 0 });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const errObj = json?.error;
    const firstNode = json?.node_errors && typeof json.node_errors === 'object'
      ? json.node_errors[Object.keys(json.node_errors)[0]]
      : null;
    const nodeMsg = firstNode?.errors?.[0]?.message ?? firstNode?.errors?.[0]?.details;
    const raw = (errObj && typeof errObj === 'object' ? (errObj.message ?? errObj.type) : errObj) ?? nodeMsg ?? text;
    const extra = nodeMsg && nodeMsg !== raw ? `（${snippet(nodeMsg, 160)}）` : '';
    throw new ComfyError(`${what}返回 ${res.status}：${snippet(raw, 300)}${extra}`, {
      status: res.status,
      body: snippet(text, 800),
    });
  }
  if (!json && text.trim()) throw new ComfyError(`${what}没有返回 JSON：${snippet(text, 300)}`, { status: res.status });
  return json;
}

// ---------------------------------------------------------------------------
// 尺寸 / LoRA / 工作流
// ---------------------------------------------------------------------------

/** `1024x1536` → `{ width, height }`；`auto`、空、写错都退回 1024×1024。 */
export function sizeToWH(size, fallback = 1024) {
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(String(size ?? ''));
  if (!m) return { width: fallback, height: fallback };
  const dim = (v) => Math.max(64, Math.min(4096, Math.round(Number(v) / 8) * 8));
  return { width: dim(m[1]), height: dim(m[2]) };
}

/**
 * LoRA 写法：`"add_detail"`、`"add_detail:0.6"`，或 `{ name, strength, clipStrength }`。
 * 文件名要带扩展名（ComfyUI 的 `lora_name` 就是 `models/loras/` 里的相对文件名）。
 */
export function parseLoras(input) {
  const list = Array.isArray(input) ? input : (input ? [input] : []);
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    if (typeof raw === 'object') {
      const name = String(raw.name ?? raw.lora ?? '').trim();
      if (!name) continue;
      const strength = Number(raw.strength ?? raw.weight ?? 1);
      const clipStrength = Number(raw.clipStrength ?? raw.clip_strength ?? strength);
      out.push({ name, strength: finite(strength, 1), clipStrength: finite(clipStrength, 1) });
      continue;
    }
    const text = String(raw).trim();
    if (!text) continue;
    const idx = text.lastIndexOf(':');
    const maybeWeight = idx > 0 ? Number(text.slice(idx + 1)) : NaN;
    if (idx > 0 && Number.isFinite(maybeWeight)) {
      out.push({ name: text.slice(0, idx).trim(), strength: maybeWeight, clipStrength: maybeWeight });
    } else {
      out.push({ name: text, strength: 1, clipStrength: 1 });
    }
  }
  return out.filter((x) => x.name);
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** 把 LoRA 串成 `LoraLoader` 节点链，返回新的 model / clip 引用。 */
function loraNodes(loras, modelRef, clipRef, startId = 20) {
  const nodes = {};
  let model = modelRef;
  let clip = clipRef;
  loras.forEach((lora, i) => {
    const id = String(startId + i);
    nodes[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model,
        clip,
        lora_name: lora.name,
        strength_model: lora.strength,
        strength_clip: lora.clipStrength,
      },
    };
    model = [id, 0];
    clip = [id, 1];
  });
  return { nodes, model, clip };
}

/** 文生图工作流（ComfyUI 的 API 格式，节点 id 与 ComfyUI 默认模板一致，便于对照）。 */
export function txt2ImgWorkflow(opts = {}) {
  const { width, height } = sizeToWH(opts.size);
  const loras = parseLoras(opts.loras);
  const chain = loraNodes(loras, ['4', 0], ['4', 1]);
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: String(opts.ckpt ?? '') } },
    ...chain.nodes,
    6: { class_type: 'CLIPTextEncode', inputs: { text: String(opts.prompt ?? ''), clip: chain.clip } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: String(opts.negative ?? DEFAULT_NEGATIVE), clip: chain.clip } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: Math.max(0, Math.floor(finite(Number(opts.seed), Math.random() * 2 ** 31))),
        steps: Math.max(1, Math.min(150, Math.round(finite(Number(opts.steps), 25)))),
        cfg: Math.max(0, Math.min(30, finite(Number(opts.cfg), 7))),
        sampler_name: String(opts.sampler ?? 'euler'),
        scheduler: String(opts.scheduler ?? 'normal'),
        denoise: 1,
        model: chain.model,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: String(opts.prefix ?? 'coopanion'), images: ['8', 0] } },
  };
}

/** 图生图 / 改图工作流：`LoadImage` 读上传进 input/ 的那张，`denoise` 决定改得多狠。 */
export function img2ImgWorkflow(opts = {}) {
  const { width, height } = sizeToWH(opts.size);
  const loras = parseLoras(opts.loras);
  const chain = loraNodes(loras, ['4', 0], ['4', 1]);
  const workflow = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: String(opts.ckpt ?? '') } },
    ...chain.nodes,
    10: { class_type: 'LoadImage', inputs: { image: String(opts.image ?? '') } },
    11: {
      class_type: 'ImageScale',
      inputs: {
        image: ['10', 0],
        upscale_method: 'lanczos',
        width,
        height,
        crop: 'disabled',
      },
    },
    12: { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['4', 2] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: String(opts.prompt ?? ''), clip: chain.clip } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: String(opts.negative ?? DEFAULT_NEGATIVE), clip: chain.clip } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: Math.max(0, Math.floor(finite(Number(opts.seed), Math.random() * 2 ** 31))),
        steps: Math.max(1, Math.min(150, Math.round(finite(Number(opts.steps), 25)))),
        cfg: Math.max(0, Math.min(30, finite(Number(opts.cfg), 7))),
        sampler_name: String(opts.sampler ?? 'euler'),
        scheduler: String(opts.scheduler ?? 'normal'),
        denoise: Math.max(0.05, Math.min(1, finite(Number(opts.denoise), 0.6))),
        model: chain.model,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['12', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: String(opts.prefix ?? 'coopanion'), images: ['8', 0] } },
  };
  return workflow;
}

/**
 * 裸 UNet 三件套（Anima、Flux 这类不是 all-in-one 的模型）的文生图工作流。
 *
 * 节点照 ComfyUI 官方模板摆：`UNETLoader` + `CLIPLoader` + `VAELoader`，
 * LoRA 用 `LoraLoaderModelOnly`（Anima 的 LoRA 只改 UNet，没有 CLIP 那一半）。
 */
export function unetTxt2ImgWorkflow(opts = {}) {
  const { width, height } = sizeToWH(opts.size);
  return unetGraph(opts, { width, height, image: '' });
}

/** 裸 UNet 的图生图：先把参考图 `LoadImage` → 缩放 → `VAEEncode`，再按 denoise 重画。 */
export function unetImg2ImgWorkflow(opts = {}) {
  const { width, height } = sizeToWH(opts.size);
  return unetGraph(opts, { width, height, image: String(opts.image ?? '') });
}

function unetGraph(opts, { width, height, image }) {
  const loras = parseLoras(opts.loras);
  const nodes = {
    1: {
      class_type: 'UNETLoader',
      inputs: { unet_name: String(opts.unet ?? ''), weight_dtype: String(opts.weightDtype ?? 'default') },
    },
    2: {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: String(opts.textEncoder ?? ''),
        type: String(opts.textEncoderType ?? 'stable_diffusion'),
        device: 'default',
      },
    },
    3: { class_type: 'VAELoader', inputs: { vae_name: String(opts.vaeName ?? '') } },
  };

  let model = ['1', 0];
  loras.forEach((lora, i) => {
    const id = String(20 + i);
    nodes[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model, lora_name: lora.name, strength_model: lora.strength },
    };
    model = [id, 0];
  });

  nodes[5] = { class_type: 'CLIPTextEncode', inputs: { text: String(opts.prompt ?? ''), clip: ['2', 0] } };
  nodes[6] = { class_type: 'CLIPTextEncode', inputs: { text: String(opts.negative ?? DEFAULT_NEGATIVE), clip: ['2', 0] } };

  let latent;
  if (image) {
    nodes[10] = { class_type: 'LoadImage', inputs: { image } };
    nodes[11] = {
      class_type: 'ImageScale',
      inputs: { image: ['10', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' },
    };
    nodes[12] = { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } };
    latent = ['12', 0];
  } else {
    nodes[7] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    latent = ['7', 0];
  }

  nodes[8] = {
    class_type: 'KSampler',
    inputs: {
      seed: Math.max(0, Math.floor(finite(Number(opts.seed), Math.random() * 2 ** 31))),
      steps: Math.max(1, Math.min(150, Math.round(finite(Number(opts.steps), 30)))),
      cfg: Math.max(0, Math.min(30, finite(Number(opts.cfg), 4))),
      sampler_name: String(opts.sampler ?? 'euler'),
      scheduler: String(opts.scheduler ?? 'simple'),
      denoise: image ? Math.max(0.05, Math.min(1, finite(Number(opts.denoise), 0.6))) : 1,
      model,
      positive: ['5', 0],
      negative: ['6', 0],
      latent_image: latent,
    },
  };
  nodes[9] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
  nodes[13] = { class_type: 'SaveImage', inputs: { filename_prefix: String(opts.prefix ?? 'coopanion'), images: ['9', 0] } };
  return nodes;
}

/**
 * 自定义工作流模板的占位符替换：`"{{prompt}}"` 整串等于占位符时直接换成对应**类型**的值，
 * 其余字符串里做文本插值；认不出的占位符原样留着（方便人肉排查）。
 */export function applyVars(node, vars) {
  if (typeof node === 'string') {
    const exact = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(node);
    if (exact && Object.prototype.hasOwnProperty.call(vars, exact[1])) return vars[exact[1]];
    return node.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all));
  }
  if (Array.isArray(node)) return node.map((item) => applyVars(item, vars));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = applyVars(value, vars);
    return out;
  }
  return node;
}

/** 自定义模板能用的占位符（写进自描述/文档，也在这里当唯一口径）。 */
export const WORKFLOW_VARS = [
  'prompt', 'negative', 'ckpt', 'unet', 'textEncoder', 'textEncoderType', 'vaeName',
  'width', 'height', 'size', 'steps', 'cfg',
  'sampler', 'scheduler', 'seed', 'denoise', 'image', 'loras', 'prefix', 'filename',
];

// ---------------------------------------------------------------------------
// 提交 / 轮询 / 取图
// ---------------------------------------------------------------------------

/** 提交工作流，拿 `prompt_id`；节点校验不过直接抛（这类错误换后端也救不了）。 */
export async function submitPrompt(baseUrl, workflow, { timeoutMs = 30000 } = {}) {
  const json = await requestJson(at(baseUrl, 'prompt'), {
    method: 'POST',
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    timeoutMs,
    what: '提交工作流的 ComfyUI',
  });
  const nodeErrors = json?.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length) {
    const first = nodeErrors[Object.keys(nodeErrors)[0]];
    const detail = first?.errors?.[0]?.message ?? first?.errors?.[0]?.details ?? first?.class_type ?? JSON.stringify(first);
    throw new ComfyError(`ComfyUI 不收这份工作流：${snippet(detail, 240)}`, { status: 400 });
  }
  if (!json?.prompt_id) {
    throw new ComfyError(`ComfyUI 没给 prompt_id：${snippet(JSON.stringify(json ?? {}), 240)}`, { status: 0 });
  }
  return String(json.prompt_id);
}

/** 从 `history[<id>].outputs` 里挑出第一张图（优先 `type: output`）。 */
export function pickImage(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  const all = [];
  for (const node of Object.values(outputs)) {
    const images = node?.images ?? node?.gifs;
    if (Array.isArray(images)) all.push(...images.filter((it) => it && it.filename));
  }
  if (!all.length) return null;
  return all.find((it) => it.type === 'output') ?? all[0];
}

function execErrorText(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  for (const pair of messages) {
    const [kind, payload] = Array.isArray(pair) ? pair : [];
    if (kind === 'execution_error') {
      return snippet(payload?.exception_message ?? payload?.exception_type ?? JSON.stringify(payload ?? {}), 300);
    }
  }
  return 'ComfyUI 的执行状态是 error（原因没写进 history）';
}

/**
 * 轮询 `/history/<id>` 直到出图。超时先 `/interrupt` 再抛——把正在跑的放掉，
 * 免得占着显存让下一张一直排队。
 */
export async function waitForImages(baseUrl, promptId, { timeoutMs = 300000, onTick } = {}) {
  const deadline = Date.now() + Math.max(5000, timeoutMs);
  let delay = 700;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(1500, Math.round(delay * 1.4));
    let history = null;
    try {
      history = await requestJson(at(baseUrl, `history/${encodeURIComponent(promptId)}`), { timeoutMs: 20000 });
    } catch (err) {
      if (Number(err?.status) > 0) throw err;
      continue;
    }
    const entry = history?.[promptId];
    if (!entry) {
      onTick?.();
      continue;
    }
    if (entry.status?.status_str === 'error') {
      throw new ComfyError(`ComfyUI 画图出错：${execErrorText(entry)}`, { status: 400, promptId });
    }
    const picked = pickImage(entry.outputs);
    if (picked) return picked;
    onTick?.();
  }
  await interrupt(baseUrl).catch(() => {});
  throw new ComfyError(`等了 ${Math.round(timeoutMs / 1000)} 秒还没画完，已经让 ComfyUI 中断这张`, { status: 0, promptId });
}

/** 取一张成品图（`/view`）。 */
export async function fetchImage(baseUrl, image, { timeoutMs = 60000 } = {}) {
  const params = new URLSearchParams({
    filename: String(image.filename ?? ''),
    subfolder: String(image.subfolder ?? ''),
    type: String(image.type ?? 'output'),
  });
  let res;
  try {
    res = await fetch(at(baseUrl, `view?${params.toString()}`), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ComfyError(`取图时连不上 ComfyUI：${snippet(err?.cause?.message ?? err?.message ?? err, 200)}`, { status: 0 });
  }
  if (!res.ok) throw new ComfyError(`取图失败：ComfyUI 返回 ${res.status}`, { status: res.status });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new ComfyError('取回来的图是空的', { status: 0 });
  const header = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
  return { bytes, mime: (header.startsWith('image/') ? header : null) ?? sniffMime(bytes) ?? 'image/png' };
}

/** 把本地图传到 ComfyUI 的 `input/`，返回 `LoadImage` 认的名字（含子目录）。 */
export async function uploadImage(baseUrl, { bytes, mime = 'image/png', name = 'coopanion.png' }, { timeoutMs = 60000 } = {}) {
  const form = new FormData();
  form.set('image', new Blob([bytes], { type: mime || 'image/png' }), name);
  form.set('overwrite', 'true');
  let res;
  try {
    res = await fetch(at(baseUrl, 'upload/image'), { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ComfyError(`上传参考图时连不上 ComfyUI：${snippet(err?.cause?.message ?? err?.message ?? err, 200)}`, { status: 0 });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new ComfyError(`上传参考图失败：ComfyUI 返回 ${res.status}：${snippet(json?.error ?? text, 240)}`, { status: res.status });
  }
  const uploaded = String(json?.name ?? '');
  if (!uploaded) throw new ComfyError(`上传参考图没拿到文件名：${snippet(text, 240)}`, { status: 0 });
  const subfolder = String(json?.subfolder ?? '').trim();
  return subfolder ? `${subfolder}/${uploaded}` : uploaded;
}

/** 打断当前任务（超时收尾用）。 */
export async function interrupt(baseUrl, { timeoutMs = 10000 } = {}) {
  return await requestJson(at(baseUrl, 'interrupt'), { method: 'POST', body: '{}', timeoutMs, what: '中断任务的 ComfyUI' });
}

/** 探活：设置页与状态页用它判断「本地模型在不在」。 */
export async function probe(baseUrl, { timeoutMs = 5000 } = {}) {
  try {
    const json = await requestJson(at(baseUrl, 'system_stats'), { timeoutMs, what: 'ComfyUI' });
    const devices = Array.isArray(json?.devices) ? json.devices : [];
    const gpu = devices[0]?.name ?? '';
    return { ok: true, ready: true, gpu, devices: devices.map((d) => String(d?.name ?? '')).filter(Boolean) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 列出 ComfyUI 装了哪些 checkpoint（只用来提示「配置的名字对不上」，不阻断）。 */
export async function listCheckpoints(baseUrl, { timeoutMs = 15000 } = {}) {
  try {
    const json = await requestJson(at(baseUrl, 'object_info/CheckpointLoaderSimple'), { timeoutMs });
    const names = json?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(names) ? names.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 一次性问清 ComfyUI 装了哪些模型文件：all-in-one 的 checkpoint，以及裸 UNet 那三类
 * （`diffusion_models` 的 UNet、`text_encoders` 的文本编码器、`vae`）。
 *
 * 拿不到就返回空数组——探活只当「没核对」，不当失败。
 */
export async function listModels(baseUrl, { timeoutMs = 15000 } = {}) {
  const empty = { checkpoints: [], unets: [], textEncoders: [], vaes: [] };
  try {
    const json = await requestJson(at(baseUrl, 'object_info'), { timeoutMs });
    const pick = (type, field) => {
      const names = json?.[type]?.input?.required?.[field]?.[0];
      return Array.isArray(names) ? names.map(String) : [];
    };
    return {
      checkpoints: pick('CheckpointLoaderSimple', 'ckpt_name'),
      unets: pick('UNETLoader', 'unet_name'),
      textEncoders: pick('CLIPLoader', 'clip_name'),
      vaes: pick('VAELoader', 'vae_name'),
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 组合：一张图 = 模板 → 提交 → 等 → 取
// ---------------------------------------------------------------------------

/**
 * 文生图。`workflow` 给了就用自定义模板（走 `applyVars` 替换占位符），
 * 否则用内置的 SD/SDXL 文本生图工作流。
 * @returns {Promise<{bytes: Buffer, mime: string, revisedPrompt: null, promptId: string, image: object}>}
 */
export async function comfyDraw(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 300000;
  const { width, height } = sizeToWH(opts.size);
  const workflow = opts.workflow
    ? applyVars(opts.workflow, workflowVars(opts, { width, height, image: '', filename: '' }))
    : opts.unet
      ? unetTxt2ImgWorkflow(opts)
      : txt2ImgWorkflow(opts);
  const promptId = await submitPrompt(opts.baseUrl, workflow, { timeoutMs: Math.min(timeoutMs, 30000) });
  const picked = await waitForImages(opts.baseUrl, promptId, { timeoutMs, onTick: opts.onTick });
  const { bytes, mime } = await fetchImage(opts.baseUrl, picked, { timeoutMs: Math.min(timeoutMs, 60000) });
  return { bytes, mime: sniffMime(bytes) ?? mime, revisedPrompt: null, promptId, image: picked };
}

/**
 * 图生图 / 改图：先把参考图传到 `input/`，再用 img2img 工作流。
 * @returns {Promise<{bytes: Buffer, mime: string, revisedPrompt: null, promptId: string, image: object}>}
 */
export async function comfyEdit(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 300000;
  const { width, height } = sizeToWH(opts.size);
  const uploaded = await uploadImage(
    opts.baseUrl,
    { bytes: opts.image, mime: opts.mime, name: opts.name ?? 'coopanion.png' },
    { timeoutMs: Math.min(timeoutMs, 60000) },
  );
  const workflow = opts.workflow
    ? applyVars(opts.workflow, workflowVars(opts, { width, height, image: uploaded, filename: uploaded }))
    : opts.unet
      ? unetImg2ImgWorkflow({ ...opts, image: uploaded })
      : img2ImgWorkflow({ ...opts, image: uploaded });
  const promptId = await submitPrompt(opts.baseUrl, workflow, { timeoutMs: Math.min(timeoutMs, 30000) });
  const picked = await waitForImages(opts.baseUrl, promptId, { timeoutMs, onTick: opts.onTick });
  const { bytes, mime } = await fetchImage(opts.baseUrl, picked, { timeoutMs: Math.min(timeoutMs, 60000) });
  return { bytes, mime: sniffMime(bytes) ?? mime, revisedPrompt: null, promptId, image: picked };
}

/** 自定义模板里的占位符取值。 */
function workflowVars(opts, { width, height, image, filename }) {
  const loras = parseLoras(opts.loras);
  return {
    prompt: String(opts.prompt ?? ''),
    negative: String(opts.negative ?? DEFAULT_NEGATIVE),
    ckpt: String(opts.ckpt ?? ''),
    unet: String(opts.unet ?? ''),
    textEncoder: String(opts.textEncoder ?? ''),
    textEncoderType: String(opts.textEncoderType ?? 'stable_diffusion'),
    vaeName: String(opts.vaeName ?? ''),
    width,
    height,
    size: `${width}x${height}`,
    steps: Math.round(finite(Number(opts.steps), 25)),
    cfg: finite(Number(opts.cfg), 7),
    sampler: String(opts.sampler ?? 'euler'),
    scheduler: String(opts.scheduler ?? 'normal'),
    seed: Math.max(0, Math.floor(finite(Number(opts.seed), Math.random() * 2 ** 31))),
    denoise: finite(Number(opts.denoise), 0.6),
    image,
    filename,
    loras: loras.map((l) => `${l.name}:${l.strength}`).join(','),
    prefix: String(opts.prefix ?? 'coopanion'),
  };
}

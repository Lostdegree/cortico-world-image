/**
 * 模型链：把「画一张图」交给一串后端，按顺序试，失败就换下一档。
 *
 * 配置写在 `worlds.image.models`（JSON 数组，数组顺序就是优先级），每档可以是
 * `preset: 'openai'`（任何 OpenAI 兼容端点，含云端）或 `preset: 'comfyui'`（本地跑）。
 * 不写 `models` 时退回旧的单档配置（baseUrl / model / apiKeySecret / …），老用户不用改。
 *
 * 这里只管「按什么顺序试、什么错误该换下一档」，具体怎么调在 api.js / comfyui.js。
 */
import { ImageApiError } from './api.js';

export const PRESETS = ['openai', 'comfyui'];

const PRESET_LABEL = { openai: 'OpenAI 兼容', comfyui: 'ComfyUI' };

/** 链上每一档都失败时抛这个；`attempts` 是逐档的失败原因。 */
export class ChainError extends ImageApiError {
  constructor(message, attempts = []) {
    super(message, { status: attempts.length ? Number(attempts[attempts.length - 1]?.status) || 0 : 0 });
    this.name = 'ChainError';
    this.attempts = attempts;
  }
}

function asText(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(s)) return false;
  if (['true', '1', 'on', 'yes'].includes(s)) return true;
  return fallback;
}

/**
 * 解析 `worlds.image.models`。
 *
 * @param raw JSON 字符串，或已经解析好的数组；空 = 用旧单档。
 * @param legacy 旧单档配置（baseUrl/model/apiKeySecret/...）。
 * @returns {{entries: object[], error: string, warnings: string[]}}
 *   有 `error` 表示整份配置读不了（调用方应当放弃出图并告诉用户哪里写错）。
 */
export function parseChainEntries(raw, legacy = {}) {
  const warnings = [];
  const defaults = {
    baseUrl: asText(legacy.baseUrl),
    model: asText(legacy.model),
    apiKeySecret: asText(legacy.apiKeySecret, 'IMAGE_API_KEY'),
    size: asText(legacy.size, ''),
    quality: asText(legacy.quality, 'auto'),
    format: asText(legacy.format, 'png'),
    timeoutMs: Math.max(10000, Math.min(900000, asNumber(legacy.timeoutMs, 180000))),
    steps: 25,
    cfg: 7,
    sampler: 'euler',
    scheduler: 'normal',
    denoise: 0.6,
    negative: '',
    ckpt: '',
    loras: [],
    workflow: null,
    edit: true,
  };

  let list = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (Array.isArray(raw)) {
    list = raw;
  } else if (text) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        return { entries: [], error: '`models` 要是一个 JSON 数组，例如 [{"name":"local","preset":"comfyui","baseUrl":"http://127.0.0.1:8188","ckpt":"sd_xl_base_1.0.safetensors"}]', warnings };
      }
      list = parsed;
    } catch (err) {
      return { entries: [], error: `\`models\` 不是合法 JSON：${String(err?.message ?? err)}`, warnings };
    }
  }

  if (!list.length) {
    // 没有链 = 旧的单档配置。没有 baseUrl 时也算「没配」，交给调用方报 readyNoBase。
    return {
      entries: [normalize({}, 0, defaults, warnings, true)],
      error: '',
      warnings,
    };
  }

  const entries = [];
  const seen = new Set();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`第 ${index + 1} 档不是对象，已跳过`);
      return;
    }
    const entry = normalize(item, index, defaults, warnings, false);
    if (!entry.baseUrl) {
      warnings.push(`「${entry.name}」没有 baseUrl，已跳过`);
      return;
    }
    if (seen.has(entry.name)) {
      const renamed = `${entry.name}#${index + 1}`;
      warnings.push(`「${entry.name}」重名了，这一档改叫「${renamed}」`);
      entry.name = renamed;
    }
    seen.add(entry.name);
    entries.push(entry);
  });

  if (!entries.length) {
    return { entries: [], error: '`models` 里没有一档可用的（每档都要有 baseUrl，preset 只能是 openai / comfyui）', warnings };
  }
  return { entries, error: '', warnings };
}

function normalize(item, index, defaults, warnings, single) {
  const src = item && typeof item === 'object' ? item : {};
  const ckpt = asText(src.ckpt ?? src.checkpoint);
  const preset = asText(src.preset, ckpt ? 'comfyui' : 'openai').toLowerCase();
  const known = PRESETS.includes(preset);
  if (!known) warnings.push(`第 ${index + 1} 档的 preset「${preset}」不认识，只能是 ${PRESETS.join(' / ')}`);
  const name = asText(src.name, ckpt || asText(src.model) || (single ? 'default' : `${PRESET_LABEL[preset] ?? preset}#${index + 1}`));
  return {
    name,
    preset: known ? preset : 'openai',
    baseUrl: asText(src.baseUrl, defaults.baseUrl),
    model: asText(src.model, preset === 'comfyui' ? '' : defaults.model),
    apiKeySecret: asText(src.apiKeySecret, defaults.apiKeySecret),
    size: asText(src.size, defaults.size),
    quality: asText(src.quality, defaults.quality),
    format: asText(src.format, defaults.format),
    timeoutMs: Math.max(5000, Math.min(1800000, asNumber(src.timeoutMs, defaults.timeoutMs))),
    ckpt: preset === 'comfyui' ? ckpt : '',
    loras: Array.isArray(src.loras) ? src.loras : (src.loras ? [src.loras] : []),
    negative: asText(src.negative, defaults.negative),
    steps: Math.max(1, Math.min(150, Math.round(asNumber(src.steps, defaults.steps)))),
    cfg: Math.max(0, Math.min(30, asNumber(src.cfg, defaults.cfg))),
    sampler: asText(src.sampler, defaults.sampler),
    scheduler: asText(src.scheduler, defaults.scheduler),
    denoise: Math.max(0.05, Math.min(1, asNumber(src.denoise, defaults.denoise))),
    workflow: src.workflow ?? null,
    edit: asBool(src.edit, defaults.edit),
    enabled: asBool(src.enabled, true),
  };
}

/** 给人看的名字：优先 `name`，其次 ckpt / model。 */
export function entryLabel(entry) {
  return asText(entry?.name) || asText(entry?.ckpt) || asText(entry?.model) || asText(entry?.preset, '模型');
}

/** 一档的「能不能用」：ComfyUI 只要求地址，OpenAI 兼容还要求有密钥。 */
export function entryState(entry, { apiKey = '' } = {}) {
  if (!entry) return { ok: false, reason: '没有这一档' };
  if (!entry.enabled) return { ok: false, reason: '已停用' };
  if (!entry.baseUrl) return { ok: false, reason: '没配地址' };
  if (entry.preset === 'openai' && !apiKey) return { ok: false, reason: `没有密钥（${entry.apiKeySecret || 'IMAGE_API_KEY'}）` };
  if (entry.preset === 'comfyui' && !entry.ckpt) return { ok: false, reason: '没配 ckpt（checkpoint 文件名）' };
  return { ok: true, reason: '' };
}

/**
 * 按顺序试。`runner(entry)` 成功就返回；抛错就记一笔换下一档。
 *
 * `only` 指定某一档名字时只试那一档（模型在工具参数里点名了，就不该偷偷换别人）。
 */
export async function runChain(entries, runner, { only = '' } = {}) {
  const wanted = asText(only);
  const queue = wanted
    ? entries.filter((entry) => entry.name === wanted || entry.ckpt === wanted || entry.model === wanted)
    : entries;
  if (!queue.length) {
    throw new ChainError(wanted ? `没有叫「${wanted}」的模型档` : '模型链是空的：去「图片工坊 → 状态 → 模型链」里配一档', []);
  }
  const attempts = [];
  for (const entry of queue) {
    try {
      const res = await runner(entry);
      return { ...res, entry, attempts };
    } catch (err) {
      attempts.push({ name: entryLabel(entry), preset: entry.preset, status: Number(err?.status) || 0, message: String(err?.message ?? err) });
      if (wanted || isFatal(err)) break;
    }
  }
  throw new ChainError(describeAttempts(attempts), attempts);
}

/**
 * 换下一档也救不了的错误：提示词被内容审核拦了（同一条 prompt 换谁都会拦）。
 * 其余（连不上、超时、额度、模型没装、参数不支持…）都值得再试下一档。
 */
function isFatal(err) {
  if (err?.fatal === true) return true;
  const message = String(err?.message ?? '');
  return /moderation|content[_ ]policy|safety system|违规|敏感|不安全内容/i.test(message);
}

/** 把逐档失败拼成一句人话。 */
export function describeAttempts(attempts) {
  if (!attempts.length) return '没有可用的模型档';
  if (attempts.length === 1) {
    const one = attempts[0];
    return `${one.name} 失败了：${one.message}`;
  }
  const lines = attempts.map((it) => `- ${it.name}（${PRESET_LABEL[it.preset] ?? it.preset}）：${it.message}`);
  return `模型链上的 ${attempts.length} 档都失败了：\n${lines.join('\n')}`;
}

/** 状态页 / 徽章用：每档一行快照。 */
export function chainSnapshot(entries, { keys = new Map(), probe = null } = {}) {
  return entries.map((entry) => {
    const apiKey = entry.preset === 'openai' ? String(keys.get(entry.name) ?? keys.get(entry.apiKeySecret) ?? '') : '';
    const state = entryState(entry, { apiKey });
    return {
      name: entryLabel(entry),
      preset: entry.preset,
      baseUrl: entry.baseUrl,
      model: entry.preset === 'comfyui' ? entry.ckpt : entry.model,
      ok: state.ok,
      reason: state.reason,
      ...(entry.preset === 'comfyui' && probe ? { probe } : {}),
    };
  });
}

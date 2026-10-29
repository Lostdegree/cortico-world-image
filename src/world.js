/**
 * 图片工坊 World。
 *
 * 四件事：调 OpenAI 兼容的图片接口作画、把图落盘并记进索引、
 * 把图作为工具回执的 blob 交给 Core（于是进模型上下文与日志）、
 * 在自己的控制台页里实时显示。
 *
 * 只依赖框架契约与 Node 内置模块，服务端不需要编译。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ImageApiError, editImage, generateImage, normalizeCloudSize } from './api.js';
import { ChainError, chainSnapshot, entryLabel, entryState, parseChainEntries, runChain } from './chain.js';
import { comfyDraw, comfyEdit, listModels, probe as probeComfy } from './comfyui.js';
import { DEFAULTS, ID, configGroup, text } from './config.js';
import { Gallery } from './gallery.js';
import { samplePng } from './png.js';
import { TOOL_SPECS } from './tools.js';

/** 扩展包自带的模板；部署侧的覆盖文件由框架自己接在后面。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const msg = (err) => (err instanceof Error ? err.message : String(err));
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

// ---------------------------------------------------------------------------
// QQ 发图：本扩展不碰别人的安装目录了
// ---------------------------------------------------------------------------
//
// 以前这里有一整套「给第三方 QQ 扩展打补丁」的代码（0.3.x–0.6.2）：每次启动重写
// `cortico-world-qq-better-alont1` 与 `cortico-world-qq-final` 的源码，让 `[图片:…]`
// 认绝对路径与工作区相对路径。2026-10-28 起这些补丁搬到了 `cortico-world-patchkit`（补丁台），
// 由那边按版本留备份、按开关打与还原；本模块不再 import、不再写别的扩展的文件。
//
// 本扩展只负责把图和信息说清楚：
// - 旧包 `cortico-world-qq-better-alont1`：`qq_send_image` 填文件绝对路径（不打补丁也能用绝对路径）；
// - 新版 `cortico-world-qq-final` 0.6.35 及更早：打上补丁台那处「发图认路径」后可以写路径；
// - 新版 `cortico-world-qq-final` 0.6.36 起只发 `dist/`：没有源码可打，把它配置里的图片库目录
//   （`worlds.qqbot.imageDir`）指到本扩展的出图目录，正文写 `[图片:文件名]` 就能发。
// 三条都在设置项的说明与 ENV_PROMPT 里写着，模型照着说就行。

export class ImageWorld {
  #host = null;
  #streams = new Set();
  #gallery = null;
  #busy = 0;
  #lastError = '';
  #lastItemAt = '';

  constructor(opts = {}) {
    this.id = ID;
    this.cfg = opts.cfg ?? { ...DEFAULTS };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.botDir = opts.botDir ?? process.cwd();
    this.packageDir = opts.packageDir ?? process.cwd();
    this.secret = typeof opts.secret === 'function' ? opts.secret : () => '';
    this.storeSecret = typeof opts.storeSecret === 'function' ? opts.storeSecret : () => {};
    this.language = 'zh';
  }

  // -------------------------------------------------------------------------
  // 配置：config.json 的段被控制台热改，每次用时现读
  // -------------------------------------------------------------------------

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #str(key) {
    const value = this.#raw(key);
    const s = typeof value === 'string' ? value.trim() : '';
    return s || String(DEFAULTS[key] ?? '');
  }

  #num(key, min, max) {
    const n = Number(this.#raw(key));
    if (!Number.isFinite(n)) return Number(DEFAULTS[key]) || min;
    return Math.min(Math.max(n, min), max);
  }

  #bool(key) {
    const value = this.#raw(key);
    return typeof value === 'boolean' ? value : Boolean(DEFAULTS[key]);
  }

  #text() {
    return text(this.language);
  }

  /**
   * 解析模型链：`worlds.image.models`（JSON 数组）优先，空则退回旧的单档配置。
   * 每次现读，控制台改完即生效。
   */
  #chain() {
    return parseChainEntries(this.#raw('models'), {
      baseUrl: this.#str('baseUrl'),
      model: this.#str('model'),
      apiKeySecret: this.#str('apiKeySecret'),
      size: this.#str('size'),
      quality: this.#str('quality'),
      format: this.#str('format'),
      timeoutMs: this.#num('timeoutMs', 10000, 900000),
    });
  }

  /** 这一档现在能不能用（ComfyUI 只要地址 + ckpt，OpenAI 兼容还要求有密钥）。 */
  #entryState(entry) {
    return entryState(entry, { apiKey: this.#entryKey(entry) });
  }

  /** 能出图的那些档，顺序不变。 */
  #usableEntries(entries, { forEdit = false } = {}) {
    return entries.filter((entry) => this.#entryState(entry).ok && (!forEdit || entry.edit));
  }

  /** 一档都没有时，把每档差在哪拼成一句话。 */
  #chainReasons(entries) {
    const lines = entries.map((entry) => `- ${entryLabel(entry)}（${entry.preset}）：${this.#entryState(entry).reason || '可用'}`);
    return lines.length ? `\n${lines.join('\n')}` : '模型链是空的，去「图片工坊 → 状态 → 模型链」里配一档';
  }

  /** 图片根目录：配置了就用配置的（相对路径按 bot 目录解析），否则 <dataDir>/images。 */
  dir() {
    const raw = String(this.#raw('saveDir') ?? '').trim();
    if (!raw) return join(this.dataDir, 'images');
    return isAbsolute(raw) ? raw : resolve(this.botDir, raw);
  }

  /**
   * 密钥只在内存里过一手，不写 config.json。
   *
   * 先问部署 .env（`ctx.secret`），再退到同级 `providers/<端点>/.env`：
   * 机器上往往已经为画图建过一个端点，密钥名直接填那个就行，不必抄第二份。
   */
  #keyLookup(name = this.#str('apiKeySecret')) {
    if (!name) return { name, value: '', from: '', provider: '' };
    let own = '';
    try {
      own = String(this.secret(name) ?? '').trim();
    } catch {
      own = '';
    }
    if (own) return { name, value: own, from: 'bot', provider: '' };
    const found = this.#keyFromProviders(name);
    return {
      name,
      value: found.value,
      from: found.value ? 'provider' : '',
      provider: found.provider,
    };
  }

  /** 某一档要的密钥：先看这一档的 `apiKeySecret`，没写就用全局那个。 */
  #entryKey(entry) {
    const name = String(entry?.apiKeySecret ?? '').trim() || this.#str('apiKeySecret');
    return name ? this.#keyLookup(name).value : '';
  }

  /** 扫 `<botDir>/../providers/<端点>/.env`，找同名变量。 */
  #keyFromProviders(name) {
    const root = resolve(this.botDir, '..', 'providers');
    const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\S+)`, 'm');
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const hit = pattern.exec(readFileSync(join(root, entry.name, '.env'), 'utf8'));
        if (hit) return { value: hit[1], provider: entry.name };
      }
    } catch {
      // 没有 providers 目录、或某个端点没有 .env：当作没找到。
    }
    return { value: '', provider: '' };
  }

  apiKey() {
    return this.#keyLookup().value;
  }

  #galleryFor() {
    const dir = this.dir();
    const keep = this.#num('keep', 0, 5000);
    if (!this.#gallery || this.#gallery.dir !== dir) this.#gallery = new Gallery({ dir, keep });
    else this.#gallery.keep = keep;
    return this.#gallery;
  }

  #envState() {
    const t = this.#text();
    const { entries, error } = this.#chain();
    const key = this.#keyLookup();
    const base = {
      name: key.name,
      keySet: Boolean(key.value),
      keyFrom: key.from,
      keyProvider: key.provider,
      baseUrl: '',
      model: '',
      chain: [],
      chainError: error,
    };
    if (error) return { ...base, ok: false, detail: `${t.readyChainBad}：${error}` };
    const states = entries.map((entry) => ({ entry, state: this.#entryState(entry) }));
    const chain = states.map(({ entry, state }) => ({
      name: entryLabel(entry),
      preset: entry.preset,
      baseUrl: entry.baseUrl,
      model: entry.preset === 'comfyui' ? entry.ckpt : entry.model,
      ok: state.ok,
      reason: state.reason,
    }));
    const usable = states.filter((s) => s.state.ok).map((s) => s.entry);
    if (!usable.length) {
      const first = entries[0];
      const bare = entries.length === 1 && !first?.baseUrl;
      return {
        ...base,
        chain,
        ok: false,
        baseUrl: first?.baseUrl ?? '',
        model: first ? entryLabel(first) : '',
        detail: bare ? t.readyNoBase : `${t.readyNoChain}${this.#chainReasons(entries)}`,
      };
    }
    const labels = usable.map(entryLabel);
    return {
      ...base,
      chain,
      ok: true,
      baseUrl: usable[0].baseUrl,
      model: labels[0],
      detail: labels.length > 1 ? t.readyChain(labels.join(' → ')) : t.readyOk(labels[0]),
    };
  }

  // -------------------------------------------------------------------------
  // 提示词
  // -------------------------------------------------------------------------

  /** 文本归 ENV_PROMPT.md，这里只报两个占位符的值。 */
  envPromptVars() {
    const env = this.#envState();
    return {
      'image.dir': this.dir(),
      'image.ready': env.detail,
    };
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  tools() {
    // 声明在 src/tools.js，definition 的 describe.tools 用的是同一份（框架 0.2 起必需）。
    return TOOL_SPECS.map(({ name, description, parameters, tags }) => ({
      name,
      description,
      parameters,
      tags,
      handler: async (args) => this.#runTool(name, args ?? {}),
    }));
  }

  /** 按名字把 handler 接到各工具的实现上；名字表就是 TOOL_SPECS。 */
  async #runTool(name, args) {
    switch (name) {
      case 'image_draw': return await this.#draw(args);
      case 'image_edit': return await this.#edit(args);
      case 'image_gallery': return await this.#list(args);
      case 'image_show': return await this.#show(args);
      default: throw new Error(`未知工具：${name}`);
    }
  }

  async #draw(args) {
    const prompt = asText(args.prompt);
    if (!prompt) return { text: '[image_draw 没执行] prompt 是空的。不想画就别调用。', failed: true };
    const { entries, error } = this.#chain();
    if (error) return { text: `[image_draw 没执行] ${error}`, failed: true };
    const usable = this.#usableEntries(entries);
    if (!usable.length) return { text: `[image_draw 没执行] 没有能出图的一档：${this.#chainReasons(entries)}`, failed: true };
    const named = asText(args.model);
    const size = asText(args.size);
    const quality = asText(args.quality);
    this.#busy += 1;
    try {
      const res = await runChain(usable, (entry) => this.#generateWith(entry, { prompt, size, quality }), { only: named });
      const used = res.entry;
      const label = entryLabel(used);
      const shown = res.revisedPrompt ? String(res.revisedPrompt) : prompt;
      const note = asText(args.note);
      const sentSize = used.preset === 'openai' ? normalizeCloudSize(size || used.size) : '';
      const dims = res.size || sentSize || size || used.size || 'auto';
      const { item, warning } = this.#saveSafe({
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model: label,
        size: dims,
        source: 'api',
      });
      return this.#outcome({
        verb: '画好了。',
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model: label,
        size: dims,
        item,
        warning,
        attempts: res.attempts,
        hint: this.#sizeHint(used, size),
      });
    } catch (err) {
      return this.#failure('image_draw', err);
    } finally {
      this.#busy -= 1;
    }
  }

  async #edit(args) {
    const prompt = asText(args.prompt);
    if (!prompt) return { text: '[image_edit 没执行] prompt 是空的。', failed: true };
    const local = this.#localOf(args.image);
    if (!local) {
      return {
        text: `[image_edit 没执行] 找不到那张图：${asText(args.image) || '(空)'}。给绝对路径，或 image_gallery 里的编号。`,
        failed: true,
      };
    }
    const { entries, error } = this.#chain();
    if (error) return { text: `[image_edit 没执行] ${error}`, failed: true };
    const usable = this.#usableEntries(entries, { forEdit: true });
    if (!usable.length) return { text: `[image_edit 没执行] 没有能改图的一档：${this.#chainReasons(entries)}`, failed: true };
    const named = asText(args.model);
    const size = asText(args.size);
    const quality = asText(args.quality);
    this.#busy += 1;
    try {
      const res = await runChain(usable, (entry) => this.#editWith(entry, { prompt, size, quality, local }), { only: named });
      const used = res.entry;
      const label = entryLabel(used);
      const shown = res.revisedPrompt ? String(res.revisedPrompt) : prompt;
      const note = asText(args.note);
      const sentSize = used.preset === 'openai' ? normalizeCloudSize(size || used.size) : '';
      const dims = res.size || sentSize || size || used.size || 'auto';
      const { item, warning } = this.#saveSafe({
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model: label,
        size: dims,
        source: 'edit',
      });
      return this.#outcome({
        verb: '改好了。',
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model: label,
        size: dims,
        item,
        warning,
        attempts: res.attempts,
        hint: this.#sizeHint(used, size),
      });
    } catch (err) {
      return this.#failure('image_edit', err);
    } finally {
      this.#busy -= 1;
    }
  }

  /** 用一档后端画一张新图。 */
  async #generateWith(entry, { prompt, size, quality }) {
    if (entry.preset === 'comfyui') {
      const res = await comfyDraw({
        baseUrl: entry.baseUrl,
        ckpt: entry.ckpt,
        unet: entry.unet,
        textEncoder: entry.textEncoder,
        textEncoderType: entry.textEncoderType,
        vaeName: entry.vaeName,
        loras: entry.loras,
        negative: entry.negative,
        prompt,
        size: size || entry.size,
        steps: entry.steps,
        cfg: entry.cfg,
        sampler: entry.sampler,
        scheduler: entry.scheduler,
        workflow: entry.workflow,
        prefix: 'coopanion',
        timeoutMs: entry.timeoutMs,
      });
      return { bytes: res.bytes, mime: res.mime, revisedPrompt: null, promptId: res.promptId, size: res.size };
    }
    const key = this.#entryKey(entry);
    if (!key) {
      throw new ImageApiError(`没有配置 ${entry.apiKeySecret || this.#str('apiKeySecret')}：在「图片工坊 → 状态」里填入密钥，或在部署 .env 里写这个变量`, { status: 401 });
    }
    return await generateImage({
      baseUrl: entry.baseUrl,
      apiKey: key,
      model: entry.model,
      prompt,
      size: size || entry.size,
      quality: quality || entry.quality,
      format: entry.format,
      timeoutMs: entry.timeoutMs,
    });
  }

  /** 用一档后端改一张已有的图。 */
  async #editWith(entry, { prompt, size, quality, local }) {
    if (entry.preset === 'comfyui') {
      const res = await comfyEdit({
        baseUrl: entry.baseUrl,
        ckpt: entry.ckpt,
        unet: entry.unet,
        textEncoder: entry.textEncoder,
        textEncoderType: entry.textEncoderType,
        vaeName: entry.vaeName,
        loras: entry.loras,
        negative: entry.negative,
        prompt,
        image: readFileSync(local.path),
        mime: local.mime,
        name: local.path.split(/[\\/]/).pop(),
        size: size || entry.size,
        denoise: entry.denoise,
        steps: entry.steps,
        cfg: entry.cfg,
        sampler: entry.sampler,
        scheduler: entry.scheduler,
        workflow: entry.workflow,
        prefix: 'coopanion',
        timeoutMs: entry.timeoutMs,
      });
      return { bytes: res.bytes, mime: res.mime, revisedPrompt: null, promptId: res.promptId, size: res.size };
    }
    const key = this.#entryKey(entry);
    if (!key) {
      throw new ImageApiError(`没有配置 ${entry.apiKeySecret || this.#str('apiKeySecret')}`, { status: 401 });
    }
    return await editImage({
      baseUrl: entry.baseUrl,
      apiKey: key,
      model: entry.model,
      prompt,
      image: readFileSync(local.path),
      mime: local.mime,
      name: local.path.split(/[\\/]/).pop(),
      size: size || entry.size,
      quality: quality || entry.quality,
      format: entry.format,
      timeoutMs: entry.timeoutMs,
    });
  }

  async #list(args) {
    const raw = Number(args.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.round(raw), 50)) : 12;
    const items = this.#galleryFor().list(limit);
    if (!items.length) return '作品列表是空的。可以用 image_draw 画第一张。';
    const lines = items.map((it) => {
      const label = it.note || (it.prompt.length > 40 ? `${it.prompt.slice(0, 40)}…` : it.prompt);
      return `- ${it.id} · ${it.createdAt} · ${it.size || '?'} · ${label}\n  路径：${it.path}`;
    });
    return `最近 ${items.length} 张（编号可以给 image_show 或 image_edit）：\n${lines.join('\n')}`;
  }

  async #show(args) {
    const ref = asText(args.id);
    if (!ref) return { text: '[image_show 没执行] 要给编号或路径。', failed: true };
    const local = this.#localOf(ref);
    if (!local) return { text: `[image_show 没执行] 找不到：${ref}。`, failed: true };
    let bytes = null;
    try {
      bytes = readFileSync(local.path);
    } catch (err) {
      return { text: `[image_show 没执行] 读不了这张图：${msg(err)}`, failed: true };
    }
    const item = local.item;
    if (item) this.#emit({ t: 'focus', id: item.id });
    return this.#outcome({
      verb: '把这张图重新拿出来了。',
      bytes,
      mime: local.mime,
      prompt: item?.prompt ?? '',
      note: item?.note ?? '',
      model: item?.model ?? '',
      size: item?.size ?? '',
      item,
      warning: '',
    });
  }

  #failure(tool, err) {
    const detail = err instanceof ImageApiError ? err.message : msg(err);
    this.#lastError = `${new Date().toISOString()} ${detail}`;
    this.#emit({ t: 'error', message: detail, tool }, true);
    return { text: `[${tool} 失败] ${detail}`, failed: true };
  }

  // -------------------------------------------------------------------------
  // 落盘与回执
  // -------------------------------------------------------------------------

  #saveSafe(payload) {
    try {
      return { item: this.#storeBytes(payload), warning: '' };
    } catch (err) {
      return { item: null, warning: `（存盘失败，图只在这次回执里：${msg(err)}）` };
    }
  }

  #storeBytes(payload) {
    const item = this.#galleryFor().add(payload);
    this.#lastItemAt = item.createdAt;
    this.#emit({ t: 'item', item });
    return item;
  }

  /**
   * 云端那档只认「宽x高」：别名会被换成三档之一，认不出来的干脆不发。
   * 换掉的不吭声（结果就是你要的方向），**没发**的必须在回执里说一句，否则用户会以为尺寸生效了。
   */
  #sizeHint(entry, sizeArg) {
    if (entry?.preset !== 'openai') return '';
    const asked = asText(sizeArg) || asText(entry.size);
    if (!asked || normalizeCloudSize(asked)) return '';
    return `提示：云端这档不认 size「${asked}」，这次没带 size、按它的默认尺寸出图；要指定就写「1024x1536」或「16:9」。`;
  }

  /** 工具回执：文本给模型读，blob 交给 Core 进上下文。 */
  #outcome(spec) {
    const bytes = spec.bytes;
    const kb = bytes.length >= 102400 ? String(Math.round(bytes.length / 1024)) : (bytes.length / 1024).toFixed(1);
    const name = spec.item?.file ?? `image-${Date.now().toString(36)}.png`;
    const lines = [spec.verb];
    if (spec.item) lines.push(`文件：${spec.item.path}`);
    lines.push(`参数：${spec.size || '默认尺寸'} · ${spec.model || '默认模型'} · ${kb} KB`);
    if (spec.hint) lines.push(spec.hint);
    if (Array.isArray(spec.attempts) && spec.attempts.length) {
      lines.push(`前几档没成：${spec.attempts.map((it) => `${it.name}（${it.message}）`).join('；')}`);
    }
    if (spec.note) lines.push(`名字：${spec.note}`);
    if (spec.prompt) lines.push(`画面：${spec.prompt}`);
    if (spec.warning) lines.push(spec.warning);
    lines.push(
      '图已进入本次对话，也显示在「图片工坊」页。要发给某人或某个群：'
      + '官方 QQ 扩展（world `qq`）把上面那行 `[blob …]` 句柄交给 `qq_draft` 的 `image`；'
      + '旧版第三方 QQ 扩展（`cortico-world-qq-better-alont1`）用 `qq_send_image` 填文件的绝对路径；'
      + '新版第三方 QQ 扩展（`cortico-world-qq-final`）在正文里写 `[图片:文件名]`，'
      + `这次就是 [图片:${name}]——`
      + '0.6.35 及更早的版本要靠补丁台的「发图认路径」补丁才能写路径，'
      + '0.6.36 起只发编译产物、没有源码可打，需要把 QQ 扩展配置里的图片库目录（`worlds.qqbot.imageDir`）'
      + '指到本扩展的出图目录（设置页「保存目录」那一项）。',
    );
    return {
      text: lines.join('\n'),
      blobs: [{
        bytes,
        mime: spec.mime,
        name,
        fallbackText: `[图片 ${name}｜${spec.size || ''} ${kb}KB]`,
      }],
    };
  }

  /** 编号、文件名、绝对路径、相对 bot 目录的路径都认。 */
  #localOf(ref) {
    const raw = asText(ref).replace(/^["']|["']$/g, '');
    if (!raw) return null;
    const known = this.#galleryFor().get(raw);
    if (known && existsSync(known.path)) return { path: known.path, mime: known.mime, item: known };
    const guess = isAbsolute(raw) ? raw : resolve(this.botDir, raw);
    if (!existsSync(guess)) return null;
    try {
      if (!statSync(guess).isFile()) return null;
    } catch {
      return null;
    }
    const mime = MIME_BY_EXT[extname(guess).toLowerCase()] ?? null;
    if (!mime) return null;
    return { path: guess, mime, item: null };
  }

  // -------------------------------------------------------------------------
  // 控制台
  // -------------------------------------------------------------------------

  webUi(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = this.#text();
    const env = this.#envState();
    const gallery = this.#galleryFor();
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: env.ok ? 'online' : (env.baseUrl ? 'error' : 'offline'),
        hint: env.detail,
      }],
      badges: [
        { label: t.badgeWorks, value: String(gallery.count), tone: gallery.count ? 'on' : 'off' },
        { label: t.badgeKey, value: env.keySet ? t.keySet : t.keyUnset, tone: env.keySet ? 'on' : 'off' },
      ],
      panels: [
        { id: 'gallery', title: t.panelGalleryTitle, description: t.panelGalleryDesc, getMethods: ['list'] },
        { id: 'status', title: t.panelStatusTitle, description: t.panelStatusDesc, getMethods: ['state', 'selftest'] },
      ],
      config: [configGroup(this.language)],
      promptDocs: [{
        key: `worlds.${ID}.envPrompt`,
        title: t.promptDocTitle,
        description: t.promptDocDesc,
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'image.dir', description: t.varDir },
          { name: 'image.ready', description: t.varReady },
        ],
      }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
    };
  }

  async invoke(panel, method, args = []) {
    const list = Array.isArray(args) ? args : [args];
    if (panel === 'gallery') {
      switch (method) {
        case 'list': return this.#galleryFor().summary(list[0]);
        case 'blob': return this.#fileResult(list[0]);
        case 'remove': return this.#remove(list[0]);
        case 'clear': return this.#clearAll();
        case 'openFolder': return this.#openFolder();
        case 'selftest': return this.#selfTest();
        default: throw new Error(`未知面板方法：gallery.${method}`);
      }
    }
    if (panel === 'status') {
      switch (method) {
        case 'state': return this.#state();
        case 'probe': return await this.#probeChain();
        case 'setKey': return this.#setKey(list[0]);
        case 'clearKey': return this.#setKey('');
        // 面板「自检」按钮发的是 status.selftest（旧版挂在 gallery 上），两处都认。
        case 'selftest': return this.#selfTest();
        default: throw new Error(`未知面板方法：status.${method}`);
      }
    }
    throw new Error(`未知面板：${panel}`);
  }

  #state() {
    const env = this.#envState();
    const gallery = this.#galleryFor();
    return {
      language: this.language,
      node: process.version,
      platform: process.platform,
      dir: this.dir(),
      indexFile: gallery.indexFile,
      keep: gallery.keep,
      count: gallery.count,
      totalBytes: gallery.totalBytes,
      busy: this.#busy > 0,
      lastError: this.#lastError,
      lastItemAt: this.#lastItemAt,
      baseUrl: env.baseUrl,
      model: env.model,
      size: this.#str('size'),
      quality: this.#str('quality'),
      format: this.#str('format'),
      timeoutMs: this.#num('timeoutMs', 10000, 900000),
      keyName: env.name,
      keySet: env.keySet,
      keyFrom: env.keyFrom,
      keyProvider: env.keyProvider,
      detail: env.detail,
      models: this.#raw('models'),
      chain: env.chain,
      chainError: env.chainError,
    };
  }

  /**
   * 逐个探活：ComfyUI 看 `/system_stats`（顺带核对 ckpt 在不在），
   * OpenAI 兼容看 `/models`（有的端点没这条路由，当作不判定）。
   * 「状态」页的「测试模型链」用它；只返回结果，不改配置。
   */
  async #probeChain() {
    const { entries, error } = this.#chain();
    const at = new Date().toISOString();
    if (error) return { at, error, items: [] };
    // 探活是给人在面板上点的，宁可「说不清」也不能把 RPC 拖到超时：
    // 每档最多 6 秒、几档并行，最慢一次也就 6 秒出结果。
    const cap = (ms) => Math.max(1000, Math.min(Number(ms) > 0 ? Number(ms) : 6000, 6000));
    const items = await Promise.all(
      entries.map(async (entry) => {
        const name = entryLabel(entry);
        const preset = entry.preset;
        try {
          const state = this.#entryState(entry);
          if (!state.ok) return { name, preset, ok: false, detail: state.reason };
          if (preset === 'comfyui') {
            const probe = await probeComfy(entry.baseUrl, { timeoutMs: cap(entry.timeoutMs) });
            if (!probe.ok) return { name, preset, ok: false, detail: probe.error };
            const where = probe.gpu ? `（${probe.gpu}）` : '';
            // 自定义工作流里的文件名都写在模板里，这里只确认服务在线。
            if (entry.workflow) return { name, preset, ok: true, detail: `在线${where} · 自定义工作流` };
            const files = await listModels(entry.baseUrl, { timeoutMs: cap(entry.timeoutMs) });
            // 拿不到清单（老版本 / 路由没有）就只报在线，不硬说文件不在。
            if (entry.unet) {
              const miss = [];
              const check = (list, value, hint) => {
                if (!value || !list.length || list.includes(value)) return;
                miss.push(`${hint}：${value}`);
              };
              check(files.unets, entry.unet, '没有这个 UNet');
              check(files.textEncoders, entry.textEncoder, '没有这个文本编码器');
              check(files.vaes, entry.vaeName, '没有这个 VAE');
              const label = `${entry.unet} + ${entry.textEncoder || '?'} + ${entry.vaeName || '?'}`;
              return {
                name,
                preset,
                ok: miss.length === 0,
                detail: miss.length
                  ? `在线，但${miss.join('、')}（那边有 ${files.unets.length} 个 UNet / ${files.textEncoders.length} 个文本编码器 / ${files.vaes.length} 个 VAE）`
                  : `在线${where} · ${label}${files.unets.length ? '' : '（没拿到模型清单，未核对）'}`,
              };
            }
            const ckpts = files.checkpoints;
            const has = !ckpts.length || ckpts.includes(entry.ckpt);
            return {
              name,
              preset,
              ok: has,
              detail: has
                ? `在线${where} · ${entry.ckpt || '没写 ckpt'}`
                : `在线，但没有这个 ckpt：${entry.ckpt}（那边装了 ${ckpts.length} 个）`,
            };
          }
          const key = this.#entryKey(entry);
          const target = `${String(entry.baseUrl ?? '').replace(/[/\s]+$/, '')}/models`;
          const res = await fetch(target, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(cap(entry.timeoutMs)),
          });
          return {
            name,
            preset,
            ok: res.ok || res.status === 404,
            detail: res.ok
              ? `在线 · ${entry.model}`
              : res.status === 404
                ? `端点没有 /models，跳过检查 · ${entry.model}`
                : `返回 ${res.status} · ${entry.model}`,
          };
        } catch (err) {
          return { name, preset, ok: false, detail: `连不上：${msg(err)}` };
        }
      }),
    );
    return { at, error: '', items };
  }

  #setKey(value) {
    const name = this.#str('apiKeySecret');
    const next = typeof value === 'string' ? value.trim() : '';
    try {
      this.storeSecret(name, next);
    } catch (err) {
      throw new Error(`写不进 .env：${msg(err)}`);
    }
    return { ...this.#state(), keyName: name, keySet: Boolean(next), saved: true };
  }

  #fileResult(ref) {
    const item = this.#galleryFor().get(ref);
    if (!item) throw new Error('找不到这张图');
    let stat = null;
    try {
      stat = statSync(item.path);
    } catch {
      throw new Error('图片文件不在了');
    }
    const sha256 = createHash('sha256').update(readFileSync(item.path)).digest('hex');
    return { $file: { mime: item.mime, path: item.path, bytes: stat.size, sha256 } };
  }

  #remove(ref) {
    const id = asText(ref);
    const ok = this.#galleryFor().remove(id);
    if (ok) this.#emit({ t: 'removed', id });
    return { ok, ...this.#counts() };
  }

  #clearAll() {
    const removed = this.#galleryFor().clear();
    this.#emit({ t: 'cleared' });
    return { ok: true, removed, ...this.#counts() };
  }

  #counts() {
    const gallery = this.#galleryFor();
    return { count: gallery.count, totalBytes: gallery.totalBytes };
  }

  /** 离线自检：不联网也能验证落盘、索引、$file 取图与页面显示。 */
  #selfTest() {
    const bytes = samplePng(768, 480);
    const item = this.#storeBytes({
      bytes,
      mime: 'image/png',
      prompt: '离线自检样图：没有调用任何图片接口。',
      note: '自检样图',
      model: 'self-test',
      size: '768x480',
      source: 'selftest',
    });
    return { ok: true, item, ...this.#counts() };
  }

  #openFolder() {
    const dir = this.dir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 打不开就算了，返回给面板看。 */
    }
    if (process.platform !== 'win32') return { ok: false, dir, detail: '只会在 Windows 上打开资源管理器' };
    try {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, dir };
    } catch (err) {
      return { ok: false, dir, detail: msg(err) };
    }
  }

  stream(panel, socket) {
    if (panel !== 'gallery') {
      try {
        socket.close(`未知面板：${panel}`);
      } catch {
        /* ignore */
      }
      return;
    }
    const peer = {
      send: (frame) => {
        try {
          if (socket.open) socket.send(JSON.stringify(frame));
        } catch {
          /* 连接断了就算了，面板会自己重连。 */
        }
      },
    };
    this.#streams.add(peer);
    try {
      socket.onClose(() => this.#streams.delete(peer));
      socket.onMessage(() => { /* 面板只用 HTTP 请求，回帧不处理。 */ });
    } catch {
      /* 宿主实现不支持回调也不影响单向推送。 */
    }
    peer.send({ t: 'ready', dir: this.dir(), count: this.#galleryFor().count });
  }

  #emit(frame, force = false) {
    if (!force && !this.#bool('pushToConsole')) return;
    for (const peer of this.#streams) peer.send(frame);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    this.#host = host;
    try {
      this.#galleryFor().ensure();
    } catch (err) {
      this.#host?.log?.warn?.('图片工坊：数据目录建不出来', { err: msg(err) });
    }
    this.#host?.log?.info?.('图片工坊已就绪', {
      dir: this.dir(),
      model: this.#str('model'),
      key: this.apiKey() ? '已配置' : '未配置',
    });
  }

  async stop() {
    this.#streams.clear();
    this.#host = null;
  }
}

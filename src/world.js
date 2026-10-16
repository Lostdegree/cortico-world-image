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

import { ImageApiError, editImage, generateImage } from './api.js';
import { applyChatImagePatches, consolePort, patchBackupStatus, requestConsoleRestart, resolveAppRoot, restoreChatImagePatches } from './chat-image-patch.js';
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

/** 本扩展包根目录（补丁状态文件、`ENV_PROMPT.md` 都在这一层）。 */
const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------------------
// 自愈补丁：安装目录里的两处代码每次启动都对一遍
// ---------------------------------------------------------------------------
//
// 桌宠要在控制台「对话」页发图，得改安装目录里的两份文件（客户端 bundle 的 say 渲染、
// 桌宠包的 chat.ts/world.ts）。程序自动更新会把这些文件覆写回去，所以靠扩展模块的
// 顶层代码每次启动重打一遍 —— `loadExtensions()` 无论世界开没开都会 import 本模块。
//
// 打好的补丁写回了磁盘，但桌宠包的 TS 是进程启动时 import 的，要重启进程才装载；
// 重启请求放在 `start()` 里（那时才拿得到控制台端口），并用状态文件防死循环。

/** 最近一次补丁检查的结果；「状态」页显示它，也能手动重打或按备份还原。 */
let PATCH_STATE = {
  at: '',
  appRoot: '',
  patched: [],
  failed: [],
  done: 0,
  total: 0,
  stuck: false,
  restartPending: false,
  error: '',
  restart: null,
  /** 手动还原的记录：`{at, restored:[id], failed:[id], byFile:[{file,backup,state}]}`，没还原过就是 null。 */
  restored: null,
};

/** 重新对一遍补丁，并把结果收进 `PATCH_STATE`。 */
function refreshPatchState({ stateDir, log } = {}) {
  const appRoot = resolveAppRoot([stateDir, process.cwd()]);
  const report = applyChatImagePatches(appRoot, { stateDir, log });
  PATCH_STATE = {
    ...PATCH_STATE,
    at: new Date().toISOString(),
    appRoot: report.appRoot ?? appRoot ?? '',
    patched: report.patched,
    failed: report.results
      .filter((r) => r.state === 'failed' || r.state === 'missing')
      .map((r) => ({ id: r.id, what: r.what, error: r.error ?? '' })),
    done: report.results.filter((r) => r.state === 'done').length,
    // 可选补丁（第三方扩展没装）记 absent：不计进总数，免得状态页写「7/9 没打上」。
    total: report.results.filter((r) => r.state !== 'absent').length,
    stuck: report.stuck,
    restartPending: report.restartPending,
    error: report.error ?? '',
    restored: report.patched.length ? null : PATCH_STATE.restored,
  };
  return PATCH_STATE;
}

if (process.env.COOPANION_CHAT_IMAGE_PATCH !== '0') {
  try {
    refreshPatchState({ stateDir: PACKAGE_DIR });
  } catch (err) {
    PATCH_STATE.error = msg(err);
  }
}

export class ImageWorld {
  #host = null;
  #streams = new Set();
  #gallery = null;
  #busy = 0;
  #lastError = '';
  #lastItemAt = '';
  #restartTimer = null;

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
  #keyLookup() {
    const name = this.#str('apiKeySecret');
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
    const baseUrl = this.#str('baseUrl');
    const model = this.#str('model');
    const key = this.#keyLookup();
    const name = key.name;
    const keySet = Boolean(key.value);
    const extra = { keyFrom: key.from, keyProvider: key.provider };
    if (!baseUrl) return { ok: false, baseUrl, model, name, keySet, detail: t.readyNoBase, ...extra };
    if (!keySet) return { ok: false, baseUrl, model, name, keySet, detail: t.readyNoKey, ...extra };
    return { ok: true, baseUrl, model, name, keySet, detail: t.readyOk(model), ...extra };
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
    const keyName = this.#str('apiKeySecret');
    const key = this.apiKey();
    if (!key) {
      return {
        text: `[image_draw 没执行] 没有配置 ${keyName}：请在控制台「图片工坊 → 状态」里填入密钥（或在部署 .env 里写 ${keyName}=...）。`,
        failed: true,
      };
    }
    const model = this.#str('model');
    const size = asText(args.size) || this.#str('size');
    const quality = asText(args.quality) || this.#str('quality');
    this.#busy += 1;
    try {
      const res = await generateImage({
        baseUrl: this.#str('baseUrl'),
        apiKey: key,
        model,
        prompt,
        size,
        quality,
        format: this.#str('format'),
        timeoutMs: this.#num('timeoutMs', 10000, 900000),
      });
      const shown = res.revisedPrompt ? String(res.revisedPrompt) : prompt;
      const note = asText(args.note);
      const { item, warning } = this.#saveSafe({
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model,
        size: size || 'auto',
        source: 'api',
      });
      return this.#outcome({
        verb: '画好了。',
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model,
        size: size || 'auto',
        item,
        warning,
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
    const key = this.apiKey();
    if (!key) {
      return { text: `[image_edit 没执行] 没有配置 ${this.#str('apiKeySecret')}。`, failed: true };
    }
    const model = this.#str('model');
    const size = asText(args.size) || this.#str('size');
    const quality = asText(args.quality) || this.#str('quality');
    this.#busy += 1;
    try {
      const res = await editImage({
        baseUrl: this.#str('baseUrl'),
        apiKey: key,
        model,
        prompt,
        image: readFileSync(local.path),
        mime: local.mime,
        name: local.path.split(/[\\/]/).pop(),
        size,
        quality,
        format: this.#str('format'),
        timeoutMs: this.#num('timeoutMs', 10000, 900000),
      });
      const shown = res.revisedPrompt ? String(res.revisedPrompt) : prompt;
      const note = asText(args.note);
      const { item, warning } = this.#saveSafe({
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model,
        size: size || 'auto',
        source: 'edit',
      });
      return this.#outcome({
        verb: '改好了。',
        bytes: res.bytes,
        mime: res.mime,
        prompt: shown,
        note,
        model,
        size: size || 'auto',
        item,
        warning,
      });
    } catch (err) {
      return this.#failure('image_edit', err);
    } finally {
      this.#busy -= 1;
    }
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

  /** 工具回执：文本给模型读，blob 交给 Core 进上下文。 */
  #outcome(spec) {
    const bytes = spec.bytes;
    const kb = bytes.length >= 102400 ? String(Math.round(bytes.length / 1024)) : (bytes.length / 1024).toFixed(1);
    const name = spec.item?.file ?? `image-${Date.now().toString(36)}.png`;
    const lines = [spec.verb];
    if (spec.item) lines.push(`文件：${spec.item.path}`);
    lines.push(`参数：${spec.size || '默认尺寸'} · ${spec.model || '默认模型'} · ${kb} KB`);
    if (spec.note) lines.push(`名字：${spec.note}`);
    if (spec.prompt) lines.push(`画面：${spec.prompt}`);
    if (spec.warning) lines.push(spec.warning);
    lines.push('图已进入本次对话，也显示在「图片工坊」页。要发给某人或某个群，把上面的绝对路径交给 qq_send_image。');
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
    const patchRestored = Boolean(PATCH_STATE.restored?.restored?.length);
    const patchValue = PATCH_STATE.error
      ? t.patchOff
      : !PATCH_STATE.at
        ? t.patchUnchecked
        : PATCH_STATE.failed.length
          ? t.patchMissing(PATCH_STATE.failed.length)
          : patchRestored
            ? t.patchRestored
            : (PATCH_STATE.restartPending ? t.patchPending : t.patchOk);
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
        {
          label: t.badgePatch,
          value: patchValue,
          tone: PATCH_STATE.error || !PATCH_STATE.at || PATCH_STATE.failed.length || PATCH_STATE.restartPending || patchRestored ? 'off' : 'on',
        },
      ],
      panels: [
        { id: 'gallery', title: t.panelGalleryTitle, description: t.panelGalleryDesc, getMethods: ['list'] },
        { id: 'status', title: t.panelStatusTitle, description: t.panelStatusDesc, getMethods: ['state'] },
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
        case 'repatch': return this.#repatch();
        case 'restore': return this.#restore();
        case 'restart': return this.#askRestart('控制台手动请求');
        case 'setKey': return this.#setKey(list[0]);
        case 'clearKey': return this.#setKey('');
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
      patch: {
        ...PATCH_STATE,
        packageDir: PACKAGE_DIR,
        backups: patchBackupStatus(PATCH_STATE.appRoot || resolveAppRoot([PACKAGE_DIR, process.cwd()])),
      },
    };
  }

  /**
   * 重新对一遍「对话页发图」补丁。
   *
   * 平时用不着（每次启动都会自己打），留给两处：更新覆写后发现没打上，
   * 或者想看看到底改了哪几处。
   */
  #repatch() {
    if (process.env.COOPANION_CHAT_IMAGE_PATCH === '0') {
      return { ...PATCH_STATE, packageDir: PACKAGE_DIR, skipped: 'COOPANION_CHAT_IMAGE_PATCH=0：这次不改安装目录。' };
    }
    refreshPatchState({ stateDir: PACKAGE_DIR, log: this.#host?.log });
    if (PATCH_STATE.restartPending) this.#scheduleRestart('刚补上补丁');
    return { ...PATCH_STATE, packageDir: PACKAGE_DIR };
  }

  /**
   * 按 `.coopanion-orig` 手动还原：把安装目录里的三份文件覆盖回更新下发的原样。
   *
   * 备份不删，所以这是可逆的（再点「重打补丁」或下次启动就会补回来）。
   * 还原后桌宠那一侧要重启才回到「没有发图功能」，但这里**不自动重启**
   * ——用户是主动撤销的，等他自己决定。
   */
  #restore() {
    const appRoot = PATCH_STATE.appRoot || resolveAppRoot([PACKAGE_DIR, process.cwd()]) || '';
    if (process.env.COOPANION_CHAT_IMAGE_PATCH === '0') {
      return {
        ...PATCH_STATE,
        packageDir: PACKAGE_DIR,
        restored: { at: new Date().toISOString(), restored: [], failed: [], skipped: 'COOPANION_CHAT_IMAGE_PATCH=0：这次不改安装目录。' },
      };
    }
    const res = restoreChatImagePatches(appRoot, { stateDir: PACKAGE_DIR, log: this.#host?.log });
    const at = new Date().toISOString();
    PATCH_STATE = {
      ...PATCH_STATE,
      at,
      appRoot: res.appRoot ?? appRoot,
      patched: [],
      failed: [],
      done: 0,
      total: res.results.length,
      stuck: false,
      restartPending: false,
      error: res.error ?? '',
      restored: {
        at,
        restored: res.restored,
        failed: res.failed,
        byFile: res.results
          .filter((r) => r.state === 'restored')
          .map((r) => ({ id: r.id, file: r.file, backup: r.backup })),
      },
    };
    this.#host?.log?.[res.failed.length ? 'warn' : 'info']?.(
      `图片工坊补丁:按备份还原了 ${res.restored.length} 个文件${res.failed.length ? `，失败:${res.failed.join(',')}` : ''}`,
    );
    return { ...PATCH_STATE, packageDir: PACKAGE_DIR };
  }

  /** 请控制台重启进程：桌宠那一侧的补丁要重启才装载。 */
  async #askRestart(reason) {
    const appRoot = PATCH_STATE.appRoot || resolveAppRoot([PACKAGE_DIR, process.cwd()]) || '';
    const port = consolePort({ appRoot, botDir: this.botDir });
    const stamp = new Date().toISOString();
    if (process.env.COOPANION_CHAT_IMAGE_PATCH === '0') {
      PATCH_STATE.restart = { at: stamp, port, status: 0, ok: false, reason, detail: 'COOPANION_CHAT_IMAGE_PATCH=0：检查模式下不发重启请求。' };
      return { ...PATCH_STATE, packageDir: PACKAGE_DIR };
    }
    try {
      const res = await requestConsoleRestart(port);
      const ok = res.status >= 200 && res.status < 300;
      PATCH_STATE.restart = { at: stamp, port, status: res.status, ok, reason, detail: '' };
      this.#host?.log?.[ok ? 'info' : 'warn']?.(`图片工坊补丁:重启请求 → ${res.status}(端口 ${port},${reason})`);
    } catch (err) {
      PATCH_STATE.restart = { at: stamp, port, status: 0, ok: false, reason, detail: msg(err) };
      this.#host?.log?.warn?.(`图片工坊补丁:重启请求没送到(端口 ${port}):${msg(err)}`);
    }
    return { ...PATCH_STATE, packageDir: PACKAGE_DIR };
  }

  /** 延迟几秒再请重启：等控制台自己的 web 服务起来。 */
  #scheduleRestart(reason) {
    if (this.#restartTimer) return;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#askRestart(reason);
    }, 4000);
    this.#restartTimer.unref?.();
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
    if (PATCH_STATE.error) this.#host?.log?.warn?.(`图片工坊补丁:${PATCH_STATE.error}`);
    if (PATCH_STATE.failed.length) {
      this.#host?.log?.warn?.(`图片工坊补丁:有 ${PATCH_STATE.failed.length} 处没打上(${PATCH_STATE.failed.map((f) => f.id).join(', ')}),桌宠发图可能不生效`);
    }
    if (PATCH_STATE.restartPending) this.#scheduleRestart('这次启动补上了新补丁');
  }

  async stop() {
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#streams.clear();
    this.#host = null;
  }
}

/**
 * 图片工坊的离线检查。
 *
 * 不联网、不装 DOM：用一份假 DOM 把 dist/webui.js 的两个面板真的挂起来跑，
 * 服务端那侧则直接调 ImageWorld 的工具与 WebUI 方法。
 *
 *   node tools/check.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = join(here, '..');

// 「对话页发图」的自愈补丁会在 import src/world.js 时跑；检查脚本不该改安装目录，
// 所以关掉它（补丁本身由 tools/patch.mjs 在副本上验证）。
process.env.COOPANION_CHAT_IMAGE_PATCH = '0';

let failures = 0;
let warnings = 0;

const section = (title) => console.log(`\n${title}`);
const pass = (label) => console.log(`  ok   ${label}`);
const fail = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
const warn = (label, detail = '') => {
  warnings += 1;
  console.log(`  warn ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail = '') => (cond ? pass(label) : fail(label, detail));

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 假 DOM：只实现两个面板真正用到的那点东西
// ---------------------------------------------------------------------------

function walk(el, out = []) {
  out.push(el);
  for (const kid of el.children ?? []) walk(kid, out);
  return out;
}

const findByText = (root, text) => walk(root).find((el) => el.textContent === text) ?? null;
const findAll = (root, pred) => walk(root).filter(pred);
const findClass = (root, cls) => walk(root).find((el) => String(el.className).split(/\s+/).includes(cls)) ?? null;
const findInputs = (root) => findAll(root, (el) => el.tagName === 'INPUT');

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }

  add(...names) {
    for (const name of names) this.set.add(name);
    this.el.className = [...this.set].join(' ');
  }

  remove(...names) {
    for (const name of names) this.set.delete(name);
    this.el.className = [...this.set].join(' ');
  }

  contains(name) {
    return this.set.has(name);
  }
}

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this.className = '';
    this.style = {};
    this.value = '';
    this.placeholder = '';
    this.alt = '';
    this.src = '';
    this.loading = '';
    this._text = '';
    this.listeners = new Map();
    this.__click = null;
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  get textContent() {
    return this._text;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...kids) {
    for (const kid of kids) this.appendChild(kid);
  }

  replaceChildren(...kids) {
    this.children = [];
    this._text = '';
    this.append(...kids);
  }

  querySelector(selector) {
    const hit = /\[data-id="([^"]+)"\]/.exec(selector);
    if (!hit) return null;
    return walk(this).find((el) => el.dataset?.id === hit[1]) ?? null;
  }

  scrollIntoView() {}

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click() {
    if (this.__click) this.__click({});
  }
}

function makeUi(state) {
  const h = (tag, cls, txt) => {
    const el = new FakeEl(tag);
    if (cls) el.className = cls;
    if (txt !== undefined && txt !== null) el.textContent = txt;
    return el;
  };

  const fmt = {
    count: (n) => String(n ?? 0),
    bytes: (n) => `${n ?? 0}B`,
    percent: (r) => `${Math.round((r ?? 0) * 100)}%`,
    clock: (ts) => String(ts ?? ''),
    money: (n) => String(n ?? 0),
    duration: (ms) => `${ms ?? 0}ms`,
  };

  return {
    fmt,
    h,
    esc: (s) => String(s),
    sheet: (opts) => {
      const el = h('div', 'sheet');
      el.appendChild(h('h3', null, opts.title));
      if (opts.desc) el.appendChild(h('div', 'sh-desc', opts.desc));
      const body = h('div', 'sheetbody');
      el.appendChild(body);
      return { el, body, note: h('div', 'note'), desc: null };
    },
    foldSheet: (id, opts) => ({ el: h('div', 'sheet'), body: h('div'), note: h('div'), desc: null }),
    rowbar: () => h('div', 'rowbar'),
    section: (title, desc) => {
      const el = h('div', 'section');
      el.appendChild(h('h4', null, title));
      if (desc) el.appendChild(h('div', 'sh-desc', desc));
      return el;
    },
    actions: () => h('div', 'actions'),
    button: (label, opts = {}) => {
      const el = h('button', 'btn', label);
      el.__click = opts.onClick ?? null;
      return el;
    },
    copyButton: (text, opts = {}) => {
      const el = h('button', 'btn', opts.label ?? 'copy');
      el.__copy = typeof text === 'function' ? text : () => String(text);
      return el;
    },
    pill: (text, tone = 'plain') => {
      const el = h('span', `pill ${tone}`, text);
      return el;
    },
    chip: (text, tone = 'plain') => h('span', `chip ${tone}`, text),
    msgline: (text = '', bad = false) => h('div', bad ? 'msgline bad' : 'msgline', text),
    placeholder: (text) => h('div', 'placeholder', text),
    input: (opts = {}) => {
      const el = h('input', opts.cls ?? '');
      el.tagName = 'INPUT';
      el.value = opts.value ?? '';
      el.placeholder = opts.placeholder ?? '';
      el.type = opts.type ?? 'text';
      return el;
    },
    select: (opts = {}) => h('select', opts.cls ?? ''),
    textarea: (opts = {}) => h('textarea', opts.cls ?? ''),
    checkbox: (label, opts = {}) => ({ el: h('label', 'check', label), input: h('input'), checked: !!opts.checked, setChecked() {} }),
    field: (label, control) => {
      const el = h('label', 'field');
      el.appendChild(h('span', null, label));
      el.appendChild(control);
      return el;
    },
    segmented: (items, opts = {}) => ({ el: h('div', 'segwrap'), value: opts.value ?? '', setValue() {} }),
    table: (opts = {}) => {
      const el = h('div', 'tablewrap');
      const body = h('tbody');
      el.appendChild(body);
      const addRow = (cells) => {
        const tr = h('tr');
        for (const cell of cells) {
          const td = h('td');
          if (cell && typeof cell === 'object' && cell.el) td.appendChild(cell.el);
          else td.textContent = String(cell?.text ?? cell ?? '');
          tr.appendChild(td);
        }
        body.appendChild(tr);
        return tr;
      };
      return { el, body, addRow, clear: (empty) => { body.replaceChildren(); if (empty) addRow([empty]); } };
    },
    kv: (rows) => {
      const el = h('table', 'kv');
      el.__rows = rows;
      for (const row of rows) {
        const tr = h('tr');
        tr.appendChild(h('td', 'k', row.k));
        const td = h('td', 'v');
        if (row.v && typeof row.v === 'object' && row.v.tagName) td.appendChild(row.v);
        else td.textContent = String(row.v ?? '');
        tr.appendChild(td);
        el.appendChild(tr);
      }
      return el;
    },
    log: (opts = {}) => ({ el: h('div', 'logview'), append: (line) => h('div', 'logline', line), clear() {}, count: 0, stuck: true, scrollToEnd() {} }),
    stat: (item) => {
      const el = h('div', 'stat');
      el.__stat = item;
      el.appendChild(h('div', 'k', item.k));
      const v = h('div', 'v');
      if (item.v && typeof item.v === 'object' && item.v.tagName) v.appendChild(item.v);
      else v.textContent = String(item.v ?? '');
      el.appendChild(v);
      return el;
    },
    statgrid: () => h('div', 'statgrid'),
    progress: (opts = {}) => ({ el: h('div', 'progress'), value: opts.value ?? 0, max: opts.max ?? 1, setValue() {}, setLabel() {} }),
    toast: (text, tone = 'ok') => {
      state.toasts.push({ text, tone });
      return { dispose() {} };
    },
    confirm: (opts) => {
      state.confirms.push(opts);
      return Promise.resolve(state.confirmAnswer);
    },
    drawer: (title, body) => {
      state.drawers.push({ title, body });
      return { dispose() {} };
    },
    busy: (title, text) => {
      state.busy.push({ title, text });
      return { dispose() {} };
    },
    disable: () => ({ dispose() {} }),
  };
}

function makeEnv(world, panelId, options = {}) {
  const state = {
    toasts: [],
    drawers: [],
    busy: [],
    confirms: [],
    confirmAnswer: options.confirmAnswer !== false,
  };
  const root = new FakeEl('div');
  const streams = [];
  const ctx = {
    pageId: 'world:image',
    panelId,
    language: options.language ?? 'zh',
    root,
    signal: new AbortController().signal,
    invoke: (method, args) => world.invoke(panelId, method, args),
    invokeBinary: async (method, args) => {
      const res = await world.invoke(panelId, method, args);
      if (!res || typeof res !== 'object' || !res.$file) throw new Error('不是二进制结果');
      const bytes = readFileSync(res.$file.path);
      return new Blob([bytes], { type: res.$file.mime });
    },
    pickPath: async () => null,
    setConfig: async () => '',
    stream: (handlers) => {
      const handle = { send() {}, open: true, dispose() {} };
      streams.push({ handlers, handle });
      return handle;
    },
    interval: () => ({ dispose() {} }),
    timeout: () => ({ dispose() {} }),
    frame: () => ({ dispose() {} }),
    own: (d) => d,
    memo: { get: (_k, fallback) => fallback, set() {} },
    guardLeave: () => ({ dispose() {} }),
    scope: {},
    mountSlot: async () => ({ dispose() {} }),
    ui: makeUi(state),
    refresh: async () => {},
  };
  return { ctx, root, state, streams };
}

// ---------------------------------------------------------------------------
// 开始
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'image-check-'));
const botDir = join(work, 'bot');
const dataDir = join(work, 'data');
mkdirSync(botDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

/** 仿框架：storeSecret 写进 .env，secret() 立刻能从环境里读到。 */
const envStore = new Map();
let stored = null;

try {
  const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
  const definition = mod.default;

  section('模块形状');
  check(definition && typeof definition === 'object', 'index.js 默认导出 WorldDefinition');
  check(definition?.id === 'image', 'id 是 image', String(definition?.id));
  check(typeof definition?.label === 'string' && definition.label !== '', 'label 非空', String(definition?.label));
  check(mod.imageDefinition === definition, '具名导出 imageDefinition 与默认导出一致');

  section('defaults / create（对齐 dry-mount）');
  const defaults = definition.defaults();
  check(Object.getPrototypeOf(defaults) === Object.prototype, 'defaults() 是普通对象');
  check(defaults.enabled === false, 'defaults().enabled === false');

  let world = null;
  try {
    world = definition.create({
      cfg: definition.defaults(),
      dataDir,
      botDir,
      packageDir: pkgDir,
      secret: (name) => envStore.get(name) ?? '',
      storeSecret: (name, value) => {
        envStore.set(name, value);
        stored = { name, value };
      },
    });
    pass('默认配置 + 空密钥下 create() 不抛');
  } catch (err) {
    fail('create() 在默认配置下抛错', String(err && err.message));
  }

  if (!world) throw new Error('没有 World 可继续检查');

  check(world.id === definition.id, 'world.id 与 def.id 一致');
  check(typeof world.envPromptVars === 'function', '有 envPromptVars()');
  check(typeof world.tools === 'function', '有 tools()');
  check(typeof world.webUi === 'function', '有 webUi()');

  section('工具声明');
  const tools = world.tools();
  check(Array.isArray(tools), 'tools() 返回数组');
  const names = tools.map((t) => t.name);
  check(new Set(names).size === names.length, '工具名不重复', names.join(','));
  for (const tool of tools) {
    const where = `工具 ${tool.name}`;
    check(typeof tool.name === 'string' && tool.name !== '', `${where} 有 name`);
    check(/^[a-z0-9]+_/.test(tool.name), `${where} name 匹配工具前缀`, tool.name);
    check(tool.parameters && typeof tool.parameters === 'object', `${where} parameters 是对象`);
    check(typeof tool.handler === 'function', `${where} handler 是函数`);
    check(Array.isArray(tool.tags) && tool.tags.length > 0, `${where} tags 非空`, JSON.stringify(tool.tags));
    check(typeof tool.description === 'string' && tool.description.length > 10, `${where} 有描述`);
  }
  check(tools.length === 4, '工具数量是 4', String(tools.length));

  section('提示词变量');
  const vars = world.envPromptVars();
  check(vars && typeof vars === 'object', 'envPromptVars() 返回对象');
  check(isAbsolute(String(vars?.['image.dir'] ?? '')), 'image.dir 是绝对路径', String(vars?.['image.dir']));
  check(typeof vars?.['image.ready'] === 'string' && vars['image.ready'] !== '', 'image.ready 非空', String(vars?.['image.ready']));

  section('WebUI 声明（对齐 dry-mount）');
  const declined = world.webUi('zh');
  check(declined && typeof declined === 'object', 'webUi() 返回对象');
  check(typeof declined.invoke === 'function', 'webUi().invoke 是函数');
  check(typeof declined.stream === 'function', 'webUi().stream 是函数');
  const panelIds = (declined.panels ?? []).map((p) => p.id);
  check(panelIds.length > 0, '声明了面板');
  check(panelIds.every((id) => /^[a-z0-9-]+$/.test(id)), '面板 id 合法', panelIds.join(','));
  check(new Set(panelIds).size === panelIds.length, '面板 id 不重复');
  check(panelIds.includes('gallery') && panelIds.includes('status'), 'gallery 与 status 都声明了', panelIds.join(','));
  for (const group of declined.config ?? []) {
    check(group.owner === 'world:image', '配置组 owner 是 world:image', String(group.owner));
    const props = group.schema?.properties ?? {};
    for (const key of Object.keys(props)) {
      if (!key.startsWith('worlds.image.')) {
        fail('配置路径不在 worlds.image. 段里', key);
        continue;
      }
      const leaf = key.slice('worlds.image.'.length);
      if (defaults[leaf] === undefined) fail('配置路径在 defaults 里没有默认值', key);
    }
    const declared = Object.keys(props).map((k) => k.slice('worlds.image.'.length));
    for (const key of Object.keys(defaults)) {
      if (!declared.includes(key)) warn('defaults 里的键没有对应的配置字段', key);
    }
    pass(`配置组 ${group.id}：${declared.length} 个字段全部落在段内且有默认值`);
  }
  const docKeys = (declined.promptDocs ?? []).map((d) => d.key);
  check(new Set(docKeys).size === docKeys.length, 'promptDocs key 不重复');
  for (const doc of declined.promptDocs ?? []) {
    if (doc.role === 'envPrompt') check(existsSync(doc.path), `环境提示词模板存在（${doc.key}）`, String(doc.path));
  }
  check(Array.isArray(declined.lamps) && declined.lamps.length > 0, 'lamps 非空');
  check(Array.isArray(declined.badges) && declined.badges.length > 0, 'badges 非空');

  section('工具回执');
  const draw = tools.find((t) => t.name === 'image_draw');
  const noKey = await draw.handler({ prompt: '一只鲸鱼' });
  check(noKey && noKey.failed === true, '没配密钥时 image_draw 失败得明明白白', JSON.stringify(noKey).slice(0, 120));
  check(String(noKey.text).includes('IMAGE_API_KEY'), '失败文案点名了密钥变量', String(noKey.text));
  const noPrompt = await draw.handler({});
  check(noPrompt && noPrompt.failed === true, '空 prompt 直接拒绝');
  const edit = tools.find((t) => t.name === 'image_edit');
  const noImage = await edit.handler({ prompt: '改一下', image: join(work, '并不存在.png') });
  check(noImage && noImage.failed === true, '找不到源图时 image_edit 失败');
  const galleryTool = tools.find((t) => t.name === 'image_gallery');
  const emptyList = await galleryTool.handler({});
  check(typeof emptyList === 'string' && emptyList.includes('空'), '空列表给一句话而不是报错', emptyList);
  const showMissing = await tools.find((t) => t.name === 'image_show').handler({ id: 'deadbeef' });
  check(showMissing && showMissing.failed === true, 'image_show 找不到编号时失败');

  section('改图请求的两种走法（stub fetch）');
  const api = await import(pathToFileURL(join(pkgDir, 'src', 'api.js')).href);
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  const tinyB64 = tinyPng.toString('base64');
  const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  /** 按 path 后缀分发的 fetch 替身；返回记下每次调用的 calls 数组。 */
  const stubFetch = (routes) => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const call = { url: String(url), init };
      calls.push(call);
      const path = new URL(String(url)).pathname;
      for (const [suffix, handler] of routes) {
        if (path.endsWith(suffix)) return await handler(call);
      }
      return new Response('not found', { status: 404 });
    };
    return calls;
  };
  const realFetch = globalThis.fetch;
  const editOpts = {
    baseUrl: 'https://img.example.test/v1',
    apiKey: 'sk-x',
    model: 'gpt-image-1',
    prompt: '把它改成水彩',
    image: tinyPng,
    mime: 'image/png',
    name: 'src.png',
  };
  try {
    // 1. 端点有 /images/edits：multipart 一次就够，不碰 generations。
    let calls = stubFetch([['/images/edits', () => jsonResponse({ data: [{ b64_json: tinyB64 }] })]]);
    let out = await api.editImage(editOpts);
    check(calls.length === 1 && calls[0].url.endsWith('/images/edits'), '/images/edits 能走通时只发一次 multipart', calls.map((c) => c.url).join(' '));
    check(calls[0].init.body instanceof FormData && calls[0].init.body.get('prompt') === '把它改成水彩', 'multipart 里带着 prompt');
    check(out.bytes.equals(tinyPng) && out.mime === 'image/png', 'multipart 的图正常取回');

    // 2. 端点没有 /images/edits（阿里云百炼：404）：退回 generations 的 image 字段。
    calls = stubFetch([
      ['/images/edits', () => jsonResponse({ error: { message: 'not found' } }, 404)],
      ['/images/generations', () => jsonResponse({ data: [{ b64_json: tinyB64 }] })],
    ]);
    out = await api.editImage(editOpts);
    check(calls.length === 2 && calls[1].url.endsWith('/images/generations'), '404 后退回 /images/generations', calls.map((c) => c.url).join(' '));
    const fallbackBody = JSON.parse(String(calls[1].init.body));
    check(fallbackBody.image === `data:image/png;base64,${tinyB64}`, '原图编成 data URI 塞进 image 字段', String(fallbackBody.image).slice(0, 40));
    check(fallbackBody.prompt === '把它改成水彩' && fallbackBody.model === 'gpt-image-1' && fallbackBody.n === 1, '退路请求体带着 model / prompt / n');
    check(calls[1].init.headers.Authorization === 'Bearer sk-x', '退路也带着密钥');
    check(out.bytes.equals(tinyPng), '退路的图正常取回');

    // 2b. 405（没有这条方法）同样算「没这条路由」。
    calls = stubFetch([
      ['/images/edits', () => jsonResponse({ error: { message: 'method not allowed' } }, 405)],
      ['/images/generations', () => jsonResponse({ data: [{ b64_json: tinyB64 }] })],
    ]);
    out = await api.editImage(editOpts);
    check(calls.length === 2 && out.bytes.equals(tinyPng), '405 也退回 /images/generations');

    // 3. 端点报别的错（500）：不试退路，原样抛。
    calls = stubFetch([['/images/edits', () => jsonResponse({ error: { message: 'boom' } }, 500)]]);
    let caught = null;
    try {
      await api.editImage(editOpts);
    } catch (err) {
      caught = err;
    }
    check(caught instanceof api.ImageApiError && caught.status === 500, '500 不会被当成「没这条路由」', String(caught?.status));
    check(calls.length === 1 && !calls.some((c) => c.url.endsWith('/images/generations')), '500 不触发退路');

    // 4. 两条路都失败：错误里交代清楚先试了什么。
    calls = stubFetch([
      ['/images/edits', () => jsonResponse({ error: { message: 'not found' } }, 404)],
      ['/images/generations', () => jsonResponse({ error: { message: 'model not exist' } }, 400)],
    ]);
    caught = null;
    try {
      await api.editImage(editOpts);
    } catch (err) {
      caught = err;
    }
    check(String(caught?.message).includes('model not exist') && String(caught?.message).includes('/images/edits'), '退路也失败时错误里带两条线索', String(caught?.message).slice(0, 120));

    // 5. 画图那条路不带 image，别把文生图带歪。
    calls = stubFetch([['/images/generations', () => jsonResponse({ data: [{ b64_json: tinyB64 }] })]]);
    await api.generateImage({ ...editOpts, image: undefined });
    check(!('image' in JSON.parse(String(calls[0].init.body))), 'image_draw 的请求体里没有 image 字段');
  } finally {
    globalThis.fetch = realFetch;
  }

  section('离线自检样图（落盘 → 索引 → 取图）');
  const self = await world.invoke('gallery', 'selftest', []);
  check(self?.ok === true && self.item?.id, 'selftest 返回条目');
  check(existsSync(self.item.path), '图片真的落盘了', String(self.item?.path));
  const bytes = readFileSync(self.item.path);
  check(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 魔术字节正确');
  const ihdrWidth = bytes.readUInt32BE(16);
  const ihdrHeight = bytes.readUInt32BE(20);
  check(ihdrWidth === 768 && ihdrHeight === 480, 'IHDR 里的尺寸是 768x480', `${ihdrWidth}x${ihdrHeight}`);
  let inflated = null;
  try {
    const idatStart = bytes.indexOf(Buffer.from('IDAT')) + 4;
    inflated = inflateSync(bytes.subarray(idatStart, bytes.length - 12));
  } catch (err) {
    fail('IDAT 解不开', String(err && err.message));
  }
  check(inflated !== null && inflated.length >= 480 * (1 + 768 * 4), '像素数据能解出来', String(inflated?.length));
  check(existsSync(join(world.dir(), 'index.json')), '索引写在了图片目录里', join(world.dir(), 'index.json'));

  const listed = await world.invoke('gallery', 'list', [10]);
  check(listed?.count === 1 && listed.items?.length === 1, '作品列表里有这一张');
  check(listed.items[0].path === self.item.path, '列表里的路径与落盘一致');
  check(listed.items[0].bytes === bytes.length, '列表里的字节数与文件一致');

  const blobResult = await world.invoke('gallery', 'blob', [self.item.id]);
  check(blobResult?.$file && isAbsolute(blobResult.$file.path), 'blob 方法返回 $file 结果');
  check(blobResult.$file.bytes === bytes.length, '$file.bytes 与文件大小一致', `${blobResult.$file?.bytes} vs ${bytes.length}`);
  check(
    blobResult.$file.sha256 === createHash('sha256').update(bytes).digest('hex'),
    '$file.sha256 与文件内容一致',
  );
  check(/^[0-9a-f]{64}$/.test(blobResult.$file.sha256), 'sha256 是 64 位小写十六进制');

  const state = await world.invoke('status', 'state', []);
  check(state.count === 1 && state.totalBytes === bytes.length, '状态页读数跟着索引走');
  check(state.dir === world.dir(), '状态页目录与 world.dir() 一致');
  check(state.keySet === false, '空密钥时报未配置');

  section('密钥写入');
  await world.invoke('status', 'setKey', ['sk-check-123']);
  check(stored?.name === 'IMAGE_API_KEY' && stored?.value === 'sk-check-123', 'setKey 走 storeSecret', JSON.stringify(stored));
  const afterKey = await world.invoke('status', 'state', []);
  check(afterKey.keySet === true, '填完密钥后状态页变已配置');
  await world.invoke('status', 'clearKey', []);
  check(stored?.value === '', 'clearKey 把值写空');

  section('浏览器面板 bundle');
  const webUiSrc = readFileSync(join(pkgDir, 'dist', 'webui.js'), 'utf8');
  const bundle = (await import(pathToFileURL(join(pkgDir, 'dist', 'webui.js')).href)).default;
  check(!!bundle?.panels?.gallery?.mount, 'bundle 提供 gallery.mount');
  check(!!bundle?.panels?.status?.mount, 'bundle 提供 status.mount');
  const declaredIds = panelIds.slice().sort().join(',');
  const bundleIds = Object.keys(bundle?.panels ?? {}).sort().join(',');
  check(declaredIds === bundleIds, '面板 id 与服务端声明一致', `${declaredIds} vs ${bundleIds}`);

  section('文案完整性');
  const dictKeys = (name) => {
    const start = webUiSrc.indexOf(`const ${name} = {`);
    const end = webUiSrc.indexOf('\n};', start);
    const body = webUiSrc.slice(start, end);
    return new Set([...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
  };
  const zhKeys = dictKeys('ZH');
  const enKeys = dictKeys('EN');
  const usedKeys = new Set([...webUiSrc.matchAll(/\btx\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  for (const key of usedKeys) {
    if (!zhKeys.has(key)) fail('中文文案缺键', `tx.${key}`);
    if (!enKeys.has(key)) fail('英文文案缺键', `tx.${key}`);
  }
  for (const key of zhKeys) if (!enKeys.has(key)) fail('中文有、英文没有的键', key);
  for (const key of enKeys) if (!zhKeys.has(key)) fail('英文有、中文没有的键', key);
  pass(`文案键：中文 ${zhKeys.size}、英文 ${enKeys.size}，代码用到 ${usedKeys.size}`);

  section('契约与自描述（框架 0.2）');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const manifest = pkg.cortico ?? {};
  check(/^0\.2\.\d+$/.test(pkg.version), 'version 在 0.2.x 线上', String(pkg.version));
  check(manifest.api === 6, 'cortico.api 是 6', String(manifest.api));
  check(manifest.webUiClient === 'dist/webui.js', 'webUiClient 指向 dist/webui.js', String(manifest.webUiClient));
  check(manifest.describe === 'describe.json', 'describe 指向 describe.json', String(manifest.describe));
  for (const need of ['dist', 'describe.json']) {
    check((pkg.files ?? []).includes(need), `files 带上 ${need}`);
  }
  check(existsSync(join(pkgDir, 'dist', 'webui.js')), 'dist/webui.js 在包里');
  check(!existsSync(join(pkgDir, 'dist', 'console.js')), '旧的 dist/console.js 已经清掉');
  check(/export default/.test(webUiSrc), '面板脚本有 export default');
  check(!/^\s*import\s/m.test(webUiSrc), '面板脚本不 import 任何东西');
  check(/\bctx\.ui\./.test(webUiSrc) && /\bctx\.invoke\(/.test(webUiSrc), '面板只用 ctx.ui / ctx.invoke');

  const describeDecl = definition.describe;
  check(!!describeDecl, 'definition 带上 describe');
  check(Array.isArray(describeDecl?.tools), 'describe.tools 是数组');
  check(Array.isArray(describeDecl?.events), 'describe.events 是数组');
  const descToolNames = (describeDecl?.tools ?? []).map((t) => t.name);
  check(
    descToolNames.join(',') === names.slice().join(','),
    'describe 里的工具名与 tools() 完全一致',
    `${descToolNames.join(',')} vs ${names.join(',')}`,
  );

  const describePath = manifest.describe ?? 'describe.json';
  let describeFile = null;
  try {
    describeFile = JSON.parse(readFileSync(join(pkgDir, describePath), 'utf8'));
    pass(`${describePath} 是合法 JSON`);
  } catch (err) {
    fail(`${describePath} 读不了或不是合法 JSON`, String(err?.message ?? err));
  }
  if (describeFile) {
    const fileToolNames = (describeFile.tools ?? []).map((t) => t.name);
    check(
      fileToolNames.join(',') === names.slice().join(','),
      'describe.json 里的工具名与定义一致',
      `${fileToolNames.join(',')} vs ${names.join(',')}`,
    );
    check((describeFile.events ?? []).length === (describeDecl?.events ?? []).length, 'describe.json 的事件条数与定义一致');
    const envPrompt = (describeFile.prompts ?? []).find((p) => p.role === 'envPrompt');
    check(!!envPrompt, 'describe.json 带上 envPrompt 角色');
    check(/image_draw/.test(envPrompt?.content ?? ''), 'envPrompt 正文里有工具说明');
  }

  section('作品页挂载');
  const gallery = makeEnv(world, 'gallery');
  bundle.panels.gallery.mount(gallery.ctx);
  await tick(20);
  let grid = findClass(gallery.root, 'iw-grid');
  check(!!grid, '画出了作品网格');
  check(grid.children.length === 1, '网格里有一张卡片', String(grid?.children.length));
  const firstCard = grid.children[0];
  const thumb = firstCard.children[0];
  check(typeof URL.createObjectURL === 'function' ? String(thumb.src).startsWith('blob:') : true, '缩略图挂上了 blob URL', String(thumb.src).slice(0, 24));
  const statgrid = findClass(gallery.root, 'statgrid');
  check(statgrid.children.length === 3, '读数格子有三个', String(statgrid?.children.length));
  check(!!gallery.streams.length, '订阅了推送通道');

  const stream = gallery.streams[0];
  stream.handlers.open?.();
  stream.handlers.message('这不是 JSON');
  stream.handlers.message(JSON.stringify({ t: 'error', message: '接口 500' }));
  check(gallery.state.toasts.some((t) => t.text.includes('接口 500')), '推送里的错误变成了提示');
  check(gallery.state.toasts.some((t) => t.tone === 'bad'), '错误提示走警示色');

  const selfBtn = findByText(gallery.root, '插入自检样图');
  check(!!selfBtn, '有「插入自检样图」按钮');
  selfBtn.click();
  await tick(30);
  check(grid.children.length === 2, '自检样图插进来了', String(grid.children.length));

  const removeBtn = findByText(gallery.root, '删除');
  check(!!removeBtn, '卡片上有删除按钮');
  gallery.state.confirmAnswer = false;
  removeBtn.click();
  await tick(20);
  check(grid.children.length === 2, '确认框点「否」就不删', String(grid.children.length));
  gallery.state.confirmAnswer = true;
  removeBtn.click();
  await tick(30);
  check(grid.children.length === 1, '确认后删掉一张', String(grid.children.length));

  const clearBtn = findByText(gallery.root, '清空作品');
  check(!!clearBtn, '有「清空作品」按钮');
  clearBtn.click();
  await tick(30);
  check(grid.children.length === 1 && String(grid.children[0].className).includes('iw-empty'), '清空后回到空态');
  const emptyState = await world.invoke('gallery', 'list', [10]);
  check(emptyState.count === 0, '清空后索引也空了', String(emptyState.count));

  findByText(gallery.root, '插入自检样图').click();
  await tick(30);
  const big = findByText(gallery.root, '看大图');
  check(!!big, '新画的那张又有「看大图」');
  big.click();
  await tick(20);
  check(gallery.state.drawers.length === 1, '看大图打开了抽屉', String(gallery.state.drawers.length));
  check(String(gallery.state.drawers[0].title).length > 0, '抽屉有标题');

  section('状态页挂载');
  const status = makeEnv(world, 'status');
  bundle.panels.status.mount(status.ctx);
  await tick(20);
  const kvBoxes = findAll(status.root, (el) => String(el.className).split(/\s+/).includes('kv'));
  check(kvBoxes.length >= 1 && kvBoxes.every((el) => Array.isArray(el.__rows)), '状态页画出了键值表', String(kvBoxes.length));
  const rowKeys = kvBoxes.flatMap((el) => (el.__rows ?? []).map((r) => r.k));
  check(rowKeys.includes('目录'), '列出了目录', rowKeys.join(','));
  check(rowKeys.includes('接口地址'), '列出了接口地址');
  check(rowKeys.includes('最近错误'), '列出了最近错误');
  const inputs = findInputs(status.root);
  check(inputs.length === 1 && inputs[0].type === 'password', '有且只有一个密码输入框', `${inputs.length}`);
  inputs[0].value = 'sk-typed-in-panel';
  findByText(status.root, '保存密钥').click();
  await tick(20);
  check(stored?.value === 'sk-typed-in-panel', '面板保存把密钥交给 storeSecret', JSON.stringify(stored));
  check(status.state.toasts.some((t) => t.text.includes('已保存')), '保存后有提示');
  check(inputs[0].value === '', '保存后输入框清空');
  status.state.confirmAnswer = true;
  findByText(status.root, '清除密钥').click();
  await tick(20);
  check(stored?.value === '', '面板清除把密钥写空');

  const patchRows = (findClass(status.root, 'kv')?.__rows ?? []).map((r) => r.k);
  check(patchRows.includes('安装目录'), '状态页有补丁那一段', patchRows.join(','));
  check(!!findByText(status.root, '重打补丁'), '状态页有「重打补丁」按钮');
  check(!!findByText(status.root, '重启控制台'), '状态页有「重启控制台」按钮');
  findByText(status.root, '重打补丁').click();
  await tick(20);
  check(status.state.toasts.some((t) => t.text.includes('又对了一遍')), '重打补丁有回执', JSON.stringify(status.state.toasts.map((t) => t.text)));
  findByText(status.root, '重启控制台').click();
  await tick(20);
  check(status.state.toasts.some((t) => t.text.includes('没送到') || t.text.includes('检查模式')), '检查模式下点重启只是提示，不会真重启');

  section('对话页发图补丁（纯逻辑）');
  const patchMod = await import(pathToFileURL(join(pkgDir, 'src', 'chat-image-patch.js')).href);
  for (const name of ['resolveAppRoot', 'patchSpecs', 'rulesFor', 'applyChatImagePatches', 'patchBackupStatus', 'restoreChatImagePatches', 'consolePort', 'requestConsoleRestart']) {
    check(typeof patchMod[name] === 'function', `导出 ${name}()`);
  }
  const specs = patchMod.patchSpecs('X:/not-a-real-app');
  const specIds = specs.map((s) => s.id);
  check(specIds.length === 9, '补丁一共 9 处（5 处打 world.ts + 2 处打 definition.ts + 2 处可选的 QQ 扩展）', String(specIds.length));
  check(new Set(specIds).size === specIds.length, '补丁 id 不重复', specIds.join(','));
  const wantIds = ['pet-fs-import', 'pet-path-import', 'pet-show-image-tool', 'pet-workspace-option', 'pet-workspace-relpaths', 'pet-workspace-wire', 'pet-show-image-describe', 'qq-image-relpaths', 'qq-image-hints'];
  check(wantIds.every((id) => specIds.includes(id)), '9 处补丁 id 齐全', specIds.join(','));
  check(specIds.every((id) => wantIds.includes(id)), '没有多余的补丁 id', specIds.join(','));
  // 防回归：框架 0.1.23 起原生就能把 say 的图发到对话页（chat.ts 的 wireImages() + 客户端 chat-thumb 缩略图），
  // 这 4 处补丁已经删掉，不许再回来（锚点早就不匹配，留着只会每次启动都记一条失败）。
  for (const gone of ['client-say-images', 'pet-say-images', 'pet-record-blobs', 'pet-say-type']) {
    check(!specIds.includes(gone), `补丁 ${gone} 已删掉（框架原生已覆盖），不许再出现`, specIds.join(','));
  }
  for (const spec of specs) check(typeof spec.what === 'string' && spec.what.length > 4, `补丁 ${spec.id} 有说明`, spec.what);
  const qqSpecs = specs.filter((s) => s.id.startsWith('qq-'));
  check(qqSpecs.length === 2 && qqSpecs.every((s) => s.optional === true), 'QQ 扩展那两处是可选补丁（没装就不算失败）', JSON.stringify(qqSpecs.map((s) => ({ id: s.id, optional: s.optional }))));
  check(qqSpecs.every((s) => s.file.includes('data') && s.file.includes('cortico-world-qq-better-alont1') && s.file.endsWith('world.ts')), 'QQ 补丁落在 <安装>/data/extensions/…/src/world.ts', JSON.stringify(qqSpecs.map((s) => s.file)));
  const qqRules = patchMod.rulesFor('qq-image-relpaths');
  check(typeof qqRules?.done === 'function' && typeof qqRules?.apply === 'function', 'QQ 补丁有 done/apply');
  const qqStranger = qqRules.apply('export const nope = 1;\n');
  check(Boolean(qqStranger?.error), 'QQ 扩展换了写法就报失败，不瞎改', JSON.stringify(qqStranger));
  const qqPatched = qqRules.apply([
    "import { existsSync } from 'node:fs';",
    "import { isAbsolute, join } from 'node:path';",
    'export class QQWorld implements World {',
    "  private packageDir = '.';",
    '  private config = { memoryDir: "ws" };',
    '  view(url: string) {',
    "    const p = isAbsolute(url) ? url : join(this.packageDir || '.', url);",
    '    return p;',
    '  }',
    '  send(image: string) {',
    "    const p = isAbsolute(image) ? image : join(this.packageDir || '.', image);",
    '    return p;',
    '  }',
    '}',
    '',
  ].join('\n'));
  check(!qqPatched?.error && qqPatched.text.includes('function resolveLocalImagePath('), 'QQ 补丁插进按工作区解析的助手', qqPatched?.error ?? '');
  check(!qqPatched?.error && qqPatched.text.includes('resolveLocalImagePath(image, this.config.memoryDir, this.packageDir)'), '发图那行改成按桌宠工作区解析');
  check(!qqPatched?.error && qqPatched.text.includes('resolveLocalImagePath(url, this.config.memoryDir, this.packageDir)'), '看图那行改成按桌宠工作区解析');
  check(qqRules.done(qqPatched?.text ?? ''), '改完认成「已打过」（幂等）');
  check(qqPatched.text.includes("import { existsSync } from 'node:fs';"), '导入本来就够时不多改一行');

  // 上游爱改工具说明的措辞（0.1.16 就把 image 那句换成了「如 /home/user/pics/a.png」）：
  // 一条对不上不该让整条补丁失败；但一句都认不出来仍然要报。
  const hintRules = patchMod.rulesFor('qq-image-hints');
  check(typeof hintRules?.done === 'function' && typeof hintRules?.apply === 'function', 'QQ 说明补丁有 done/apply');
  const hintFixture = [
    "  parameters: [{ name: 'url', description: '可选：直接给图片链接（事件里带的图）或本地文件路径；给了就不再翻缓冲。' }],",
    "  description: '给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。',",
    "  parameters: [{ name: 'image', description: '本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。' }],",
    '',
  ].join('\n');
  check(!hintRules.done(hintFixture), '夹具还是「只认绝对路径」的说明（有东西可改）');
  const hinted = hintRules.apply(hintFixture);
  check(!hinted?.error, '上游换了说明措辞也照改，不报失败', String(hinted?.error ?? 'ok'));
  check((hinted?.text ?? '').includes('或本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）；给了就不再翻缓冲。'), '认得出的那两处照改');
  check(!(hinted?.text ?? '').includes('相对扩展目录'), '旧说法不再残留在说明里');
  check(hintRules.done(hinted?.text ?? ''), '改完认成「已打过」（幂等）');
  const reworded = hintFixture.replace("'本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。'", "'图片本地路径或链接。'");
  const rewordedOut = hintRules.apply(reworded);
  check(!rewordedOut?.error && hintRules.done(rewordedOut?.text ?? ''), '上游整句换掉时跳过那一处，不算失败也不算没打', String(rewordedOut?.error ?? 'ok'));
  check(Boolean(hintRules.apply('export const nope = 1;\n')?.error), '一句都认不出来时仍然报失败');
  check(!hintRules.done('export const nope = 1;\n'), '文件整个换了写法时不谎报「已打过」');

  // pet_show_image 也要能认相对路径（按桌宠工作区解析）。
  const petSpecs = specs.filter((s) => s.id.startsWith('pet-workspace-'));
  check(petSpecs.length === 3 && petSpecs.every((s) => s.optional !== true), '桌宠工作区相对路径那 3 处是必备补丁', JSON.stringify(petSpecs.map((s) => s.id)));
  check(petSpecs.filter((s) => s.id !== 'pet-workspace-wire').every((s) => s.file.endsWith('world.ts')) && petSpecs.find((s) => s.id === 'pet-workspace-wire').file.endsWith('definition.ts'), '前两处打 world.ts、接线那处打 definition.ts', JSON.stringify(petSpecs.map((s) => `${s.id}:${s.file.endsWith('definition.ts') ? 'definition.ts' : 'world.ts'}`)));
  const petFixture = [
    "import { existsSync } from 'node:fs';",
    "import { isAbsolute, join } from 'node:path';",
    'export interface DesktopPetWorldOptions {',
    '  avatarFile?: string;',
    '  controls?: unknown;',
    '}',
    'export class DesktopPetWorld {',
    '  private opts: DesktopPetWorldOptions = {};',
    '  showImage(args: { path?: string }) {',
    "    const raw = typeof args.path === 'string' ? args.path.trim() : '';",
    "    if (!raw) return { text: '[pet_show_image 没执行] 要给图片的完整路径。', failed: true };",
    "    if (!isAbsolute(raw)) return { text: '[pet_show_image 没执行] 需要完整路径(例如 C:\\\\Users\\\\...\\\\pic.png)。', failed: true };",
    "    const caption = typeof args.caption === 'string' ? args.caption.trim() : '';",
    "    if (!/\\\\.(png|jpe?g|gif|webp)$/i.test(raw)) return { text: '不是图片', failed: true };",
    "    description: '图片文件的完整路径。',",
    '    return { raw, caption };',
    '  }',
    '}',
    '',
  ].join('\n');
  const fixtureDone = 'raw = join(ws, raw);';
  check(!petFixture.includes(fixtureDone), '夹具本身就是「只认绝对路径」的原文（自测有东西可改）');
  const petOpt = patchMod.rulesFor('pet-workspace-option');
  check(typeof petOpt?.done === 'function' && typeof petOpt?.apply === 'function', 'pet-workspace-option 有 done/apply');
  check(Boolean(petOpt.apply('export const nope = 1;\n')?.error), '桌宠世界选项换了写法就报失败，不瞎改');
  const optPatched = petOpt.apply(petFixture);
  check(!optPatched?.error && optPatched.text.includes('workspaceDir?: () => string;') && optPatched.text.includes('avatarFile?: string;'), '世界选项里补上 workspaceDir（原字段不动）', optPatched?.error ?? '');
  check(petOpt.done(optPatched?.text ?? ''), '补完认成「已打过」（幂等）');
  const petRel = patchMod.rulesFor('pet-workspace-relpaths');
  check(Boolean(petRel.apply('export const nope = 1;\n')?.error), 'pet_show_image 换了写法就报失败，不瞎改');
  const relPatched = petRel.apply(petFixture);
  check(!relPatched?.error && relPatched.text.includes('    let raw = typeof args.path'), '路径那行改成 let（const 拼不上）', relPatched?.error ?? '');
  check(!relPatched?.error && relPatched.text.includes("const ws = (this.opts.workspaceDir?.() ?? '').trim();") && relPatched.text.includes('      raw = join(ws, raw);'), '相对路径拼到桌宠工作区上', relPatched?.error ?? '');
  check(!relPatched?.error && relPatched.text.includes("相对路径没有工作区可拼") && !relPatched.text.includes('需要完整路径(例如'), '没给工作区时仍报错，但换成「没有工作区可拼」');
  check(!relPatched?.error && relPatched.text.includes("description: '图片路径:绝对路径,或相对桌宠工作区的路径(例如 blobs/xx.jpg)。'"), '工具说明改成「绝对路径或相对工作区」');
  check(petRel.done(relPatched?.text ?? ''), '改完认成「已打过」（幂等）');
  const petWire = patchMod.rulesFor('pet-workspace-wire');
  check(Boolean(petWire.apply('export const nope = 1;\n')?.error), '装配层换了写法就报失败，不瞎改');
  const wireFixture = ['export function makeWs(ctx: Ctx) {', '  return {', '        avatarFile: join(ctx.botDir, AVATAR_FILE),', '  };', '}', ''].join('\n');
  const wirePatched = petWire.apply(wireFixture);
  check(!wirePatched?.error && wirePatched.text.includes("workspaceDir: () => join(ctx.botDir, 'workspace'),"), '装配层把桌宠工作区传下去', wirePatched?.error ?? '');
  check(wirePatched.text.indexOf('workspaceDir:') > wirePatched.text.indexOf('avatarFile:'), '接在 avatarFile 后面（不动别的行）');
  check(petWire.done(wirePatched?.text ?? ''), '接线补完认成「已打过」（幂等）');

  // 框架 0.2 起每次启动都拿运行时的工具名核对 describe.tools，对不上就记
  // `worlds.desktop-pet: 工具不在 describe.tools 里,照常生效`（undeclared-names.ts）。
  // pet_show_image 是本扩展注入的，得补进桌宠包的自描述。
  const petDescribe = patchMod.rulesFor('pet-show-image-describe');
  check(typeof petDescribe?.done === 'function' && typeof petDescribe?.apply === 'function', 'pet-show-image-describe 有 done/apply');
  check(specs.find((s) => s.id === 'pet-show-image-describe')?.file.endsWith('definition.ts'), '自描述那处补丁打在装配层 definition.ts', JSON.stringify(specs.find((s) => s.id === 'pet-show-image-describe')));
  check(Boolean(petDescribe.apply('export const nope = 1;\n')?.error), '桌宠自描述换了写法就报失败，不瞎改');
  // 0.2.1 的桌宠包在数组里多了一段 `...CUA_OFF_TOOL_DECLS`——夹具按当前真实写法来，另配一份多行写法。
  const describeFixture = [
    "import { describeTools, type WorldDescribe } from 'cortico/world.ts';",
    'const DESCRIBE: WorldDescribe = {',
    '  tools: describeTools([...petToolDecls(), ...CUA_OFF_TOOL_DECLS, ...CUA_TOOL_DECLS], {',
    "    pet_say: { zh: '说话', en: 'talks' },",
    '  }),',
    '  events: [],',
    '};',
    '',
  ].join('\n');
  check(!petDescribe.done(describeFixture), '夹具是没补过 pet_show_image 的自描述（有东西可补）');
  const described = petDescribe.apply(describeFixture);
  check(!described?.error, '自描述里补上 pet_show_image（数组里多一段 spread 也认）', String(described?.error ?? 'ok'));
  check((described?.text ?? '').includes("      name: 'pet_show_image',") && (described?.text ?? '').includes("      tags: ['act'],"), '条目带名字与 tags（和工具表一致）');
  check((described?.text ?? '').includes("    pet_show_image: { zh: '把本机的一张图片贴到「对话」页"), '也补了中英一句话（summary）');
  check((described?.text ?? '').includes('    pet_say: { zh: ') && (described?.text ?? '').includes('...CUA_TOOL_DECLS,') && (described?.text ?? '').includes('  events: [],'), '原有的 summary / 事件声明原样保留');
  check((described?.text ?? '').includes('...CUA_OFF_TOOL_DECLS,'), '数组里原有的 spread 一个不少');
  check(petDescribe.done(described?.text ?? ''), '补完认成「已打过」（幂等）');
  check(petDescribe.apply(described?.text ?? '')?.text === described?.text, '已经打过再 apply 不改动（runner 之外调用也安全）');
  const multilineFixture = [
    'const DESCRIBE: WorldDescribe = {',
    '  tools: describeTools(',
    '    [...petToolDecls(), ...CUA_TOOL_DECLS],',
    '    {',
    "      pet_say: { zh: '说话', en: 'talks' },",
    '    },',
    '  ),',
    '  events: [],',
    '};',
    '',
  ].join('\n');
  const multiline = petDescribe.apply(multilineFixture);
  check(!multiline?.error && (multiline?.text ?? '').includes("name: 'pet_show_image',"), '多行写法也补得上（上游换排版不至于失效）', String(multiline?.error ?? 'ok'));

  const portWork = mkdtempSync(join(tmpdir(), 'image-port-'));
  mkdirSync(join(portWork, 'resources', 'app'), { recursive: true });
  mkdirSync(join(portWork, 'data', 'home', 'companion'), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(portWork, 'data', 'home', 'companion', 'config.json'), JSON.stringify({ web: { port: 18099 } }));
  check(patchMod.consolePort({ appRoot: join(portWork, 'resources', 'app') }) === 18099, '端口从 <安装>/data/home/companion/config.json 读出来');
  check(patchMod.consolePort({ appRoot: join(portWork, 'resources', 'app'), explicit: 12345 }) === 12345, '显式端口优先');
  check(patchMod.consolePort({ appRoot: join(portWork, 'nope') }) === 17788, '读不到就回默认 17788', String(patchMod.consolePort({ appRoot: join(portWork, 'nope') })));
  rmSync(portWork, { recursive: true, force: true });

  const bogus = patchMod.applyChatImagePatches('X:/not-a-real-app', {});
  check(bogus.failed.length === 1 && bogus.failed[0] === '*', '不是 resources/app 时记一条失败且不抛', JSON.stringify(bogus.failed));
  check(String(bogus.error ?? '').includes('resources/app'), '失败原因说清是哪个目录', String(bogus.error));
  check(!bogus.restartPending, '没打上就不请求重启');

  section('对话页发图补丁（接线）');
  const worldSrc = readFileSync(join(pkgDir, 'src', 'world.js'), 'utf8');
  const patchSrc = readFileSync(join(pkgDir, 'src', 'chat-image-patch.js'), 'utf8');
  check(worldSrc.includes("from './chat-image-patch.js'"), 'world.js 引了补丁模块');
  check(worldSrc.includes('refreshPatchState({ stateDir: PACKAGE_DIR })'), 'world.js 顶层自己打一遍（自动更新覆写后能自愈）');
  check(worldSrc.includes('COOPANION_CHAT_IMAGE_PATCH'), 'world.js 有检查模式开关');
  check(worldSrc.includes('if (PATCH_STATE.restartPending) this.#scheduleRestart'), 'start() 里有新补丁就请求重启');
  check(worldSrc.includes('patch: {') && worldSrc.includes('...PATCH_STATE'), '状态页读得到补丁结果');
  check(worldSrc.includes("case 'restore': return this.#restore();"), '状态页有「还原备份」方法');
  check(worldSrc.includes('backups: patchBackupStatus('), '状态里带上每处补丁的备份现状');
  check(patchSrc.includes('restoreChatImagePatches') && patchSrc.includes('patchBackupStatus'), '补丁模块导出还原与备份查询');
  for (const id of wantIds) check(patchSrc.includes(`'${id}'`), `补丁模块里有 ${id}`);
  check(patchSrc.includes('cortico-world-desktop-pet'), '补丁认的是桌宠包目录');

  const patched = await world.invoke('status', 'repatch', []);
  check(patched?.packageDir === pkgDir, 'repatch 回结果里带扩展目录', String(patched?.packageDir));
  check(String(patched?.skipped ?? '').includes('COOPANION_CHAT_IMAGE_PATCH'), '检查模式下 repatch 不动安装目录', String(patched?.skipped));
  const restarted = await world.invoke('status', 'restart', []);
  check(restarted?.restart?.ok === false && String(restarted?.restart?.detail ?? '').includes('COOPANION_CHAT_IMAGE_PATCH'), '检查模式下不发重启请求', JSON.stringify(restarted?.restart));
  const restored = await world.invoke('status', 'restore', []);
  check(Array.isArray(restored?.restored?.restored) && String(restored?.restored?.skipped ?? '').includes('COOPANION_CHAT_IMAGE_PATCH'), '检查模式下 restore 不动安装目录', JSON.stringify(restored?.restored));
  const st = await world.invoke('status', 'state', []);
  check(Array.isArray(st?.patch?.backups), '状态里能读到备份列表', JSON.stringify(st?.patch?.backups));
  const badge = (world.webUi('zh').badges ?? []).find((b) => b.label === '发图补丁');
  check(!!badge, '控制台徽章里有「发图补丁」');
  check(badge?.value === '未检查', '检查模式下徽章显示「未检查」', String(badge?.value));

  section('未知方法与面板');
  let threw = false;
  try {
    await world.invoke('gallery', 'nope', []);
  } catch {
    threw = true;
  }
  check(threw, '未知面板方法会抛');
  threw = false;
  try {
    await world.invoke('nope', 'list', []);
  } catch {
    threw = true;
  }
  check(threw, '未知面板会抛');
  threw = false;
  try {
    await world.invoke('gallery', 'blob', ['deadbeef']);
  } catch {
    threw = true;
  }
  check(threw, '取不存在的图会抛');
} catch (err) {
  failures += 1;
  console.log(`\n未捕获的异常：${err && err.stack ? err.stack : err}`);
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n结果：${failures} 个失败，${warnings} 个提醒`);
process.exit(failures ? 1 : 0);

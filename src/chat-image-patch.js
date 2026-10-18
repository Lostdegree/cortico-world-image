/**
 * 「桌宠把图片发到「对话」页」这件事的运行时补丁。
 *
 * 为什么还需要补丁：框架 0.1.23 起，「say 带图」这条链路本身已经是原生的——
 * `chat.ts` 的 `chatItem()` 里 `wireImages()` 会把事件上的 `blobs` 里 `image/*` 映射成 `images`，
 * `ChatItem` 的 say 变体带着 `images?: WireImage[]`，客户端 bundle 的 say 那段也会画
 * `chat-thumb` 缩略图，`world.ts` 的 `record(meta, text, blobs = [])` 本来就能把附件写进事件。
 * 所以原先针对客户端 bundle / `chat.ts` / `record()` 的那 4 处补丁**全部删掉了**。
 *
 * 留下来的补丁只做框架原生**没有**的那件事：`pet_say.images` 只认 `[blob …]` 句柄，
 * 不认文件路径，所以「把本地一张图贴进对话页」仍然需要一个按路径收图的工具
 * `pet_show_image`（挂在桌宠世界上，见 `pet-show-image-tool`），
 * 以及它认「相对桌宠工作区」路径的那几处。
 *
 * 还有一处落在桌宠包的装配层（`definition.ts` 的 `DESCRIBE`）：把 `pet_show_image` 补进
 * `describe.tools`。框架 0.2 起会拿运行时的工具名核对自描述，对不上就每次启动记一条
 * `工具不在 describe.tools 里,照常生效`（`undeclared-names.ts`）；这个工具是本扩展注入的，
 * 桌宠包自己的自描述里当然没有（见 `pet-show-image-describe`）。
 *
 * 这些文件都在安装目录里，而程序会自动更新、把变动覆写掉，所以每次启动都由本模块
 * 重新检查一遍：认得出的原文就改写，已经打过的跳过，认不出来就记一条失败并在控制台
 * 状态页报出来 —— 绝不猜着改。（文件同时留一份 `.coopanion-orig` 备份，只存第一次的原文。）
 *
 * 补丁一律幂等：靠 detect 文本（以及插进 `tools()` 那段的 `/*COOPANION_CHAT_IMAGE_TOOL*\/` 标记）。
 *
 * 还有一处跟「图片路径」有关的补丁落在 QQ 扩展（`cortico-world-qq-better-alont1`）上：
 * `qq_send_image` / `qq_view_image` 的本地路径过去一律按**扩展目录**解析，于是桌宠拿
 * `blobs/xx.jpg`（工作区里的图）去发就报「本地没有这个文件」，只能写死绝对路径。
 * 这里把它改成**先按桌宠工作区（`memoryDir` = `<botDir>/workspace`）解析、扩展目录兜底**，
 * 顺带把两个工具的参数说明改成同样口径 —— 模型只看得到工具说明。
 * 那是第三方包（pnpm 装在 `.pnpm/` 下、升级会换目录），所以同样走
 * 「认得出原文才改 + 留备份 + 可还原」，装不到就记 `absent`、不算失败。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PET_PKG = 'cortico-world-desktop-pet';
const STATE_FILE = '.chat-image-patch.json';
/** QQ 扩展（第三方包）：它的两个图片工具过去只认「相对扩展目录」。 */
const QQ_PKG = 'cortico-world-qq-better-alont1';

const msg = (err) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// 安装目录定位
// ---------------------------------------------------------------------------

/** `dir` 像不像一份 `resources/app`（框架源码 + 桌宠包都在）。 */
function looksLikeApp(dir) {
  return Boolean(dir)
    && existsSync(join(dir, 'build', 'cortico', 'src', 'paths.ts'))
    && existsSync(join(dir, 'node_modules', PET_PKG, 'src', 'world.ts'));
}

/** 从 seed 目录逐级向上找 `resources/app`，也把 seed 自己当候选。 */
function walkUp(seed, depth = 8) {
  const out = [];
  let at = resolve(seed);
  for (let i = 0; i <= depth; i += 1) {
    out.push(join(at, 'resources', 'app'), at);
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return out;
}

/**
 * 这份安装的 `resources/app`。按可靠性依次试：
 * 环境变量覆盖 → Electron 的 resourcesPath → 本扩展自己往上找 → 工作目录往上找。
 */
export function resolveAppRoot(extra = []) {
  const seeds = [
    process.env.COOPANION_APP_ROOT ? resolve(process.env.COOPANION_APP_ROOT) : '',
    process.resourcesPath ? join(process.resourcesPath, 'app') : '',
    ...extra.filter(Boolean),
    fileURLToPath(new URL('..', import.meta.url)),
    process.cwd(),
  ].filter(Boolean);
  for (const seed of seeds) {
    if (looksLikeApp(seed)) return resolve(seed);
    for (const cand of walkUp(seed)) if (looksLikeApp(cand)) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 补丁
// ---------------------------------------------------------------------------

/**
 * QQ 扩展的 `src/world.ts`。它在数据目录里：`<安装>/data/extensions/node_modules/<包>/src/world.ts`，
 * 而 `appRoot` 是 `<安装>/resources/app`，所以要往上两级。也接受：
 * - `COOPANION_EXTENSIONS_DIR` 指定 `<…>/extensions`（联调/别处安装）；
 * - `appRoot` 自己底下就有 `data/extensions`（副本自测时的摆法）。
 */
function qqWorldFile(appRoot) {
  const rel = ['src', 'world.ts'];
  const cands = [];
  const override = process.env.COOPANION_EXTENSIONS_DIR;
  if (override) {
    const dir = resolve(override);
    cands.push(join(dir, 'node_modules', QQ_PKG, ...rel), join(dir, QQ_PKG, ...rel));
  }
  for (const root of [dirname(dirname(resolve(appRoot))), resolve(appRoot)]) {
    cands.push(join(root, 'data', 'extensions', 'node_modules', QQ_PKG, ...rel));
  }
  const hit = cands.find((c) => existsSync(c));
  return hit ?? cands[0] ?? '';
}

/** 把 `\n` 换成文件自己的换行，锚点才落得上。 */
function asWritten(from, nl) {
  return nl === '\n' ? from : from.split('\n').join(nl);
}

/** 把 from 换成 to；from 不在原文里返回 null（调用方记账为「原文对不上」）。
 *  to 走回调，免得压缩代码里的 `$` 被当成替换模式。 */
function swap(text, from, to) {
  if (!text.includes(from)) return null;
  return text.replace(from, () => to);
}

/** `import { a, b } from 'node:fs';` —— 名字列表原样读出来（源码升级会往里加名字）。 */
function readImport(text, mod) {
  const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`import \\{([^}]*)\\} from '${esc}';`).exec(text);
  if (!m) return null;
  if (m[0].includes('\n')) return { whole: m[0], names: null };
  return { whole: m[0], names: m[1].split(',').map((s) => s.trim()).filter(Boolean) };
}

function importHas(text, mod, want) {
  const cur = readImport(text, mod);
  return Boolean(cur?.names) && want.every((n) => cur.names.includes(n));
}

/** 往 `import {…} from '<mod>';` 里补几个名字，按字母序重排（幂等）。 */
function withImport(text, mod, want) {
  const cur = readImport(text, mod);
  if (!cur) return { error: `没找到 ${mod} 的导入行` };
  if (!cur.names) return { error: `${mod} 的导入行是多行的，认不出来` };
  const names = [...new Set([...cur.names, ...want])].sort();
  const next = `import { ${names.join(', ')} } from '${mod}';`;
  if (next === cur.whole) return { text };
  return { text: text.replace(cur.whole, () => next) };
}

/** 我们插进 `tools()` 的那一小段（带标记，认得出自己插过什么）。 */
const TOOL_PIECE = '{ /*COOPANION_CHAT_IMAGE_TOOL*/ ...CHAT_IMAGE_TOOL, handler: (args) => this.showImage(args) }';

/** 自己插过的旧写法（曾经把 `.map(…)` 又包了一层 `[...]`，结果 6 个工具全变成 null）。 */
const TOOL_PIECE_OLD = [
  /, \{ \/\*COOPANION_CHAT_IMAGE_TOOL\*\/ \.\.\.CHAT_IMAGE_TOOL, handler: \(args\) => this\.showImage\(args\) \}/,
  /, \{ \.\.\.CHAT_IMAGE_TOOL, handler: \(args\) => this\.showImage\(args\) \}/,
];

/** 剥掉我们插过的那一段，拿回「原始的 return 表达式」。 */
function unwrapToolsExpr(expr) {
  let e = String(expr).trim();
  for (const re of TOOL_PIECE_OLD) {
    const m = re.exec(e);
    if (m) { e = e.slice(0, m.index).trim(); break }
  }
  if (e.startsWith('[...[].concat(')) {
    e = e.slice('[...[].concat('.length).trim();
    if (e.endsWith(')]')) e = e.slice(0, -2).trim();
    else if (e.endsWith(')')) e = e.slice(0, -1).trim();
    return e;
  }
  if (e.startsWith('[') && e.endsWith(']')) return e.slice(1, -1).trim();
  if (e.startsWith('[')) return e.slice(1).trim();
  return e;
}

/**
 * `tools()` 里那句 `return …;` —— 0.1.19 是 `DESKTOP_PET_TOOL_DECLS.map(…)`，
 * 0.1.21 变成 `petToolDecls(this.appLanguage).map(…)`，所以整句按原文抓，
 * 再用 `[].concat(…)` **摊平**着把我们的工具接上去。
 *
 * 为什么不写 `[${expr}, TOOL]`：`expr` 本身就是数组，那么写会变成嵌套数组，
 * 框架读出来的 6 个工具名会全变 null（0.1.21 上真翻过这个车）。
 * 已经打过的（含旧的嵌套写法）先剥掉再重写，所以重复跑是安全的。
 */
function patchToolsReturn(text) {
  const head = /tools\(\): ToolDef\[\] \{/.exec(text);
  if (!head) return { error: '没找到 tools() 方法' };
  const seg = text.slice(head.index, head.index + 3000);
  const rm = /^([ \t]*)return ([^\n]*);$/m.exec(seg);
  if (!rm) return { error: '没找到 tools() 里的 return' };
  const expr = unwrapToolsExpr(rm[2]);
  if (!expr || /CHAT_IMAGE_TOOL/.test(expr)) return { error: `认不出原始的 return 表达式:${rm[2].slice(0, 80)}` };
  const next = `${rm[1]}return [...[].concat(${expr}), ${TOOL_PIECE}];`;
  const start = head.index + rm.index;
  return { text: text.slice(0, start) + next + text.slice(start + rm[0].length) };
}

const WORLD_EXTRA = [
  '/** coopanion-chat-image: `pet_show_image` 认的图片后缀，文件头嗅探优先。 */',
  "const IMAGE_MIME_BY_EXT: Record<string, string> = {",
  "  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',",
  '};',
  '',
  '/** coopanion-chat-image: 按文件头认图片，认不出来才退回后缀。 */',
  'function sniffImageMime(bytes: Buffer): string | null {',
  '  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return \'image/png\';',
  '  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return \'image/jpeg\';',
  "  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';",
  "  if (bytes.length > 6 && bytes.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';",
  '  return null;',
  '}',
  '',
  '/** coopanion-chat-image: 贴图工具；tags 里没有 speak，所以 CosyVoice 那类只认 `pet_say` 的扩展不会碰它。 */',
  "const CHAT_IMAGE_TOOL: Omit<ToolDef, 'handler'> = {",
  "  name: 'pet_show_image',",
  "  tags: ['act'],",
  "  description: '把本地一张图片贴到「对话」页(桌宠这一侧),配文可选。图先画好/存好再调用;只认 PNG、JPEG、WebP、GIF,单张不超过 8 MB。',",
  '  parameters: {',
  "    type: 'object',",
  '    properties: {',
  "      path: { type: 'string', description: '图片文件的完整路径。' },",
  "      caption: { type: 'string', maxLength: 200, description: '配文,一句话;不写就只贴图。' },",
  '    },',
  "    required: ['path'],",
  '  },',
  '};',
].join('\n');

const SHOW_IMAGE_METHOD = [
  '  /**',
  '   * coopanion-chat-image: 把一张本地图片贴到「对话」页。',
  '   *',
  '   * 图片随事件存成附件(blobs),页面用 `chat.blob` 取回;只写对话记录,不碰气泡窗口,',
  '   * 所以桌宠窗口没连接也能用。',
  '   */',
  '  private async showImage(args: Record<string, unknown>): Promise<ToolOutcome> {',
  "    const raw = typeof args.path === 'string' ? args.path.trim() : '';",
  "    const caption = typeof args.caption === 'string' ? args.caption.trim().slice(0, 200) : '';",
  "    if (!raw) return { text: '[pet_show_image 没执行] 要给图片的完整路径。', failed: true };",
  "    if (!isAbsolute(raw)) return { text: '[pet_show_image 没执行] 需要完整路径(例如 C:\\\\Users\\\\...\\\\pic.png)。', failed: true };",
  '    let bytes: Buffer;',
  '    try {',
  '      bytes = readFileSync(raw);',
  '    } catch (err) {',
  '      return { text: `[pet_show_image 没执行] 这个文件读不到:${(err as Error).message}`, failed: true };',
  '    }',
  '    const mime = sniffImageMime(bytes) ?? IMAGE_MIME_BY_EXT[extname(raw).toLowerCase()];',
  "    if (!mime) return { text: '[pet_show_image 没执行] 这不是 PNG / JPEG / WebP / GIF 图片。', failed: true };",
  '    if (bytes.length > IMAGE_MAX_BYTES) {',
  '      return { text: `[pet_show_image 没执行] 这张图 ${(bytes.length / 1048576).toFixed(1)} MB,超过 ${IMAGE_MAX_BYTES / 1048576} MB 了。`, failed: true };',
  '    }',
  "    if (!this.host) return { text: '[pet_show_image 没执行] 现在没连着对话记录。', failed: true };",
  "    const name = basename(raw).slice(0, 120) || 'image';",
  '    const cursor = await this.record(',
  "      { kind: 'say', beats: caption ? [{ text: caption }] : [] },",
  '      caption,',
  '      [{ bytes, mime, name, fallbackText: `对话页配图:${name}(${mime},${bytes.length} 字节)` }],',
  '    );',
  "    if (cursor === null) return { text: '[pet_show_image 没执行] 对话记录没能保存。', failed: true };",
  "    const shown = this.chat.size ? '对话页正开着,图已经贴上去了。' : '对话页没开,打开就能看到。';",
  '    return { text: `已把 ${name}(${mime},${(bytes.length / 1024).toFixed(0)} KB)贴到「对话」页${caption ? `,配文「${caption}」` : \'\'}。${shown}` };',
  '  }',
].join('\n');

// ---------------------------------------------------------------------------
// 桌宠自己那份：`pet_show_image` 也认相对工作区的路径
// ---------------------------------------------------------------------------

/**
 * 上面两段载荷（`WORLD_EXTRA` 的工具表 + `SHOW_IMAGE_METHOD` 的实现）**故意保持旧写法**，
 * 由下面这条补丁在原文里就地改写。这样「全新安装」和「早先打过旧版补丁的安装」走的是同一条路
 * （旧文本 → 新文本），不会出现两种终态。
 *
 * 注意：`SHOW_IMAGE_METHOD` 里是 `this.record(meta, text, blobs)` 三参调用 —— 框架 0.1.23 起
 * `record()` 原生就收第三个 `blobs` 参数，所以这里不再需要 `pet-record-blobs` 那处签名补丁。
 */
const PET_WORKSPACE_OPTION_ANCHOR = '  avatarFile?: string;';
const PET_WORKSPACE_OPTION = [
  '  /** coopanion-chat-image: 桌宠工作区(相对图片路径按它解析);装配层给,没给就只能用绝对路径。 */',
  '  workspaceDir?: () => string;',
].join('\n');

/** 装配层在 `definition.ts` 里补的那一行（`join` 那儿的 import 本来就有）。 */
const PET_WORKSPACE_WIRE_ANCHOR = '        avatarFile: join(ctx.botDir, AVATAR_FILE),';
const PET_WORKSPACE_WIRE = "        workspaceDir: () => join(ctx.botDir, 'workspace'),";

// ---------------------------------------------------------------------------
// 桌宠包的自描述（`definition.ts` 的 `DESCRIBE`）：补上 `pet_show_image`
// ---------------------------------------------------------------------------

/**
 * 框架 0.2 起，运行时给出的工具名要和 `describe.tools` 对得上，对不上就记
 * `工具不在 describe.tools 里,照常生效`（`undeclared-names.ts`，每个名字只记一次）。
 * `pet_show_image` 是本扩展注入的，桌宠包自己的 `DESCRIBE` 里没有，所以在装配层把它的声明补进去；
 * 措辞、参数与 `tags` 跟 `WORLD_EXTRA` 里的 `CHAT_IMAGE_TOOL` 保持同一份（改一处就要改两处）。
 */
const PET_DESCRIBE_ANCHOR = 'tools: describeTools(';

/**
 * 桌宠包升级里这段数组反复改过写法（0.2.1 起多了一段 `...CUA_OFF_TOOL_DECLS`，也出现过换行排版），
 * 所以不按整行匹配：只认 `tools: describeTools(`，数括号找到数组结尾，声明插在末尾。
 */
const findArrayEnd = (text, open) => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      for (i += 1; i < text.length && text[i] !== quote; i += 1) {
        if (text[i] === '\\') i += 1;
      }
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** 基准缩进按 2 空格写，实际按 `tools:` 那行的缩进平移。 */
const PET_DESCRIBE_TOOL = [
  '  /* coopanion-chat-image: `pet_show_image` 的声明(实现注入在 world.ts)。 */',
  '  {',
  "    name: 'pet_show_image',",
  "    tags: ['act'],",
  "    description: '把本地一张图片贴到「对话」页(桌宠这一侧),配文可选。图先画好/存好再调用;只认 PNG、JPEG、WebP、GIF,单张不超过 8 MB。',",
  '    parameters: {',
  "      type: 'object',",
  '      properties: {',
  "        path: { type: 'string', description: '图片路径:绝对路径,或相对桌宠工作区的路径(例如 blobs/xx.jpg)。' },",
  "        caption: { type: 'string', maxLength: 200, description: '配文,一句话;不写就只贴图。' },",
  '      },',
  "      required: ['path'],",
  '    },',
  '  },',
];
const PET_DESCRIBE_SUMMARY =
  "pet_show_image: { zh: '把本机的一张图片贴到「对话」页,配文可选;只认 PNG / JPEG / WebP / GIF,单张不超过 8 MB。', en: 'Shows a picture from this computer on the chat page, with an optional caption; PNG, JPEG, WebP or GIF up to 8 MB.' },";

const PET_WORKSPACE_DONE = 'raw = join(ws, raw);';
const PET_RAW_OLD = "    const raw = typeof args.path === 'string' ? args.path.trim() : '';";
const PET_RAW_NEW = "    let raw = typeof args.path === 'string' ? args.path.trim() : '';";
const PET_PATH_GUARD_OLD = "    if (!isAbsolute(raw)) return { text: '[pet_show_image 没执行] 需要完整路径(例如 C:\\\\Users\\\\...\\\\pic.png)。', failed: true };";
const PET_PATH_GUARD_NEW = [
  '    if (!isAbsolute(raw)) {',
  "      const ws = (this.opts.workspaceDir?.() ?? '').trim();",
  "      if (!ws) return { text: '[pet_show_image 没执行] 相对路径没有工作区可拼;请给完整路径(例如 C:\\\\Users\\\\...\\\\pic.png)。', failed: true };",
  '      raw = join(ws, raw);',
  '    }',
].join('\n');
const PET_PATH_HINT_OLD = "description: '图片文件的完整路径。'";
const PET_PATH_HINT_NEW = "description: '图片路径:绝对路径,或相对桌宠工作区的路径(例如 blobs/xx.jpg)。'";

// ---------------------------------------------------------------------------
// QQ 扩展那两处：本地图片路径按桌宠工作区解析（第三方包，认不出原文就报失败）
// ---------------------------------------------------------------------------

/** 插进 QQ 扩展的助手：相对路径按桌宠工作区(`memoryDir`)解析,扩展目录只作兜底。 */
const QQ_RESOLVE_FN = [
  '/** coopanion-chat-image: 相对图片路径按桌宠工作区(memoryDir)解析,扩展目录只作兜底。 */',
  'function resolveLocalImagePath(p: string, memoryDir: string, packageDir: string): string {',
  '  if (isAbsolute(p)) return p;',
  "  const ws = (memoryDir || '').trim();",
  "  const ext = (packageDir || '').trim();",
  "  if (!ws) return join(ext || '.', p);",
  '  const inWs = join(ws, p);',
  '  if (!ext) return inWs;',
  '  const inExt = join(ext, p);',
  '  return existsSync(inExt) && !existsSync(inWs) ? inExt : inWs;',
  '}',
].join('\n');

const QQ_CLASS_ANCHOR = 'export class QQWorld implements World {';
/** 发图（`loadOutgoingImage`）与看图（`qq_view_image`）里那两句本地路径解析。 */
const QQ_SEND_OLD = "const p = isAbsolute(image) ? image : join(this.packageDir || '.', image);";
const QQ_SEND_NEW = 'const p = resolveLocalImagePath(image, this.config.memoryDir, this.packageDir);';
const QQ_VIEW_OLD = "const p = isAbsolute(url) ? url : join(this.packageDir || '.', url);";
const QQ_VIEW_NEW = 'const p = resolveLocalImagePath(url, this.config.memoryDir, this.packageDir);';

/**
 * 工具说明里那三处要跟着改成「相对桌宠工作区」——模型只看得到说明。
 * 上游爱改措辞（0.1.16 就把 image 那句换成了「如 /home/user/pics/a.png」），所以每条列出
 * 见过的旧写法：一条都对不上只跳过、不判失败；整条补丁一句都认不出来才算版本变了。
 */
const QQ_HINTS = [
  {
    from: [
      "description: '本地文件路径（绝对路径，或相对扩展目录）或 http(s) 链接。'",
      "description: '本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。'",
    ],
    to: "description: '本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）或 http(s) 链接。'",
  },
  {
    from: ['或本地文件路径；给了就不再翻缓冲。'],
    to: '或本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）；给了就不再翻缓冲。',
  },
  {
    from: ['给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。'],
    to: '给某个会话发一张图。`image` 给本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）或 http(s) 链接（本机下载后再发），二者挑一个。',
  },
];

/** 这条说明还没改成我们的说法、而且上游还有它认得的旧写法 → 需要动手。 */
const hintNeedsWork = (text, h) => !text.includes(h.to) && [].concat(h.from).some((from) => text.includes(from));

/**
 * 每个补丁：`file` 是绝对路径，`done` 说这段原文是不是已经改过了，
 * `apply` 返回新文本或 `{ error }`。全部按顺序跑，互不依赖。
 */
export function patchSpecs(appRoot) {
  const pet = join(appRoot, 'node_modules', PET_PKG, 'src');
  const qq = qqWorldFile(appRoot);
  const specs = [
    { id: 'pet-fs-import', file: join(pet, 'world.ts'), what: '桌宠包导入 readFileSync' },
    { id: 'pet-path-import', file: join(pet, 'world.ts'), what: '桌宠包导入 basename/extname/isAbsolute' },
    { id: 'pet-show-image-tool', file: join(pet, 'world.ts'), what: 'pet_show_image 工具与它的实现' },
    // 这三处让 pet_show_image 也认「相对桌宠工作区」的路径；最后一条依赖上面那条先插好方法。
    { id: 'pet-workspace-option', file: join(pet, 'world.ts'), what: '桌宠包选项加 workspaceDir' },
    { id: 'pet-workspace-relpaths', file: join(pet, 'world.ts'), what: 'pet_show_image 认工作区相对路径' },
    { id: 'pet-workspace-wire', file: join(pet, 'definition.ts'), what: '装配层把工作区喂给桌宠世界' },
    { id: 'pet-show-image-describe', file: join(pet, 'definition.ts'), what: '自描述里补上 pet_show_image' },
    // 这两处落在第三方 QQ 扩展上：没装就记 absent（不算失败），装了才改。
    { id: 'qq-image-relpaths', file: qq, what: 'QQ 发图/看图认工作区相对路径', optional: true },
    { id: 'qq-image-hints', file: qq, what: 'QQ 发图/看图的说明写明相对工作区', optional: true },
  ];
  return specs;
}

/** 一处补丁的改写规则（拆出来是为了能在副本上单测）。 */
export function rulesFor(id) {
  const nl = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
  switch (id) {
    case 'pet-fs-import':
      return {
        done: (text) => importHas(text, 'node:fs', ['readFileSync']),
        apply: (text) => withImport(text, 'node:fs', ['readFileSync']),
      };
    case 'pet-path-import':
      return {
        done: (text) => importHas(text, 'node:path', ['basename', 'extname', 'isAbsolute']),
        apply: (text) => withImport(text, 'node:path', ['basename', 'extname', 'isAbsolute']),
      };
    case 'pet-show-image-tool':
      return {
        // 必须连标记一起要求：只认「工具表和实现都在」会让上一版写坏的
        // `[EXPR, TOOL]`（嵌套数组）被当成已完成，6 个老工具名就一直是 null。
        done: (text) =>
          text.includes('const CHAT_IMAGE_TOOL') &&
          text.includes('this.showImage(args)') &&
          text.includes('/*COOPANION_CHAT_IMAGE_TOOL*/'),
        apply: (text) => {
          let work = text;
          // 这两段插过一次就不再插（否则报 Identifier 'CHAT_IMAGE_TOOL' has already been declared）。
          if (!work.includes('const IMAGE_MIME_BY_EXT: Record<string, string> = {')) {
            const withTool = swap(work, 'export class DesktopPetWorld implements World {', `${asWritten(WORLD_EXTRA, nl(work))}\n\nexport class DesktopPetWorld implements World {`);
            if (withTool === null) return { error: '没找到 DesktopPetWorld 的类声明' };
            work = withTool;
          }
          if (!work.includes('private async showImage(args: Record<string, unknown>): Promise<ToolOutcome> {')) {
            const withMethod = swap(work, '  private notConnected(tool: string): ToolOutcome {', `${asWritten(SHOW_IMAGE_METHOD, nl(work))}\n\n  private notConnected(tool: string): ToolOutcome {`);
            if (withMethod === null) return { error: '没找到 notConnected()（插方法的锚点）' };
            work = withMethod;
          }
          const out = patchToolsReturn(work);
          if (out.error) return { error: out.error };
          return { text: out.text };
        },
      };
    case 'pet-workspace-option':
      return {
        done: (text) => text.includes('workspaceDir?: () => string;'),
        apply: (text) => {
          const block = asWritten(PET_WORKSPACE_OPTION, nl(text));
          const out = swap(text, PET_WORKSPACE_OPTION_ANCHOR, `${PET_WORKSPACE_OPTION_ANCHOR}\n${block}`);
          return out === null ? { error: `没找到 ${PET_WORKSPACE_OPTION_ANCHOR}（桌宠包版本变了）` } : { text: out };
        },
      };
    case 'pet-workspace-relpaths':
      return {
        // 认「相对路径真的拼上工作区」那段：只认到工具表里的说明不算打过。
        done: (text) => text.includes(PET_WORKSPACE_DONE),
        apply: (text) => {
          let work = text;
          if (!importHas(work, 'node:path', ['isAbsolute', 'join'])) {
            const p = withImport(work, 'node:path', ['isAbsolute', 'join']);
            if (p.error) return { error: `补 node:path 导入失败：${p.error}` };
            work = p.text;
          }
          const letRaw = swap(work, PET_RAW_OLD, PET_RAW_NEW);
          if (letRaw === null) return { error: `没找到 ${PET_RAW_OLD.trim()}（pet-show-image-tool 还没打上?）` };
          const guard = swap(letRaw, PET_PATH_GUARD_OLD, asWritten(PET_PATH_GUARD_NEW, nl(work)));
          if (guard === null) return { error: `没找到只认绝对路径的那行：${PET_PATH_GUARD_OLD.trim()}` };
          const hint = swap(guard, PET_PATH_HINT_OLD, PET_PATH_HINT_NEW);
          if (hint === null) return { error: `工具说明对不上：${PET_PATH_HINT_OLD}` };
          return { text: hint };
        },
      };
    case 'pet-workspace-wire':
      return {
        done: (text) => text.includes(PET_WORKSPACE_WIRE),
        apply: (text) => {
          const line = asWritten(PET_WORKSPACE_WIRE, nl(text));
          const out = swap(text, PET_WORKSPACE_WIRE_ANCHOR, `${PET_WORKSPACE_WIRE_ANCHOR}\n${line}`);
          return out === null ? { error: `没找到 ${PET_WORKSPACE_WIRE_ANCHOR}（桌宠包版本变了）` } : { text: out };
        },
      };
    case 'pet-show-image-describe':
      return {
        // 0.1 的桌宠包还没有自描述（没有 `describeTools(`），那时没什么可补的。
        done: (text) => !text.includes('describeTools(') || text.includes("name: 'pet_show_image'"),
        apply: (text) => {
          if (text.includes("name: 'pet_show_image'")) return { text };
          const at = text.indexOf(PET_DESCRIBE_ANCHOR);
          if (at < 0) return { error: `没找到 ${PET_DESCRIBE_ANCHOR}（桌宠包版本变了）` };
          // 缩进跟着原文 `tools:` 那行走（上游把 2 空格改成别的，也不至于排版崩掉）。
          const pad = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at) + 1, at))?.[0] ?? '  ';
          // `describeTools(` 后面可能直接跟 `[`，也可能换行再跟（上游排版变过）。
          const open = text.indexOf('[', at + PET_DESCRIBE_ANCHOR.length);
          if (open < 0 || open - at > 200) return { error: `没找到 ${PET_DESCRIBE_ANCHOR} 后面的 \`[\`（桌宠包版本变了）` };
          const close = findArrayEnd(text, open);
          if (close < 0) return { error: `没找到 ${PET_DESCRIBE_ANCHOR} 配对的 \`]\`（桌宠包版本变了）` };
          const tool = PET_DESCRIBE_TOOL.map((line) => pad + line).join('\n');
          const withTool = `${text.slice(0, close)},\n${tool}\n${pad}${text.slice(close)}`;
          // 数组后面那个参数对象里再补一句中英文 summary（模型读的是它）。
          const objOpen = withTool.indexOf('{', findArrayEnd(withTool, open));
          if (objOpen < 0) return { error: `没找到 ${PET_DESCRIBE_ANCHOR} 后面的 summary 对象（桌宠包版本变了）` };
          const withSummary = `${withTool.slice(0, objOpen + 1)}\n${pad}  ${PET_DESCRIBE_SUMMARY}${withTool.slice(objOpen + 1)}`;
          return { text: withSummary };
        },
      };
    case 'qq-image-relpaths':
      return {
        // 助手在 + 两处都换了才算打过（助手没插上就调用它会是 ReferenceError）。
        done: (text) =>
          text.includes('function resolveLocalImagePath(') &&
          text.includes(QQ_SEND_NEW) &&
          text.includes(QQ_VIEW_NEW),
        apply: (text) => {
          let work = text;
          // 助手要用 existsSync / isAbsolute / join：缺了才补导入（够了就不动，别多改第三方文件）。
          if (!importHas(work, 'node:fs', ['existsSync'])) {
            const fs = withImport(work, 'node:fs', ['existsSync']);
            if (fs.error) return { error: `补 node:fs 导入失败：${fs.error}` };
            work = fs.text;
          }
          if (!importHas(work, 'node:path', ['isAbsolute', 'join'])) {
            const p = withImport(work, 'node:path', ['isAbsolute', 'join']);
            if (p.error) return { error: `补 node:path 导入失败：${p.error}` };
            work = p.text;
          }
          const withFn = swap(work, QQ_CLASS_ANCHOR, `${asWritten(QQ_RESOLVE_FN, nl(work))}\n\n${QQ_CLASS_ANCHOR}`);
          if (withFn === null) return { error: `没找到 ${QQ_CLASS_ANCHOR}（QQ 扩展版本变了）` };
          const send = swap(withFn, QQ_SEND_OLD, QQ_SEND_NEW);
          if (send === null) return { error: `没找到发图那行本地路径解析：${QQ_SEND_OLD}` };
          const view = swap(send, QQ_VIEW_OLD, QQ_VIEW_NEW);
          if (view === null) return { error: `没找到看图那行本地路径解析：${QQ_VIEW_OLD}` };
          return { text: view };
        },
      };
    case 'qq-image-hints':
      return {
        // 已经有一处是我们的说法，且没有哪处还留着认得的旧写法 → 不用再管（上游换掉的措辞不再拖住这条）。
        done: (text) => QQ_HINTS.some((h) => text.includes(h.to)) && QQ_HINTS.every((h) => !hintNeedsWork(text, h)),
        apply: (text) => {
          let work = text;
          let recognized = 0;
          for (const h of QQ_HINTS) {
            if (work.includes(h.to)) {
              recognized += 1;
              continue;
            }
            for (const from of [].concat(h.from)) {
              const out = swap(work, from, h.to);
              if (out !== null) {
                work = out;
                recognized += 1;
                break;
              }
            }
          }
          if (recognized === 0) return { error: `工具说明已大改，一句都认不出来：${[].concat(QQ_HINTS[0].from)[0].slice(0, 40)}` };
          return { text: work };
        },
      };
    default:
      return null;
  }
}

/**
 * 检查并补齐所有补丁。
 *
 * 返回 `{ appRoot, results, patched, failed, restartPending, stuck }`；
 * `results[i]` 是 `{ id, what, file, state, error? }`，state 取 `patched`/`done`/`failed`/`missing`
 * （目标文件不在）——`optional` 的补丁没装那个扩展时记 `absent`，不计失败也不计「缺」。
 */
export function applyChatImagePatches(appRoot, { stateDir, log } = {}) {
  const results = [];
  if (!appRoot || !looksLikeApp(appRoot)) {
    const error = appRoot ? `这个目录不像 Coopanion 的 resources/app:${appRoot}` : '找不到 Coopanion 的 resources/app';
    log?.warn?.(`图片工坊补丁:${error}`);
    return { appRoot, results, patched: [], failed: ['*'], restartPending: false, stuck: false, error };
  }
  for (const spec of patchSpecs(appRoot)) {
    const rules = rulesFor(spec.id);
    const name = spec.file ? basename(spec.file) : '(没找到)';
    const backup = spec.file ? `${spec.file}.coopanion-orig` : '';
    if (!spec.file || !existsSync(spec.file)) {
      const gone = spec.optional ? 'absent' : 'missing';
      results.push({
        id: spec.id,
        what: spec.what,
        file: spec.file,
        backup,
        state: gone,
        optional: Boolean(spec.optional),
        error: spec.optional ? `${spec.id}: 没装这个扩展(${spec.file ?? ''})` : `${spec.id} 的目标文件不在:${spec.file ?? ''}`,
      });
      continue;
    }
    try {
      const text = readFileSync(spec.file, 'utf8');
      if (rules.done(text)) {
        results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'done' });
        continue;
      }
      const out = rules.apply(text);
      if (!out || out.error) {
        results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'failed', error: out?.error ?? '没改写出来' });
        continue;
      }
      if (!existsSync(backup)) copyFileSync(spec.file, backup);
      writeFileSync(spec.file, out.text, 'utf8');
      log?.info?.(`图片工坊补丁:已改 ${name}(${spec.what})`);
      results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'patched' });
    } catch (err) {
      results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'failed', error: msg(err) });
    }
  }
  const patched = results.filter((r) => r.state === 'patched').map((r) => r.id);
  const failed = results.filter((r) => r.state === 'failed' || r.state === 'missing').map((r) => r.id);

  // 状态文件：只用来防「补丁写不进去 → 每次启动都重启」这种死循环。
  let prev = null;
  const stateFile = stateDir ? join(stateDir, STATE_FILE) : '';
  if (stateFile) {
    try {
      prev = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      prev = null;
    }
  }
  const sameApp = Boolean(prev && prev.appRoot === resolve(appRoot));
  const stuck = Boolean(sameApp && prev.requested === true && patched.some((id) => (prev.patched ?? []).includes(id)));
  const restartPending = patched.length > 0 && !stuck;
  if (stateFile) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, `${JSON.stringify({
        at: new Date().toISOString(),
        appRoot: resolve(appRoot),
        patched,
        failed,
        requested: restartPending || (sameApp && prev.requested === true && stuck),
      }, null, 2)}\n`, 'utf8');
    } catch (err) {
      log?.warn?.(`图片工坊补丁:状态文件写不进去:${msg(err)}`);
    }
  }
  if (stuck) {
    log?.warn?.('图片工坊补丁:上一轮已经为同一处补丁请求过重启,这次仍然缺,先不再重启;请在「图片工坊」状态页点「重打补丁」');
  }
  return { appRoot, results, patched, failed, restartPending, stuck };
}

/**
 * 每一处补丁的目标文件与它的 `.coopanion-orig` 备份的现状（状态页与 CLI 用）。
 */
export function patchBackupStatus(appRoot) {
  const out = [];
  if (!appRoot || !looksLikeApp(appRoot)) return out;
  for (const spec of patchSpecs(appRoot)) {
    const backup = spec.file ? `${spec.file}.coopanion-orig` : '';
    const hasFile = Boolean(spec.file && existsSync(spec.file));
    // 可选的第三方扩展没装：整行不出现（状态页按行数算「已打 n/总数」）。
    if (!hasFile && spec.optional) continue;
    const hasBackup = Boolean(backup && existsSync(backup));
    let patched = false;
    if (hasFile) {
      try {
        patched = Boolean(rulesFor(spec.id)?.done(readFileSync(spec.file, 'utf8')));
      } catch {
        patched = false;
      }
    }
    const st = hasBackup ? statSync(backup) : null;
    const ft = hasFile ? statSync(spec.file) : null;
    out.push({
      id: spec.id,
      what: spec.what,
      file: spec.file,
      backup,
      hasFile,
      hasBackup,
      fileBytes: ft?.size ?? 0,
      backupBytes: st?.size ?? 0,
      fileAt: ft ? ft.mtime.toISOString() : '',
      backupAt: st ? st.mtime.toISOString() : '',
      same: Boolean(hasFile && hasBackup && readFileSync(spec.file).equals(readFileSync(backup))),
      patched,
    });
  }
  return out;
}

/**
 * 用 `.coopanion-orig` 把目标文件覆盖回去（撤销补丁）。备份留着不删，
 * 所以「还原 → 再打一次」随时可以来回；下次启动的自动检查也会再补上。
 */
export function restoreChatImagePatches(appRoot, { stateDir, log } = {}) {
  const results = [];
  if (!appRoot || !looksLikeApp(appRoot)) {
    const error = appRoot ? `这个目录不像 Coopanion 的 resources/app:${appRoot}` : '找不到 Coopanion 的 resources/app';
    log?.warn?.(`图片工坊补丁:${error}`);
    return { appRoot, results, restored: [], failed: ['*'], error };
  }
  for (const spec of patchSpecs(appRoot)) {
    const backup = spec.file ? `${spec.file}.coopanion-orig` : '';
    if (!spec.file || !existsSync(spec.file)) {
      results.push({
        id: spec.id,
        what: spec.what,
        file: spec.file,
        backup,
        state: spec.optional ? 'absent' : 'missing',
        optional: Boolean(spec.optional),
        error: '目标文件不在',
      });
      continue;
    }
    if (!existsSync(backup)) {
      results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'nobackup' });
      continue;
    }
    try {
      if (readFileSync(spec.file).equals(readFileSync(backup))) {
        results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'same' });
        continue;
      }
      copyFileSync(backup, spec.file);
      log?.info?.(`图片工坊补丁:已用备份还原 ${basename(spec.file)}`);
      results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'restored' });
    } catch (err) {
      results.push({ id: spec.id, what: spec.what, file: spec.file, backup, state: 'failed', error: msg(err) });
    }
  }
  const restored = results.filter((r) => r.state === 'restored').map((r) => r.id);
  const failed = results.filter((r) => r.state === 'failed' || r.state === 'missing').map((r) => r.id);
  const stateFile = stateDir ? join(stateDir, STATE_FILE) : '';
  if (stateFile) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, `${JSON.stringify({
        at: new Date().toISOString(),
        appRoot: resolve(appRoot),
        patched: [],
        failed,
        requested: false,
        restored,
        restoredAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
    } catch (err) {
      log?.warn?.(`图片工坊补丁:状态文件写不进去:${msg(err)}`);
    }
  }
  return { appRoot, results, restored, failed };
}

/**
 * 控制台端口：显式给了就用，否则依次读
 * `<botDir>/config.json`、`<安装>/data/home/companion/config.json`、`<工作目录>/data/home/companion/config.json`。
 */
export function consolePort({ appRoot, botDir, explicit } = {}) {
  const given = Number(explicit);
  if (Number.isInteger(given) && given > 0) return given;
  const files = [];
  if (botDir) files.push(join(botDir, 'config.json'));
  if (appRoot) files.push(join(dirname(dirname(resolve(appRoot))), 'data', 'home', 'companion', 'config.json'));
  files.push(join(process.cwd(), 'data', 'home', 'companion', 'config.json'));
  for (const file of files) {
    try {
      const port = Number(JSON.parse(readFileSync(file, 'utf8'))?.web?.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // 读不到就试下一个。
    }
  }
  return 17788;
}

/**
 * 请控制台重启进程（写 `.restart-request` 那条路：`POST /api/run/restart`）。
 * 桌宠包的 TS 补丁要重启才装载；客户端 bundle 的补丁刷新页面即可。
 */
export async function requestConsoleRestart(port, { fetchImpl = globalThis.fetch } = {}) {
  const url = `http://127.0.0.1:${port}/api/run/restart`;
  if (typeof fetchImpl !== 'function') throw new Error('这个 Node 没有 fetch');
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: res.status, url };
}

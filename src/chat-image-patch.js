/**
 * QQ 扩展里那两处「图片路径」补丁（第三方包：认不出原文就报失败，没装就跳过）。
 *
 * 为什么还需要补丁：`qq_send_image` / `qq_view_image` 的本地路径过去一律按**扩展目录**解析，
 * 于是模型拿工作区里的相对路径（如 `blobs/xx.jpg`）去发就报「本地没有这个文件」。这里改成
 * **先按桌宠工作区（`memoryDir`）解析、扩展目录兜底**，顺带把两个工具的参数说明改成同一口径
 * —— 模型只看得到工具说明。
 *
 * 桌宠包本身**不再打任何补丁**（0.3.0 起）。官方 `pet_say` 从桌宠包 0.2.0 起就收
 * `images: Array<handle>`，而本扩展 `image_draw` / `image_edit` / `image_show` 的回执本来就带
 * `blobs`，框架会把它们渲染成 `[blob …]` 句柄交给模型 —— 模型直接
 * `pet_say({ script: '', images: ['<句柄>'] })` 就能把图贴到「对话」页，不必再往桌宠包里注入工具。
 * 早先版本注入过 `pet_show_image` 与它的相对路径支持（`world.ts` 5 处 + `definition.ts` 2 处），
 * `revertObsoletePetPatches()` 负责把那样的旧安装用 `.coopanion-orig` 还原成原样。
 *
 * 这些文件都在安装目录里，而程序会自动更新、把变动覆写掉，所以每次启动都由本模块
 * 重新检查一遍：认得出的原文就改写，已经打过的跳过，认不出来就记一条失败并在控制台
 * 状态页报出来 —— 绝不猜着改。补丁一律幂等：靠 detect 文本判断。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PET_PKG = 'cortico-world-desktop-pet';
const STATE_FILE = '.chat-image-patch.json';
/** QQ 扩展（第三方包）：它的两个图片工具过去只认「相对扩展目录」。 */
const QQ_PKG = 'cortico-world-qq-better-alont1';
/** 新版第三方 QQ 扩展（qq-final，0.6.x）：发图靠正文标记 `[图片:文件名]`，只认图片库目录里的文件名。 */
const QQF_PKG = 'cortico-world-qq-final';

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
function extensionFile(appRoot, pkg, rel) {
  const cands = [];
  const override = process.env.COOPANION_EXTENSIONS_DIR;
  if (override) {
    const dir = resolve(override);
    cands.push(join(dir, 'node_modules', pkg, ...rel), join(dir, pkg, ...rel));
  }
  for (const root of [dirname(dirname(resolve(appRoot))), resolve(appRoot)]) {
    cands.push(join(root, 'data', 'extensions', 'node_modules', pkg, ...rel));
  }
  const hit = cands.find((c) => existsSync(c));
  return hit ?? cands[0] ?? '';
}

/** 旧版第三方 QQ 扩展（qq-better）的 `src/world.ts`。 */
function qqWorldFile(appRoot) {
  return extensionFile(appRoot, QQ_PKG, ['src', 'world.ts']);
}

/** 新版第三方 QQ 扩展（qq-final）里的某个源文件。 */
function qqFinalFile(appRoot, name) {
  return extensionFile(appRoot, QQF_PKG, ['src', name]);
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

/** 全部替换（同一个说法在文件里出现几次就换几次）。 */
function swapAll(text, from, to) {
  if (!text.includes(from)) return null;
  return text.split(from).join(to);
}

// ---------------------------------------------------------------------------
// 新版第三方 QQ 扩展（qq-final）：`[图片:…]` 只认图片库目录里的文件名 → 再认绝对/相对路径
// ---------------------------------------------------------------------------

/**
 * 插进 qq-final `src/normalize.ts` 的助手。
 *
 * 它的 `resolveImageFile()` 会把名字收敛在图片库目录（`imageDir`）里，绝对路径和 `..` 一律拒绝。
 * 图片工坊把图存在自己的数据目录，送过来的是绝对路径，于是只能「静默丢标记」——用户看到的是
 * 「发了但没图」。这里在**保留原图片库解析优先**的前提下加两个来源：绝对路径直接用；
 * 相对路径先按图片库目录、再按进程工作目录解析。仍然只认图片扩展名，避免被当成任意文件外传。
 */
const QQF_RESOLVE_FN = [
  '/** coopanion-chat-image: [图片:<路径>] 除了图片库文件名，还能用绝对路径或工作区相对路径。 */',
  'function resolvePathImage(fname: string, imageDir: string): string | null {',
  '  try {',
  "    let p = String(fname || '').trim();",
  '    if (!p || p.length > 1024) return null;',
  "    if (/^file:/i.test(p)) p = decodeURIComponent(p.replace(/^file:\\/\\/\\/?/i, ''));",
  '    if (!/\\.(?:gif|png|jpe?g|webp|bmp)$/i.test(p)) return null;',
  "    const bases = isAbsolute(p) || /^[a-zA-Z]:/.test(p) ? [''] : [imageDir, process.cwd()].filter(Boolean);",
  '    for (const base of bases) {',
  '      const candidate = base ? resolve(base, p) : resolve(p);',
  '      if (existsSync(candidate)) return candidate;',
  '    }',
  '    return null;',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
].join('\n');

/** 插在它后面（`buildOutgoing` 之前就定义好，函数声明提升也无所谓，但这样更好认）。 */
const QQF_FN_ANCHOR = 'export const __resolveImageFileForTest = resolveImageFile;';

/** `buildOutgoing()` 里处理 `[图片:…]` 的那一小段：原样 → 改写。 */
const QQF_BRANCH_OLD = [
  "      } else if (inner.startsWith('图片:')) {",
  "        const fname = inner.slice('图片:'.length).trim();",
  '        if (imageDir && fname) {',
  '          const p = resolveImageFile(imageDir, fname);',
  '          if (p && existsSync(p)) {',
  '            const segment = imageSegment(p);',
  '            if (segment) segments.push(segment);',
  '          }',
  '        }',
  '        // 图片库文件不存在或越界时静默丢弃该标记，不读取任意本机文件。',
].join('\n');

const QQF_BRANCH_NEW = [
  "      } else if (inner.startsWith('图片:')) {",
  "        const fname = inner.slice('图片:'.length).trim();",
  '        if (fname) {',
  '          const p = (imageDir ? resolveImageFile(imageDir, fname) : null) || resolvePathImage(fname, imageDir);',
  '          if (p) {',
  '            const segment = imageSegment(p);',
  '            if (segment) segments.push(segment);',
  '          }',
  '        }',
  '        // 补丁:先认图片库文件名,再认绝对路径与工作区相对路径。',
].join('\n');

/** 「改写过没有」看这两处都在（少一处就是半成品，下次启动会补齐）。 */
const QQF_BRANCH_MARK = '|| resolvePathImage(fname, imageDir);';

/**
 * `[图片:…]` 的标签匹配行：上游写死「方括号内最多 40 个字符」，
 * 而一个 Windows 绝对路径（`[图片:G:\…\blobs\x.png]`）动辄 60–90 个字符——
 * 正则根本匹配不到，整句原样当文本发出去，看着就像补丁没生效。
 * 这里只把「表情包: / 图片:」这两种标签放宽到 900，其它 `[..]` 仍是 40。
 */
const QQF_REGEX_OLD = String.raw`  const re = /\[([^\[\]]{1,40})\]|@([^\s@]{1,30})/g;`;
const QQF_REGEX_NEW = String.raw`  const re = /\[((?:表情包|图片):[^\[\]\n]{1,900}|[^\[\]]{1,40})\]|@([^\s@]{1,30})/g;`;
/** 认「标签行已经放宽过了」。 */
const QQF_REGEX_MARK = String.raw`(?:表情包|图片):[^\[\]\n]{1,900}`;

/**
 * qq-final `world.ts` 里那两处「[图片:文件名]」的说明（`qq_image` 的工具说明 + list 回执）。
 * 模型只看得到说明，不改就永远只写文件名、绕开补丁。
 */
const QQF_HINTS = [
  {
    from: '发送图片时先 list，再在 qq_send 的正文里使用 [图片:文件名]。',
    to: '发送图片时先 list，再在 qq_send 的正文里使用 [图片:文件名]；本机图片也可以直接写绝对路径或相对工作目录的路径。',
  },
  {
    from: '发送时把真实文件名写成 [图片:文件名]。',
    to: '发送时把真实文件名写成 [图片:文件名]；本机图片也可以写绝对路径或相对工作目录的路径，如 [图片:D:/pics/a.png]。',
  },
];


/**
 * 每个补丁：`file` 是绝对路径，`done` 说这段原文是不是已经改过了，
 * `apply` 返回新文本或 `{ error }`。全部按顺序跑，互不依赖。
 */
export function patchSpecs(appRoot) {
  const qq = qqWorldFile(appRoot);
  const qqfNormalize = qqFinalFile(appRoot, 'normalize.ts');
  const qqfWorld = qqFinalFile(appRoot, 'world.ts');
  const specs = [
    // 这两处落在第三方 QQ 扩展（qq-better）上：没装、或那个世界没开，就记 absent（不算失败）。
    // 官方 `cortico-world-qq` 发图按 blob 句柄，不解析本地路径，用不着补丁。
    { id: 'qq-image-relpaths', file: qq, what: 'QQ 发图/看图认工作区相对路径', optional: true, worldId: 'qqbot' },
    { id: 'qq-image-hints', file: qq, what: 'QQ 发图/看图的说明写明相对工作区', optional: true, worldId: 'qqbot' },
    // 新版第三方扩展（qq-final 0.6.x）发图走正文标记 `[图片:文件名]`，只认图片库目录里的名字。
    { id: 'qqf-image-paths', file: qqfNormalize, what: '新版 QQ 扩展的 [图片:…] 认绝对/相对路径', optional: true, worldId: 'qqbot' },
    { id: 'qqf-image-hints', file: qqfWorld, what: '新版 QQ 扩展的发图说明写明可以写路径', optional: true, worldId: 'qqbot' },
  ];
  return specs;
}

/**
 * 宿主配置里那个世界开没开（`worlds.<id>.enabled`）。
 *
 * 补丁改的是某个第三方扩展的源码：那个世界没在跑，改了也只是给一份不加载的文件留个备份，
 * 状态页还会写「2 处都在」——看起来像在维护一个根本不生效的东西。所以这里读一下开关。
 * 配置读不到时返回 `{ known: false, enabled: true }`：不猜，照旧打补丁。
 */
export function worldSwitch(appRoot, worldId) {
  if (!worldId) return { known: false, enabled: true };
  const files = [];
  if (appRoot) files.push(join(dirname(dirname(resolve(appRoot))), 'data', 'home', 'companion', 'config.json'));
  files.push(join(process.cwd(), 'data', 'home', 'companion', 'config.json'));
  for (const file of files) {
    try {
      const world = JSON.parse(readFileSync(file, 'utf8'))?.worlds?.[worldId];
      if (world && typeof world === 'object') return { known: true, enabled: world.enabled !== false };
    } catch {
      // 读不到就试下一个。
    }
  }
  return { known: false, enabled: true };
}

/** 一处补丁的改写规则（拆出来是为了能在副本上单测）。 */
export function rulesFor(id) {
  const nl = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
  switch (id) {
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
    // 新版第三方扩展（qq-final）：`[图片:…]` 先按图片库认，再认绝对/相对路径。
    case 'qqf-image-paths':
      return {
        // 助手在 + 那段解析确实换成调用它了 + 标签行放宽了，才算打过（少一样都是半成品）。
        done: (text) => text.includes('function resolvePathImage(') && text.includes(QQF_BRANCH_MARK) && text.includes(QQF_REGEX_MARK),
        apply: (text) => {
          let work = text;
          if (!work.includes('function resolvePathImage(')) {
            const withFn = swap(work, QQF_FN_ANCHOR, `${QQF_FN_ANCHOR}\n\n${asWritten(QQF_RESOLVE_FN, nl(work))}`);
            if (withFn === null) return { error: `没找到图片名解析的锚点：${QQF_FN_ANCHOR}` };
            work = withFn;
          }
          if (!work.includes(QQF_BRANCH_MARK)) {
            const branch = swap(work, asWritten(QQF_BRANCH_OLD, nl(work)), asWritten(QQF_BRANCH_NEW, nl(work)));
            if (branch === null) {
              return { error: `没找到 [图片:…] 那段解析（新版 QQ 扩展版本变了）：${QQF_BRANCH_OLD.split('\n')[0].trim()}` };
            }
            work = branch;
          }
          // 0.5.7：标签内最多 40 字的上游限制会让长路径整条当文本发出去，一并放宽。
          if (work.includes(QQF_REGEX_MARK)) return { text: work };
          const widened = swap(work, asWritten(QQF_REGEX_OLD, nl(work)), asWritten(QQF_REGEX_NEW, nl(work)));
          if (widened === null) return { error: `没找到 [..] 标签的匹配行：${QQF_REGEX_OLD.trim()}` };
          return { text: widened };
        },
      };
    // 说明两处：`qq_image` 的工具说明 + list 回执里那句提示。
    case 'qqf-image-hints':
      return {
        done: (text) => QQF_HINTS.every((h) => text.includes(h.to)),
        apply: (text) => {
          let work = text;
          let recognized = 0;
          for (const h of QQF_HINTS) {
            if (work.includes(h.to)) {
              recognized += 1;
              continue;
            }
            const out = swapAll(work, h.from, h.to);
            if (out !== null) {
              work = out;
              recognized += 1;
            }
          }
          if (recognized === 0) return { error: `新版 QQ 扩展的发图说明已大改，一句都认不出来：${QQF_HINTS[1].from}` };
          return { text: work };
        },
      };
    default:
      return null;
  }
}

/**
 * 0.3.0 起不再往桌宠包里打补丁。早先版本注入过 `pet_show_image`（`world.ts` 的工具与实现、
 * `definition.ts` 的自描述与工作区接线），这里把那样的安装用 `.coopanion-orig` 还原成原样。
 * 只认「文件里还有我们的标记」的文件：桌宠包自己升级过（标记没了）就一律不动。
 */
export function revertObsoletePetPatches(appRoot, { log } = {}) {
  const out = [];
  if (!appRoot) return out;
  const dir = join(appRoot, 'node_modules', PET_PKG, 'src');
  for (const name of ['world.ts', 'definition.ts']) {
    const file = join(dir, name);
    const backup = `${file}.coopanion-orig`;
    if (!existsSync(file) || !existsSync(backup)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      const ours = text.includes('coopanion-chat-image')
        || text.includes('COOPANION_CHAT_IMAGE_TOOL')
        || text.includes("name: 'pet_show_image'");
      if (!ours) continue;
      copyFileSync(backup, file);
      log?.info?.(`图片工坊补丁:桌宠包 ${name} 已还原（0.3.0 起不再注入 pet_show_image）`);
      out.push({ file, reverted: true });
    } catch (err) {
      log?.warn?.(`图片工坊补丁:桌宠包 ${name} 还原失败:${msg(err)}`);
      out.push({ file, reverted: false, error: msg(err) });
    }
  }
  return out;
}

/**
 * 检查并补齐所有补丁（先还原早先版本打在桌宠包上的旧补丁）。
 *
 * 返回 `{ appRoot, results, patched, failed, restartPending, stuck, reverted }`；
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
  const reverted = revertObsoletePetPatches(appRoot, { log });
  for (const spec of patchSpecs(appRoot)) {
    const rules = rulesFor(spec.id);
    const name = spec.file ? basename(spec.file) : '(没找到)';
    const backup = spec.file ? `${spec.file}.coopanion-orig` : '';
    // 那个世界没在跑：不改它的文件（换了官方 QQ 扩展时就是这种情形）。
    const sw = worldSwitch(appRoot, spec.worldId);
    if (sw.known && !sw.enabled) {
      results.push({
        id: spec.id,
        what: spec.what,
        file: spec.file,
        backup,
        state: 'absent',
        optional: Boolean(spec.optional),
        worldId: spec.worldId,
        error: `${spec.id}: 世界「${spec.worldId}」没启用(worlds.${spec.worldId}.enabled=false)，跳过`,
      });
      continue;
    }
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
  const changed = patched.length > 0 || reverted.some((r) => r.reverted);
  const restartPending = changed && !stuck;
  if (stateFile) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, `${JSON.stringify({
        at: new Date().toISOString(),
        appRoot: resolve(appRoot),
        patched,
        failed,
        reverted: reverted.filter((r) => r.reverted).map((r) => basename(r.file)),
        requested: restartPending || (sameApp && prev.requested === true && stuck),
      }, null, 2)}\n`, 'utf8');
    } catch (err) {
      log?.warn?.(`图片工坊补丁:状态文件写不进去:${msg(err)}`);
    }
  }
  if (stuck) {
    log?.warn?.('图片工坊补丁:上一轮已经为同一处补丁请求过重启,这次仍然缺,先不再重启;请在「图片工坊」状态页点「重打补丁」');
  }
  return { appRoot, results, patched, failed, restartPending, stuck, reverted };
}

/**
 * 每一处补丁的目标文件与它的 `.coopanion-orig` 备份的现状（状态页与 CLI 用）。
 */
export function patchBackupStatus(appRoot) {
  const out = [];
  if (!appRoot || !looksLikeApp(appRoot)) return out;
  for (const spec of patchSpecs(appRoot)) {
    const sw = worldSwitch(appRoot, spec.worldId);
    if (sw.known && !sw.enabled) continue;
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

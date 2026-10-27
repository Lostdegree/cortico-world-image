/**
 * 发布前自检：把「这个包发出去会不会被宿主接受」「包里有没有混进本机痕迹」一次查完。
 *
 * 静态部分（不联网、不需要 npm 账号、不需要装 Coopanion）：
 *   package.json 必填字段、npm 包名与版本号、`type: module`、
 *   `cortico` 声明按宿主 `src/extensions/manifest.ts` 的规则复刻校验、
 *   关键词、入口文件存在、`files` 覆盖到入口与面板产物、`cortico.describe` 指向的自描述在包里且是合法 JSON、
 *   发布物里没有 `*.coopanion-orig` / `.chat-image-patch.json` / 本机路径、
 *   每个要发布的 `.js`/`.mjs` 过一遍 `node --check`。
 *
 * 宿主相关的三套测试只在找得到**契约版本对得上**的本机 Coopanion 安装时才跑（0.1 的安装没有
 * `describe-export.ts`、契约号也更低：自动发现到这种旧安装时只提醒并跳过，不算失败；
 * 显式 `--app`/`COOPANION_APP_ROOT` 指到不支持的宿主才算失败）：
 *   `tools/check.mjs`（离线，永远跑）、`tools/patch.mjs`（补丁自测）、
 *   `tools/drymount.mts`（用框架自己的判据真跑装配检查）、
 *   `tools/describe.mts --check`（核对 describe.json 与代码里的自描述一致）。
 *
 * 跑法：
 *   node tools/prepublish.mjs                                     # 自动找宿主
 *   node tools/prepublish.mjs --app D:\Coopanion\resources\app    # 指定宿主
 *   node tools/prepublish.mjs --only-static                       # 只做静态检查
 *   node tools/prepublish.mjs --quiet-host                        # 找不到宿主不算提醒
 * 退出码：0 = 可以发；1 = 有失败项；2 = 用法/环境问题。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};
const flag = (name) => argv.includes(`--${name}`);

let passed = 0;
let warned = 0;
let failed = 0;
const ok = (line) => { passed += 1; console.log(`  ok    ${line}`); };
const bad = (line) => { failed += 1; console.log(`  FAIL  ${line}`); };
const hint = (line) => { warned += 1; console.log(`  提醒  ${line}`); };
const section = (title) => console.log(`\n${title}`);

/* 与宿主一致的判据：src/extensions/manifest.ts / extensions.ts。 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXTENSION_KINDS = ['world', 'provider', 'bot'];
const EXTENSION_API = { world: 6, provider: 6, bot: 7 };
const EXTENSION_KEYWORDS = { world: 'cortico-world', provider: 'cortico-provider', bot: 'cortico-bot' };
/** 与宿主 `describe-export.ts` 的 `DEFAULT_DESCRIBE_FILE` 一致。 */
const DEFAULT_DESCRIBE_FILE = 'describe.json';
const ICON_TYPES = ['.png', '.webp', '.svg'];

/** 包内相对路径：只用 `/`，不认盘符、`\`、`..`、空段。 */
const safeRelativeFile = (p) => typeof p === 'string' && p !== ''
  && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p)
  && !p.split('/').some((seg) => seg === '..' || seg === '');

/**
 * 不该出现在发布物里的本机痕迹。
 * 大小写敏感是有意的：文档里的通用示例 `D:\Coopanion\resources\app` 允许出现，
 * 而本机源码/安装路径是小写的盘符路径，两者用大小写区分。
 */
const PRIVATE_PATTERNS = [
  [/avemujica/i, '私有端点'],
  [/CORTICO_KEY_PICTURE/, '私有密钥变量名'],
  [/gpt-image-2/, '私有模型名'],
  [/AppData/i, '用户目录'],
  [/ms-playwright/i, '本机工具链'],
  [/[A-Za-z]:\\(coopanion|test)\\/, '本机路径'],
];

/* ---------- 要发布的文件（按 files 展开，加上 npm 永远会带的几份） ---------- */

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.add(path);
  }
}

function shippedFiles(pkg) {
  const out = new Set();
  for (const entry of pkg.files ?? []) {
    const abs = join(pkgDir, entry);
    if (!existsSync(abs)) { bad(`files 里写的「${entry}」不存在`); continue; }
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.add(abs);
  }
  for (const always of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    const abs = join(pkgDir, always);
    if (existsSync(abs)) out.add(abs);
  }
  return [...out].sort();
}

/* ---------- 静态检查 ---------- */

section(`发布前自检：${pkgDir}`);

const pkgFile = join(pkgDir, 'package.json');
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
} catch (error) {
  console.error(`  FAIL  读不了 package.json：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

section('package.json');
for (const field of ['name', 'version', 'description', 'license', 'author', 'type', 'main', 'exports', 'files', 'engines']) {
  if (pkg[field] === undefined) bad(`缺必填字段 ${field}`);
}
if (typeof pkg.name === 'string' && PACKAGE_NAME.test(pkg.name)) ok(`包名 ${pkg.name}`);
else bad(`包名不合法（宿主按 ^(@scope/)?name 校验）：${JSON.stringify(pkg.name)}`);
if (typeof pkg.version === 'string' && SEMVER.test(pkg.version)) ok(`版本 ${pkg.version}`);
else bad(`版本不是合法 semver：${JSON.stringify(pkg.version)}`);
if (pkg.type === 'module') ok('type=module（扩展必须走 ESM）');
else bad(`type 必须是 "module"，现在是 ${JSON.stringify(pkg.type)}`);
if (pkg.license && String(pkg.author ?? '').trim()) ok(`license=${pkg.license} / author=${pkg.author}`);
else hint('license 或 author 是空的：npm 页面上会显得没主');
for (const field of ['homepage', 'repository', 'bugs']) {
  if (pkg[field]) ok(`${field} 已写`);
  else hint(`没有 ${field}：npm 页面上的链接会缺一块`);
}
for (const keyword of pkg.keywords ?? []) { /* 先打印，后面按 kind 校验 */ }
ok(`keywords：${(pkg.keywords ?? []).join(', ')}`);

section('cortico 声明（宿主 manifest.ts 的口径）');
const block = pkg.cortico;
if (!block || typeof block !== 'object' || Array.isArray(block)) {
  bad('package.json 里没有对象形式的 cortico 块：宿主会拒绝加载');
} else {
  const kind = block.kind;
  const kindOk = typeof kind === 'string' && EXTENSION_KINDS.includes(kind);
  if (!kindOk) bad(`cortico.kind 必须是 ${EXTENSION_KINDS.map((k) => `"${k}"`).join(' / ')}，现在是 ${JSON.stringify(kind)}`);
  if (block.displayName !== undefined && !(typeof block.displayName === 'string' && block.displayName.trim())) {
    bad('cortico.displayName 是空的字符串：宿主会 warning 之后忽略');
  } else if (block.displayName) ok(`displayName＝${block.displayName}`);
  if (!Number.isInteger(block.api) || block.api < 1) {
    bad(`cortico.api 必须是正整数，现在是 ${JSON.stringify(block.api)}`);
  } else if (kindOk) {
    const expected = EXTENSION_API[kind];
    if (block.api !== expected) bad(`cortico.api＝${block.api}，${kind} 这一类当前契约是 ${expected}：宿主会拒绝加载`);
    else ok(`api=${block.api} 与框架的 ${kind} 契约一致`);
  }
  if (kindOk && !(pkg.keywords ?? []).includes(EXTENSION_KEYWORDS[kind])) {
    bad(`keywords 里少了 "${EXTENSION_KEYWORDS[kind]}"：控制台「扩展」页按关键词搜不到这个包`);
  } else if (kindOk) {
    ok(`keywords 含 "${EXTENSION_KEYWORDS[kind]}"`);
  }
  const client = block.webUiClient;
  /* 0.2 之前的键名：框架只认新名，旧键留着等于没声明。 */
  for (const [legacy, now] of [['consoleClient', 'webUiClient'], ['consoleStyle', 'webUiStyle']]) {
    if (block[legacy] !== undefined) bad(`cortico.${legacy} 是 0.1 的旧键名，框架 0.2 只认 cortico.${now}：改个名`);
  }
  if (client !== undefined) {
    if (!safeRelativeFile(client)) bad(`webUiClient 必须是包内相对路径（只用 /）：${JSON.stringify(client)}`);
    else if (!/\.m?js$/.test(client)) bad(`webUiClient 必须是 .js / .mjs：${client}`);
    else if (!existsSync(join(pkgDir, client))) bad(`webUiClient 指向的 ${client} 不在包里`);
    else ok(`webUiClient＝${client} 在包里`);
  } else hint('没有 webUiClient：这个扩展不会有 WebUI 面板');
  const style = block.webUiStyle;
  if (style !== undefined) {
    if (client === undefined) bad('有 webUiStyle 却没有 webUiClient：宿主会报错');
    else if (!safeRelativeFile(style) || !/\.css$/.test(style)) bad(`webUiStyle 必须是包内相对 .css：${JSON.stringify(style)}`);
    else if (!existsSync(join(pkgDir, style))) bad(`webUiStyle 指向的 ${style} 不在包里`);
    else ok(`webUiStyle＝${style} 在包里`);
  }
  const describePath = block.describe;
  if (describePath === undefined) {
    bad(`没有 cortico.describe：0.2 起自描述是必需的，宿主 check:extension 会判失败（补一个 "${DEFAULT_DESCRIBE_FILE}"）`);
  } else if (!safeRelativeFile(describePath) || !/\.json$/.test(describePath)) {
    bad(`cortico.describe 必须是包内相对 .json：${JSON.stringify(describePath)}`);
  } else if (!existsSync(join(pkgDir, describePath))) {
    bad(`cortico.describe 指向的 ${describePath} 不在包里`);
  } else {
    try {
      const describeFile = JSON.parse(readFileSync(join(pkgDir, describePath), 'utf8'));
      ok(`describe＝${describePath} 在包里且是合法 JSON（${(describeFile.tools ?? []).length} 个工具 / ${(describeFile.events ?? []).length} 个事件）`);
    } catch (error) {
      bad(`cortico.describe 指向的 ${describePath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const icon = block.icon;
  if (icon !== undefined) {
    if (!safeRelativeFile(icon) || !ICON_TYPES.some((ext) => icon.toLowerCase().endsWith(ext))) {
      bad(`cortico.icon 只认 ${ICON_TYPES.join(' / ')}：${JSON.stringify(icon)}`);
    } else if (!existsSync(join(pkgDir, icon))) bad(`icon 指向的 ${icon} 不在包里`);
    else ok(`icon＝${icon} 在包里`);
  }
}

section('入口与发布物');
const entryPoints = [];
if (typeof pkg.main === 'string') entryPoints.push(pkg.main);
for (const value of Object.values(pkg.exports ?? {})) {
  if (typeof value === 'string') entryPoints.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) if (typeof v === 'string') entryPoints.push(v);
}
const clean = (p) => String(p).replace(/^\.\//, '');
for (const entry of [...new Set(entryPoints.map(clean))]) {
  if (existsSync(join(pkgDir, entry))) ok(`入口 ${entry} 在包里`);
  else bad(`入口 ${entry} 不在包里`);
}

const shipped = shippedFiles(pkg);
const rel = (abs) => relative(pkgDir, abs).split('\\').join('/');
const shippedRel = shipped.map(rel);
const totalBytes = shipped.reduce((sum, abs) => sum + statSync(abs).size, 0);
ok(`会发布的文件 ${shipped.length} 个，展开后约 ${(totalBytes / 1024).toFixed(1)} KB`);

const mustShip = [...new Set([
  ...entryPoints.map(clean),
  ...(pkg.cortico?.webUiClient ? [clean(pkg.cortico.webUiClient)] : []),
  ...(pkg.cortico?.describe ? [clean(pkg.cortico.describe)] : []),
])];
for (const need of mustShip) {
  if (!shippedRel.includes(need)) bad(`${need} 没有被 files 覆盖：发出去的包里会缺这个文件`);
}
if (!mustShip.some((need) => !shippedRel.includes(need))) ok('入口、面板产物与自描述都在 files 里');

for (const pattern of [/\.coopanion-orig$/, /\.chat-image-patch\.json$/, /\.env$/i, /\.log$/i]) {
  const hits = shippedRel.filter((file) => pattern.test(file));
  for (const hit of hits) bad(`发布物里不该有 ${hit}`);
}

/* 隐私串：只查真正会发出去的文件。跳过这个脚本自己——上面那张模式表就写着这些串。 */
const SELF = fileURLToPath(import.meta.url);
let privateHits = 0;
for (const abs of shipped) {
  if (abs === SELF) continue;
  if (!/\.(js|mjs|cjs|json|md|mts|ts|css|txt)$/.test(abs)) continue;
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (const [pattern, what] of PRIVATE_PATTERNS) {
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      privateHits += 1;
      bad(`${rel(abs)}:${i + 1} 出现${what}：${line.trim().slice(0, 100)}`);
    });
  }
}
if (privateHits === 0) ok('没有本机路径 / 私有端点 / 补丁备份之类的痕迹');

section('语法');
let checked = 0;
for (const abs of shipped) {
  if (!/\.m?js$/.test(abs)) continue;
  checked += 1;
  const res = spawnSync(process.execPath, ['--check', abs], { stdio: 'inherit' });
  if (res.status !== 0) bad(`node --check 没过：${rel(abs)}`);
}
ok(`${checked} 个 .js/.mjs 过了 node --check`);

/* ---------- 宿主相关：先离线那份，再跑要安装的那两份 ---------- */

const stateFile = join(pkgDir, '.chat-image-patch.json');
const hadStateFile = existsSync(stateFile);

function runSuite(title, args, env) {
  section(title);
  const res = spawnSync(process.execPath, args, { cwd: pkgDir, stdio: 'inherit', env: { ...process.env, ...env } });
  if (res.status === 0) { ok(`${args.join(' ')} 通过`); return true; }
  bad(`${args.join(' ')} 退出码 ${res.status}`);
  return false;
}

runSuite('离线检查（tools/check.mjs）', [join('tools', 'check.mjs')]);

const hostManifest = join('build', 'cortico', 'src', 'extensions', 'manifest.ts');
const hostDescribe = join('build', 'cortico', 'src', 'extensions', 'describe-export.ts');

/** 宿主 `manifest.ts` 里 `EXTENSION_API_VERSIONS.world` 声明的契约号；读不出来算 0。 */
function hostDeclaredWorld(root) {
  try {
    const text = readFileSync(join(root, hostManifest), 'utf8');
    const at = text.indexOf('EXTENSION_API_VERSIONS');
    const m = at >= 0 ? /world:\s*(\d+)/.exec(text.slice(at, at + 400)) : null;
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

/**
 * 宿主能不能跑后面三项：既要有 0.2 才有的 `describe-export.ts`，
 * 声明的 world 契约号也要和本包一致（0.1 的安装是 v5）。
 */
function hostUsable(root) {
  if (!root || !existsSync(join(root, hostManifest)) || !existsSync(join(root, hostDescribe))) return false;
  const want = Number(block.api ?? 0);
  return !want || hostDeclaredWorld(root) === want;
}

const explicitApp = opt('app') || process.env.COOPANION_APP_ROOT || '';
const appRoot = explicitApp || (() => {
  let dir = pkgDir;
  for (let i = 0; i < 8; i += 1) {
    const cand = join(dir, 'resources', 'app');
    if (existsSync(join(cand, hostManifest))) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
})();

/** 为什么跳过宿主那三项；空串＝能跑。 */
const skipReason = (() => {
  if (!appRoot) return '没找到本机 Coopanion 安装（用 --app <安装>\\resources\\app 指一下）';
  if (!hostUsable(appRoot)) {
    return `宿主 ${appRoot} 只声明 world 契约 v${hostDeclaredWorld(appRoot) || '?'}，本包要 v${block.api}`
      + '（0.1 的安装没有 describe-export.ts）：用 --app <安装>\\resources\\app 或环境变量 COOPANION_APP_ROOT 指到 0.2 的安装';
  }
  return '';
})();

if (flag('only-static')) {
  hint('--only-static：跳过补丁自测、dry-mount 与自描述核对');
} else if (skipReason) {
  if (explicitApp) bad(skipReason);
  else if (flag('quiet-host')) console.log(`宿主相关三项跳过：${skipReason}`);
  else hint(`${skipReason}：跳过补丁自测、dry-mount 与自描述核对`);
} else {
  console.log(`\n宿主：${appRoot}`);
  runSuite('补丁自测（tools/patch.mjs）', [join('tools', 'patch.mjs'), '--app', appRoot], { COOPANION_APP_ROOT: appRoot });
  runSuite('dry-mount（tools/drymount.mts）', ['--experimental-transform-types', join('tools', 'drymount.mts')], { COOPANION_APP_ROOT: appRoot });
  runSuite('自描述核对（tools/describe.mts --check）', ['--experimental-transform-types', join('tools', 'describe.mts'), '--check'], { COOPANION_APP_ROOT: appRoot });
}

if (!hadStateFile && existsSync(stateFile)) {
  rmSync(stateFile, { force: true });
  hint('跑测试时生成的 .chat-image-patch.json 已删（它带着本机的 appRoot，不进包）');
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
if (failed) console.log('先修完再发：npm publish 之前这一关必须全绿。');
else console.log('静态检查全绿。接着 `npm pack --dry-run` 看一眼包内容，再 `npm publish`。');
process.exit(failed === 0 ? 0 : 1);

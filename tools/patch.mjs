#!/usr/bin/env node
/**
 * 「对话页发图」补丁的工具：自测 / 落盘 / 验证 / 重启。
 *
 *   node tools/patch.mjs              在副本上自测（幂等、语法、坏原文必须报失败、还原）
 *   node tools/patch.mjs --apply      打到真实安装上（默认自动找 resources/app）
 *   node tools/patch.mjs --restart    请控制台重启，让桌宠那一侧的补丁装载
 *   node tools/patch.mjs --backups    看每处补丁与它的 .coopanion-orig 备份
 *   node tools/patch.mjs --restore    按备份还原（撤销补丁；可逆，之后能再打）
 *
 * 补丁会在每次启动时自动检查/重打（程序自动更新覆写后自愈）；
 * `--restore` 是手动撤销，`--apply` 是手动重打，面板上也有对应按钮。
 *
 * `--app <目录>` 指定 `resources/app`，默认从本扩展所在的那份安装往上找；
 * `--port <端口>` 指定控制台端口，默认读 `<安装>/data/home/companion/config.json` 的 web.port。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyChatImagePatches, consolePort, patchBackupStatus, requestConsoleRestart, resolveAppRoot, restoreChatImagePatches, rulesFor } from '../src/chat-image-patch.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const wantApply = flag('apply');
const wantRestart = flag('restart');
const wantRestore = flag('restore');
const wantBackups = flag('backups') || flag('backup');
const wantSelfTest = !wantApply && !wantRestart && !wantRestore && !wantBackups;

const PACKAGE_DIR = resolve(import.meta.dirname, '..');
const here = (...p) => join(PACKAGE_DIR, ...p);

let pass = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const head = (s) => console.log(`\n${s}`);

function findAppRoot() {
  return opt('app') ? resolve(opt('app')) : resolveAppRoot([PACKAGE_DIR, process.cwd()]);
}

/** 取「没打过补丁」的那一份：改写前留下的 `.coopanion-orig` 就是原文，没有就用文件本身。 */
function pristine(src) {
  const orig = `${src}.coopanion-orig`;
  return existsSync(orig) ? orig : src;
}

/** esbuild 只做语法解析（不解析依赖、不打包）；loader 按扩展名自动认。 */
let syntaxSeq = 0;
function syntaxCheck(appRoot, file, loader) {
  const bin = join(appRoot, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  if (!existsSync(bin)) return { skipped: true };
  syntaxSeq += 1;
  const out = join(tmpdir(), `coopanion-esbuild-${process.pid}-${syntaxSeq}-${basename(file)}.js`);
  const res = spawnSync(bin, [file, '--format=esm', `--outfile=${out}`, '--log-level=warning'], { stdio: ['ignore', 'inherit', 'inherit'] });
  try {
    rmSync(out, { force: true });
  } catch { /* 忽略 */ }
  return { code: res.status, signal: res.signal, error: res.error ? String(res.error) : '' };
}

/**
 * 真跑一遍打过补丁的 `tools()` 那句 `return …;`。
 *
 * 为什么必须真跑：那句 return 的原文是 `.map(…)`（本身就是数组），
 * 曾经被包成 `[EXPR, TOOL]` → 嵌套数组，框架读出来的 6 个老工具名全变 null。
 * 这里配桩用 node 真执行那句表达式，断言结果是**扁平**数组、每项都有名字、含 pet_show_image。
 */
function toolsReturnHarness(worldFile) {
  const text = readFileSync(worldFile, 'utf8');
  const at = /tools\(\): ToolDef\[\] \{/.exec(text);
  if (!at) return { ok: false, reason: '没找到 tools() 方法' };
  const seg = text.slice(at.index, at.index + 3000);
  const rm = /^([ \t]*)return ([^\n]*);$/m.exec(seg);
  if (!rm) return { ok: false, reason: '没找到 tools() 里的 return' };
  // 那句 return 会引用方法体里前面声明的局部量（桌宠 0.1.23 起是 `const own = petToolDecls(…)`）。
  // 桩里把它们都声明成「两个假工具」的数组：真跑时若还有没桩到的名字，报错才说明补丁真的坏了。
  const locals = [...seg.slice(0, rm.index).matchAll(/^[ \t]*const ([A-Za-z_$][\w$]*)\s*=/gm)]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i);
  const dir = mkdtempSync(join(tmpdir(), 'coopanion-tools-return-'));
  const file = join(dir, 'run.mjs');
  const report = join(dir, 'out.json');
  writeFileSync(
    file,
    [
      "import { writeFileSync } from 'node:fs';",
      "const DESKTOP_PET_TOOL_DECLS = [{ name: 'pet_say' }, { name: 'pet_ask' }];",
      "const petToolDecls = () => [{ name: 'pet_say' }, { name: 'pet_ask' }];",
      'const handlers = { pet_say: () => {}, pet_ask: () => {}, pet_walk_to: () => {} };',
      "const CHAT_IMAGE_TOOL = { name: 'pet_show_image' };",
      ...locals.map((name) => `const ${name} = petToolDecls('zh');`),
      "const world = { appLanguage: 'zh', cuaOn: false, cua: { tools: () => [] }, showImage: () => ({ text: 'ok' }) };",
      `const out = (function () { return ${rm[2]}; }).call(world);`,
      'writeFileSync(process.argv[2], JSON.stringify({',
      '  isArray: Array.isArray(out),',
      "  names: Array.isArray(out) ? out.map((d) => (d && typeof d.name === 'string' ? d.name : null)) : String(out).slice(0, 80),",
      '}));',
    ].join('\n'),
  );
  // 用文件而不是管道传结果：沙箱里子进程开管道会 EPERM。
  const res = spawnSync(process.execPath, [file, report], { stdio: ['ignore', 'inherit', 'inherit'] });
  let out = null;
  try {
    out = JSON.parse(readFileSync(report, 'utf8'));
  } catch { /* 下面统一报错 */ }
  rmSync(dir, { recursive: true, force: true });
  if (!out) return { ok: false, reason: `桩没跑出结果（exit ${res.status}）` };
  if (!out.isArray) return { ok: false, reason: `tools() 返回的不是数组：${out.names}` };
  const nameless = out.names.filter((n) => !n);
  if (nameless.length) return { ok: false, reason: `有 ${nameless.length} 项没名字（工具被嵌套包了一层？）：${JSON.stringify(out.names)}` };
  if (!out.names.includes('pet_show_image')) return { ok: false, reason: `少了 pet_show_image：${JSON.stringify(out.names)}` };
  return { ok: out.names.length >= 3, names: out.names, reason: out.names.length >= 3 ? '' : `工具太少：${JSON.stringify(out.names)}` };
}

/**
 * 副本自测里那棵「假 QQ 扩展」：真安装上是 2400 多行 TS，这里只留补丁要认的那几行
 * （类声明、两处相对路径解析、三处工具说明）。自测不进网络、不碰真安装。
 */
const QQ_FIXTURE_TS = [
  "import { existsSync } from 'node:fs';",
  "import { isAbsolute, join } from 'node:path';",
  'export const qqViewImage = {',
  "  name: 'qq_view_image',",
  "  parameters: [{ name: 'url', description: '可选：直接给图片链接（事件里带的图）或本地文件路径；给了就不再翻缓冲。' }],",
  '};',
  'export const qqSendImage = {',
  "  name: 'qq_send_image',",
  "  description: '给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。',",
  "  parameters: [{ name: 'image', description: '本地文件路径（绝对路径，或相对扩展目录）或 http(s) 链接。' }],",
  '};',
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
].join('\n');

/** 把假 QQ 扩展摆进 `<fakeext>/node_modules/<包>/src/world.ts`（配合 COOPANION_EXTENSIONS_DIR）。 */
function writeFakeQQ(fakeext, text = QQ_FIXTURE_TS) {
  const dir = join(fakeext, 'node_modules', 'cortico-world-qq-better-alont1', 'src');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'world.ts');
  writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * 真跑一遍补丁插进 QQ 扩展的那支 `resolveLocalImagePath`：相对路径先落桌宠工作区，
 * 工作区没有才退到扩展目录（没有工作区时退回老行为）。用真 fs + 临时目录，不碰安装。
 */
function qqResolveHarness(patchedText) {
  const m = /\n(\/\*\* coopanion-chat-image[\s\S]*?\n\})/.exec(patchedText);
  if (!m) return { ok: false, reason: '抽不出 resolveLocalImagePath' };
  // 抽出来的是 TS，node 直接跑要先去掉类型标注（补丁里只有这一处 `: string`）。
  const fnJs = m[1].replace(/:\s*string/g, '');
  const dir = mkdtempSync(join(tmpdir(), 'coopanion-qq-resolve-'));
  const ws = join(dir, 'ws');
  const ext = join(dir, 'ext');
  mkdirSync(join(ws, 'blobs'), { recursive: true });
  mkdirSync(join(ext, 'blobs'), { recursive: true });
  writeFileSync(join(ws, 'blobs', 'only-ws.jpg'), 'a');
  writeFileSync(join(ext, 'blobs', 'only-ext.jpg'), 'b');
  const file = join(dir, 'run.mjs');
  const report = join(dir, 'out.json');
  writeFileSync(
    file,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { isAbsolute, join } from 'node:path';",
      m[1] && fnJs,
      'writeFileSync(process.argv[2], JSON.stringify({',
      "  abs: resolveLocalImagePath('C:/somewhere/pic.png', process.argv[3], process.argv[4]),",
      "  onlyWs: resolveLocalImagePath('blobs/only-ws.jpg', process.argv[3], process.argv[4]),",
      "  onlyExt: resolveLocalImagePath('blobs/only-ext.jpg', process.argv[3], process.argv[4]),",
      "  none: resolveLocalImagePath('blobs/nope.jpg', process.argv[3], process.argv[4]),",
      "  noWs: resolveLocalImagePath('blobs/nope.jpg', '', process.argv[4]),",
      '}));',
    ].join('\n'),
  );
  const res = spawnSync(process.execPath, [file, report, ws, ext], { stdio: ['ignore', 'inherit', 'inherit'] });
  let out = null;
  try {
    out = JSON.parse(readFileSync(report, 'utf8'));
  } catch { /* 下面统一报错 */ }
  if (!out) return { ok: false, reason: `没跑出结果（exit ${res.status}）` };
  const done = { ok: true, ws, ext, ...out };
  rmSync(dir, { recursive: true, force: true });
  return done;
}

/** 把打过补丁的 `showImage()` 抽出来、真跑：相对路径要落到桌宠工作区上。 */
function showImageHarness(appRoot, worldText) {
  const bin = join(appRoot, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  if (!existsSync(bin)) return { skipped: `找不到 esbuild：${bin}` };
  const head = '  private async showImage(args: Record<string, unknown>): Promise<ToolOutcome> {';
  const at = worldText.indexOf(head);
  if (at < 0) return { ok: false, reason: '抽不到 showImage()（pet-show-image-tool 没打上?）' };
  const stop = worldText.indexOf('\n  }\n', at);
  if (stop < 0) return { ok: false, reason: 'showImage() 的结尾找不到' };
  const method = worldText.slice(at, stop + 4);
  const sniffHead = 'function sniffImageMime(bytes: Buffer): string | null {';
  const sniffAt = worldText.indexOf(sniffHead);
  if (sniffAt < 0) return { ok: false, reason: '抽不到 sniffImageMime()' };
  const sniffStop = worldText.indexOf('\n}\n', sniffAt);
  if (sniffStop < 0) return { ok: false, reason: 'sniffImageMime() 的结尾找不到' };
  const sniff = worldText.slice(sniffAt, sniffStop + 2);

  const dir = mkdtempSync(join(tmpdir(), 'coopanion-show-image-'));
  const ws = join(dir, 'ws');
  const ext = join(dir, 'ext');
  mkdirSync(join(ext, 'blobs'), { recursive: true });
  const script = join(dir, 'run.mts');
  const report = join(dir, 'report.json');
  writeFileSync(
    script,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';

type ToolOutcome = { text: string; failed?: boolean };
const IMAGE_MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

${sniff}

const WS = ${JSON.stringify(ws)};
const EXT = ${JSON.stringify(ext)};

class Pet {
  host: unknown = null;
  chat = { size: 0 };
  opts: { workspaceDir?: () => string } = {};
  constructor(opts: { workspaceDir?: () => string }) { this.opts = opts; }
  private async record(..._args: unknown[]): Promise<number | null> { return 1; }
${method}
}

const out: Record<string, string> = { ext: EXT };
mkdirSync(join(WS, 'blobs'), { recursive: true });
writeFileSync(join(WS, 'blobs', 'ok.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
const withWs = () => new Pet({ workspaceDir: () => WS });
out.relMissing = (await withWs().showImage({ path: 'blobs/nope.jpg' })).text;
out.relFound = (await withWs().showImage({ path: 'blobs/ok.png' })).text;
out.abs = (await withWs().showImage({ path: join(WS, 'blobs', 'ok.png') })).text;
out.noWs = (await new Pet({}).showImage({ path: 'blobs/ok.png' })).text;
writeFileSync(${JSON.stringify(report)}, JSON.stringify(out, null, 2));
`,
  );
  // 用 esbuild 编成 JS 再让 node 跑：tsx 起 esbuild 服务要 spawn 管道，沙箱里会 EPERM。
  const compiled = join(dir, 'run.mjs');
  const built = spawnSync(bin, [script, '--format=esm', `--outfile=${compiled}`, '--log-level=error'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (built.status !== 0) return { ok: false, reason: `esbuild 编不过抽出来的 showImage()（exit ${built.status}）` };
  const res = spawnSync(process.execPath, [compiled], { stdio: ['ignore', 'inherit', 'inherit'] });
  let out = null;
  try {
    out = JSON.parse(readFileSync(report, 'utf8'));
  } catch { /* 下面统一报错 */ }
  if (!out) return { ok: false, reason: `node 没跑出结果（exit ${res.status}）` };
  const done = { ok: true, ws, ext, ...out };
  rmSync(dir, { recursive: true, force: true });
  return done;
}

/** 副本上自测：结构照抄一份真安装，只把要改的两个文件（world.ts + definition.ts）复制过去。 */
function selfTest(appRoot) {
  head(`自测（副本，源目录 ${appRoot}）`);
  const work = mkdtempSync(join(tmpdir(), 'coopanion-chat-image-'));
  const petSrc = join(appRoot, 'node_modules', 'cortico-world-desktop-pet', 'src');
  const petDst = join(work, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(petDst, { recursive: true });
  mkdirSync(join(work, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(work, 'build', 'cortico', 'src', 'paths.ts'), 'export function repoRoot(): string { return "stub"; }\n');
  copyFileSync(pristine(join(petSrc, 'world.ts')), join(petDst, 'world.ts'));
  copyFileSync(pristine(join(petSrc, 'definition.ts')), join(petDst, 'definition.ts'));

  // 可选补丁落在第三方 QQ 扩展上（真安装在 `<安装>/data/extensions/…`）：
  // 这里用 COOPANION_EXTENSIONS_DIR 指到副本里的一棵假扩展，不碰真安装。
  const fakeext = join(work, 'fakeext');
  const qqFile = writeFakeQQ(fakeext);
  process.env.COOPANION_EXTENSIONS_DIR = fakeext;

  const stateDir = join(work, 'state');
  const first = applyChatImagePatches(work, { stateDir });
  ok(first.appRoot === resolve(work), '认出这份 app', String(first.appRoot));
  ok(first.results.length === 8, '一共 8 处补丁（含 2 处可选的 QQ 扩展）', `实际 ${first.results.length}`);
  ok(first.failed.length === 0, '全部改写成功', first.results.filter((r) => r.state !== 'patched').map((r) => `${r.id}:${r.state}:${r.error ?? ''}`).join(' / '));
  ok(first.patched.length === 8 && first.restartPending === true, '第一轮：8 处新打，并请求重启', JSON.stringify(first.patched));
  ok(existsSync(`${qqFile}.coopanion-orig`), 'QQ 扩展也留了原文备份', qqFile);
  const qqCheck = syntaxCheck(appRoot, qqFile);
  ok(qqCheck.skipped || qqCheck.code === 0, 'QQ 扩展改完能过 TS 语法', JSON.stringify(qqCheck));
  const definition = readFileSync(join(petDst, 'definition.ts'), 'utf8');
  ok(definition.includes("workspaceDir: () => join(ctx.botDir, 'workspace'),"), 'definition.ts：把桌宠工作区传给世界（装配层那行）', definition.split('\n').filter((l) => l.includes('workspaceDir')).join(' | '));
  ok(existsSync(join(petDst, 'definition.ts.coopanion-orig')), 'definition.ts 也留了原文备份');

  const second = applyChatImagePatches(work, { stateDir });
  ok(second.patched.length === 0 && second.restartPending === false, '第二轮：幂等，无事可做');
  ok(second.results.every((r) => r.state === 'done'), '第二轮：全部认成「已打过」', second.results.map((r) => `${r.id}:${r.state}`).join(' '));

  // 认不出原文（第三方扩展改了写法）时必须报失败、不能瞎改。
  const stranger = rulesFor('qq-image-relpaths').apply("export const nope = 1;\n");
  ok(Boolean(stranger?.error), 'QQ 扩展换了写法就报失败，不瞎改', JSON.stringify(stranger));
  for (const id of ['pet-workspace-option', 'pet-workspace-relpaths', 'pet-workspace-wire']) {
    const junk = rulesFor(id).apply("export const nope = 1;\n");
    ok(Boolean(junk?.error), `${id} 换了写法就报失败，不瞎改`, JSON.stringify(junk));
  }

  // 按备份还原 → 再打一次：可选补丁也要能来回。
  const backQQ = restoreChatImagePatches(work, { stateDir });
  ok(backQQ.restored.some((id) => id.startsWith('qq-')) && readFileSync(qqFile, 'utf8') === QQ_FIXTURE_TS, 'QQ 扩展能按备份还原回原文', JSON.stringify(backQQ.restored));
  const reQQ = applyChatImagePatches(work, { stateDir });
  ok(reQQ.patched.includes('qq-image-relpaths') && reQQ.failed.length === 0, '还原之后还能重新打上', JSON.stringify(reQQ.patched));

  const qqRun = qqResolveHarness(readFileSync(qqFile, 'utf8'));
  ok(qqRun.ok, '把插入的助手抽出来真跑一遍', qqRun.reason);
  if (qqRun.ok) {
    ok(qqRun.abs === 'C:/somewhere/pic.png', '绝对路径原样返回', qqRun.abs);
    ok(qqRun.onlyWs === join(qqRun.ws, 'blobs', 'only-ws.jpg'), '相对路径落在桌宠工作区', qqRun.onlyWs);
    ok(qqRun.onlyExt === join(qqRun.ext, 'blobs', 'only-ext.jpg'), '工作区没有、扩展目录才有 → 退到扩展目录（老行为）', qqRun.onlyExt);
    ok(qqRun.none === join(qqRun.ws, 'blobs', 'nope.jpg'), '两边都没有 → 按工作区拼（报错里给出工作区路径）', qqRun.none);
    ok(qqRun.noWs === join(qqRun.ext, 'blobs', 'nope.jpg'), '装配层没给工作区时退回老行为', qqRun.noWs);
  }
  delete process.env.COOPANION_EXTENSIONS_DIR;

  // 自愈的第二幕：自动更新把文件覆写回去 → 再补一遍；已经请求过一轮重启还是缺，就记「卡住」不再请求（防重启死循环）。
  const work2 = mkdtempSync(join(tmpdir(), 'coopanion-chat-image-stuck-'));
  const pet2 = join(work2, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(pet2, { recursive: true });
  mkdirSync(join(work2, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(work2, 'build', 'cortico', 'src', 'paths.ts'), 'export function repoRoot(): string { return "stub"; }\n');
  copyFileSync(pristine(join(petSrc, 'world.ts')), join(pet2, 'world.ts'));
  copyFileSync(pristine(join(petSrc, 'definition.ts')), join(pet2, 'definition.ts'));
  const state2 = join(work2, 'state');
  const again1 = applyChatImagePatches(work2, { stateDir: state2 });
  ok(again1.patched.length === 6 && again1.restartPending === true && again1.stuck === false, '自愈第一幕：打上 6 处并请求一次重启', JSON.stringify({ patched: again1.patched.length, pending: again1.restartPending, stuck: again1.stuck }));
  copyFileSync(pristine(join(petSrc, 'world.ts')), join(pet2, 'world.ts'));
  const again2 = applyChatImagePatches(work2, { stateDir: state2 });
  ok(again2.patched.includes('pet-workspace-option') && again2.failed.length === 0, '自愈第二幕：被覆写后照样补回来', JSON.stringify(again2.patched));
  ok(again2.restartPending === false && again2.stuck === true, '自愈第二幕：请求过重启仍缺 → 记卡住、不再重启', JSON.stringify({ pending: again2.restartPending, stuck: again2.stuck }));
  const saved2 = JSON.parse(readFileSync(join(state2, '.chat-image-patch.json'), 'utf8'));
  ok(saved2.requested === true && saved2.appRoot === resolve(work2) && Array.isArray(saved2.patched) && saved2.patched.includes('pet-workspace-option'), '状态文件记下「请求过重启 + 这次补了哪些」', JSON.stringify(saved2));
  rmSync(work2, { recursive: true, force: true });

  // 还原：按 `.coopanion-orig` 把文件覆盖回去（备份留着），随后再自动补一遍照样能补上。
  const work3 = mkdtempSync(join(tmpdir(), 'coopanion-chat-image-restore-'));
  const pet3 = join(work3, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(pet3, { recursive: true });
  mkdirSync(join(work3, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(work3, 'build', 'cortico', 'src', 'paths.ts'), 'export function repoRoot(): string { return "stub"; }\n');
  copyFileSync(pristine(join(petSrc, 'world.ts')), join(pet3, 'world.ts'));
  copyFileSync(pristine(join(petSrc, 'definition.ts')), join(pet3, 'definition.ts'));
  const state3 = join(work3, 'state');
  const before3 = applyChatImagePatches(work3, { stateDir: state3 });
  ok(before3.patched.length === 6 && before3.failed.length === 0, '还原前：6 处都打上了', JSON.stringify({ patched: before3.patched.length, failed: before3.failed }));
  const bk3 = patchBackupStatus(work3);
  ok(bk3.length === 6 && bk3.every((b) => b.hasFile && b.hasBackup && b.patched && !b.same), '备份状态：6 处都有原文备份、都认成「已打过」', JSON.stringify(bk3.map((b) => `${b.id}:${b.hasBackup}/${b.patched}/${b.same}`)));
  const back3 = restoreChatImagePatches(work3, { stateDir: state3 });
  // 6 处补丁落在 2 个文件上：每个文件还原一次，同一文件上后面的补丁就变成「本来就是原文」。
  ok(back3.failed.length === 0 && back3.restored.length === 2 && back3.results.filter((r) => r.state !== 'absent').every((r) => r.state === 'restored' || r.state === 'same'), '还原：2 个文件各按备份覆盖一次（同一文件上的其余补丁认成 same）', JSON.stringify({ restored: back3.restored, states: back3.results.map((r) => `${r.id}:${r.state}`) }));
  ok(readFileSync(join(pet3, 'world.ts'), 'utf8') === readFileSync(pristine(join(petSrc, 'world.ts')), 'utf8'), '还原后 world.ts 与原文逐字一致');
  ok(readFileSync(join(pet3, 'definition.ts'), 'utf8') === readFileSync(pristine(join(petSrc, 'definition.ts')), 'utf8'), '还原后 definition.ts 与原文逐字一致');
  const bk3b = patchBackupStatus(work3);
  ok(bk3b.every((b) => b.hasBackup && b.same && !b.patched), '还原后：备份还在，状态变成「未打」', JSON.stringify(bk3b.map((b) => `${b.id}:${b.hasBackup}/${b.same}/${b.patched}`)));
  const saved3 = JSON.parse(readFileSync(join(state3, '.chat-image-patch.json'), 'utf8'));
  ok(Array.isArray(saved3.restored) && saved3.restored.length === 2 && saved3.patched.length === 0 && saved3.requested === false, '状态文件记下「还原了哪些」', JSON.stringify({ restored: saved3.restored, patched: saved3.patched, requested: saved3.requested }));
  const back3b = restoreChatImagePatches(work3, { stateDir: state3 });
  ok(back3b.restored.length === 0 && back3b.results.filter((r) => r.state !== 'absent').every((r) => r.state === 'same'), '再还原一次：认成「本来就是原文」，不重复覆盖');
  const after3 = applyChatImagePatches(work3, { stateDir: state3 });
  ok(after3.patched.length === 6 && after3.failed.length === 0, '还原之后还能重新打上（还原是可逆的）', JSON.stringify({ patched: after3.patched.length, failed: after3.failed }));
  rmSync(work3, { recursive: true, force: true });

  const world = readFileSync(join(petDst, 'world.ts'), 'utf8');
  ok(world.includes('pet_show_image') && world.includes('sniffImageMime') && world.includes("tags: ['act']"), 'world.ts：pet_show_image 工具与实现');
  ok(world.includes('workspaceDir?: () => string;'), 'world.ts：世界选项多了 workspaceDir（装配层注入）');
  ok(world.includes("    let raw = typeof args.path === 'string' ? args.path.trim() : '';"), 'world.ts：路径那行改成 let（不然相对路径拼不上）');
  ok(world.includes('raw = join(ws, raw);') && world.includes('this.opts.workspaceDir?.()'), 'world.ts：相对路径真的拼到桌宠工作区上');
  ok(world.includes('blobs/xx.jpg'), 'world.ts：工具说明写明可以给相对工作区的路径');
  ok(existsSync(join(petDst, 'world.ts.coopanion-orig')), '改写前留了 .coopanion-orig 备份');
  ok(readFileSync(join(petDst, 'world.ts.coopanion-orig'), 'utf8') === readFileSync(pristine(join(petSrc, 'world.ts')), 'utf8'), '备份是改写前的原文');
  const worldTools = toolsReturnHarness(join(petDst, 'world.ts'));
  ok(worldTools.ok, 'tools() 真跑一遍：扁平数组、每项都有名字、含 pet_show_image', worldTools.reason || JSON.stringify(worldTools.names));

  const showRun = showImageHarness(appRoot, world);
  if (showRun.skipped) console.log(`  ..   ${showRun.skipped}`);
  else if (!showRun.ok) ok(false, '把 showImage() 抽出来真跑一遍', showRun.reason);
  else {
    ok(showRun.relMissing.includes(join(showRun.ws, 'blobs', 'nope.jpg')) && !showRun.relMissing.includes(showRun.ext), '相对路径按桌宠工作区解析（不是扩展目录）', showRun.relMissing);
    ok(showRun.relFound.includes('没连着对话记录'), '工作区里真有那张图时读得到（走到「没连着对话记录」）', showRun.relFound);
    ok(showRun.abs.includes('没连着对话记录'), '绝对路径照旧能用', showRun.abs);
    ok(showRun.noWs.includes('相对路径没有工作区可拼'), '装配层没给工作区时明确报错', showRun.noWs);
  }

  const s2 = syntaxCheck(appRoot, join(petDst, 'world.ts'), 'ts');
  const s4 = syntaxCheck(appRoot, join(petDst, 'definition.ts'), 'ts');
  if (s2.skipped) console.log('  ..   esbuild 不在，跳过语法检查');
  else {
    ok(s2.code === 0, 'world.ts 语法通过（esbuild）', s2.error || String(s2.code));
    ok(s4.code === 0, 'definition.ts 语法通过（esbuild）', s4.error || String(s4.code));
  }

  // 反向用例：原文被改过时必须报失败，而不是硬猜着改。
  const bad = join(work, 'bad');
  const badPet = join(bad, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(badPet, { recursive: true });
  mkdirSync(join(bad, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(bad, 'build', 'cortico', 'src', 'paths.ts'), 'export function repoRoot(): string { return "stub"; }\n');
  writeFileSync(join(badPet, 'world.ts'), readFileSync(pristine(join(petSrc, 'world.ts')), 'utf8').replace('  private notConnected(tool: string): ToolOutcome {', '  private notConnectedRenamed(tool: string): ToolOutcome {'));
  writeFileSync(join(badPet, 'definition.ts'), readFileSync(pristine(join(petSrc, 'definition.ts')), 'utf8'));
  const third = applyChatImagePatches(bad, { stateDir: join(bad, 'state') });
  ok(third.failed.includes('pet-show-image-tool'), '原文对不上时记失败：pet-show-image-tool', JSON.stringify(third.failed));
  ok(third.results.find((r) => r.id === 'pet-show-image-tool')?.state === 'failed' && third.results.find((r) => r.id === 'pet-show-image-tool')?.error, '失败项状态是 failed 并给出原因', JSON.stringify(third.results.find((r) => r.id === 'pet-show-image-tool')));
  ok(third.patched.length === 4, '同一份文件里别的补丁照常打上（world.ts 里不依赖 showImage() 的那几条）', JSON.stringify(third.patched));

  // 上一版写坏的 `[EXPR, TOOL]`（嵌套数组）要能被认出来并修成扁平的。
  const work4 = mkdtempSync(join(tmpdir(), 'coopanion-chat-image-nested-'));
  const pet4 = join(work4, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(pet4, { recursive: true });
  mkdirSync(join(work4, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(work4, 'build', 'cortico', 'src', 'paths.ts'), 'export function repoRoot(): string { return "stub"; }\n');
  copyFileSync(pristine(join(petSrc, 'definition.ts')), join(pet4, 'definition.ts'));
  const nestedWorld = (() => {
    const src = readFileSync(pristine(join(petSrc, 'world.ts')), 'utf8');
    const at4 = /tools\(\): ToolDef\[\] \{/.exec(src);
    const seg4 = src.slice(at4.index, at4.index + 3000);
    const rm4 = /^([ \t]*)return ([^\n]*);$/m.exec(seg4);
    const line = `${rm4[1]}return [${rm4[2]}, { ...CHAT_IMAGE_TOOL, handler: (args) => this.showImage(args) }];`;
    return src.slice(0, at4.index + rm4.index) + line + src.slice(at4.index + rm4.index + rm4[0].length);
  })();
  writeFileSync(join(pet4, 'world.ts'), nestedWorld);
  const fixed4 = applyChatImagePatches(work4, { stateDir: join(work4, 'state') });
  ok(fixed4.failed.length === 0 && fixed4.results.find((r) => r.id === 'pet-show-image-tool')?.state === 'patched', '旧的嵌套写法认成「没打」并重写（不是当成已完成）', JSON.stringify({ failed: fixed4.failed, state: fixed4.results.find((r) => r.id === 'pet-show-image-tool')?.state }));
  const fixedTools = toolsReturnHarness(join(pet4, 'world.ts'));
  ok(fixedTools.ok, '旧嵌套写法被修成扁平数组', fixedTools.reason || JSON.stringify(fixedTools.names));
  const again4 = applyChatImagePatches(work4, { stateDir: join(work4, 'state') });
  ok(again4.patched.length === 0 && again4.failed.length === 0, '修好之后再跑一遍是幂等的', JSON.stringify({ patched: again4.patched, failed: again4.failed }));
  rmSync(work4, { recursive: true, force: true });

  rmSync(work, { recursive: true, force: true });
  return failures.length === 0;
}

/** 控制台端口：优先命令行，其次安装里的 config.json。 */
function consolePortOf(appRoot) {
  return consolePort({ appRoot, botDir: join(PACKAGE_DIR, '..', 'data', 'home', 'companion'), explicit: opt('port') });
}

function apply(appRoot) {
  head(`落盘（${appRoot}）`);
  const res = applyChatImagePatches(appRoot, { stateDir: PACKAGE_DIR, log: { info: (m) => console.log(`  ..   ${m}`), warn: (m) => console.log(`  !!   ${m}`) } });
  for (const r of res.results) console.log(`  ${r.state.padEnd(8)} ${r.id}  ${basename(r.file ?? '')}${r.error ? ` — ${r.error}` : ''}`);
  ok(res.failed.length === 0, '没有失败项', res.failed.join(', '));
  if (res.patched.length) console.log(`  改了 ${res.patched.length} 处；桌宠侧的改动要重启进程才装载${res.restartPending ? '' : '（这次不自动重启）'}`);
  else console.log('  没有要改的：补丁都在。');
  if (res.stuck) console.log('  !!   上一轮已经为同一处请求过重启，这次仍然缺——先别重启，查文件是不是只读。');
  return res;
}

/** 看每一处补丁的目标文件与它的 `.coopanion-orig`（更新下发的原文）现状。 */
function backups(appRoot) {
  head(`备份状态（${appRoot}）`);
  const rows = patchBackupStatus(appRoot);
  if (!rows.length) return ok(false, '认不出这份安装里的补丁目标文件');
  for (const r of rows) {
    const state = r.patched ? '已打' : '未打';
    const b = r.hasBackup ? `备份 ${r.backupBytes}B${r.same ? '（=当前文件）' : `，覆盖于 ${r.backupAt}`}` : '没有备份';
    console.log(`  ${state}  ${r.id.padEnd(20)} ${basename(r.file ?? '')}  ${r.fileBytes}B  ${b}${r.hasFile ? '' : '  ← 文件不在'}`);
  }
  const missing = rows.filter((r) => !r.hasFile);
  const noBackup = rows.filter((r) => r.patched && !r.hasBackup);
  ok(missing.length === 0, '所有目标文件都在', missing.map((r) => r.id).join(', '));
  ok(noBackup.length === 0, '打过补丁的每一处都留着更新下发的原文备份', noBackup.map((r) => r.id).join(', '));
  const neverPatched = rows.filter((r) => !r.patched && !r.hasBackup);
  if (neverPatched.length) console.log(`  ..   还没打过、因此没有备份（正常）：${neverPatched.map((r) => r.id).join(', ')}`);
  console.log('  备份就在文件旁边：<文件>.coopanion-orig；还原只是拿它覆盖回去，备份不会删。');
  return rows;
}

/** 手动还原：用备份把补丁覆盖掉（可逆，下次启动或 --apply 会再补上）。 */
function restore(appRoot) {
  head(`按备份还原（${appRoot}）`);
  const res = restoreChatImagePatches(appRoot, {
    stateDir: PACKAGE_DIR,
    log: { info: (m) => console.log(`  ..   ${m}`), warn: (m) => console.log(`  !!   ${m}`) },
  });
  for (const r of res.results) console.log(`  ${r.state.padEnd(8)} ${r.id}  ${basename(r.file ?? '')}${r.error ? ` — ${r.error}` : ''}`);
  ok(res.failed.length === 0, '没有还原失败的文件', res.failed.join(', '));
  if (res.restored.length) console.log(`  还原了 ${res.restored.length} 个文件；重启控制台后桌宠就回到「没有发图功能」的原样。`);
  else console.log('  没有要还原的：文件本身就是更新下发的原文。');
  return res;
}

const appRoot = findAppRoot();
if (!appRoot) {
  console.error('找不到 Coopanion 的 resources/app；用 --app <目录> 指定。');
  process.exit(2);
}
console.log(`安装：${appRoot}`);

if (wantSelfTest) selfTest(appRoot);
if (wantBackups) backups(appRoot);
if (wantRestore) restore(appRoot);
if (wantApply) apply(appRoot);
if (wantRestart) {
  const port = consolePortOf(appRoot);
  head(`重启控制台（端口 ${port}）`);
  try {
    const res = await requestConsoleRestart(port);
    ok(res.status >= 200 && res.status < 300, `POST ${res.url} → ${res.status}`);
  } catch (err) {
    ok(false, '重启请求没能送达', err instanceof Error ? err.message : String(err));
  }
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项${failures.length ? `：${failures.join('；')}` : ''}`);
process.exit(failures.length ? 1 : 0);

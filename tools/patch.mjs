#!/usr/bin/env node
/**
 * QQ 发图路径补丁的工具：自测 / 落盘 / 验证 / 重启。
 *
 *   node tools/patch.mjs              在副本上自测（幂等、备份、还原、坏原文必须报失败、旧桌宠补丁能还原）
 *   node tools/patch.mjs --apply      打到真实安装上（默认自动找 resources/app）
 *   node tools/patch.mjs --restart    请控制台重启，让 QQ 扩展那侧的补丁装载
 *   node tools/patch.mjs --backups    看每处补丁与它的 .coopanion-orig 备份
 *   node tools/patch.mjs --restore    按备份还原（撤销补丁；可逆，之后能再打）
 *
 * 0.3.0 起只改第三方 QQ 扩展的 `src/world.ts`（两处），桌宠包一个字节都不动：
 * 贴图改用官方的 `pet_say.images`。早先版本打进桌宠包的旧补丁，会在每次启动时按备份还原。
 *
 * 补丁会在每次启动时自动检查/重打（程序自动更新覆写后自愈）；
 * `--restore` 是手动撤销，`--apply` 是手动重打，面板上也有对应按钮。
 *
 * `--app <目录>` 指定 `resources/app`，默认从本扩展所在的那份安装往上找；
 * `--port <端口>` 指定控制台端口，默认读 `<安装>/data/home/companion/config.json` 的 web.port。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyChatImagePatches, consolePort, patchBackupStatus, patchSpecs, requestConsoleRestart, resolveAppRoot, restoreChatImagePatches, rulesFor } from '../src/chat-image-patch.js';

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
const QQ_PKG = 'cortico-world-qq-better-alont1';

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

/** QQ 扩展 `src/world.ts` 里我们认得的那些行（真安装 0.1.17 的写法）。 */
const QQ_FIXTURE = [
  "import { existsSync } from 'node:fs';",
  "import { isAbsolute, join } from 'node:path';",
  '',
  'const DECLS = [',
  "  { name: 'qq_send_image', description: '给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。',",
  "    parameters: [{ name: 'image', description: '本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。' }] },",
  "  { name: 'qq_view_image', parameters: [{ name: 'url', description: '可选：直接给图片链接（事件里带的图）或本地文件路径；给了就不再翻缓冲。' }] },",
  '];',
  '',
  'export class QQWorld implements World {',
  "  private packageDir = '.';",
  "  private config = { memoryDir: 'ws' };",
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

/** 临时搭一份「像 resources/app」的目录：框架标记 + 桌宠包 + 假 QQ 扩展。 */
function makeFakeApp(root, { qqText = QQ_FIXTURE } = {}) {
  const app = join(root, 'resources', 'app');
  mkdirSync(join(app, 'build', 'cortico', 'src'), { recursive: true });
  writeFileSync(join(app, 'build', 'cortico', 'src', 'paths.ts'), 'export {};\n');
  const petDir = join(app, 'node_modules', 'cortico-world-desktop-pet', 'src');
  mkdirSync(petDir, { recursive: true });
  writeFileSync(join(petDir, 'world.ts'), 'export class DesktopPetWorld {}\n');
  const qqDir = join(app, 'data', 'extensions', 'node_modules', QQ_PKG, 'src');
  mkdirSync(qqDir, { recursive: true });
  const qq = join(qqDir, 'world.ts');
  if (qqText !== null) writeFileSync(qq, qqText);
  return { app, petDir, qq };
}

/** 让副本里也能有宿主配置（`worlds.<id>.enabled`）——补丁只为开着的世界打。 */
function writeWorldSwitch(app, worlds) {
  const dir = join(app, '..', '..', 'data', 'home', 'companion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ web: { port: 17788 }, worlds }, null, 2)}\n`);
}

function selfTest() {
  const work = mkdtempSync(join(tmpdir(), 'image-patch-'));
  try {
    head('补丁清单');
    const specs = patchSpecs(join(work, 'resources', 'app'));
    const ids = specs.map((s) => s.id);
    ok(specs.length === 2, '只有 2 处补丁（桌宠包上不再打补丁）', String(specs.length));
    ok(ids.includes('qq-image-relpaths') && ids.includes('qq-image-hints'), '两处都是 QQ 扩展的', ids.join(','));
    ok(specs.every((s) => s.optional === true), '两处都是可选补丁（没装 QQ 扩展不算失败）');
    ok(specs.every((s) => s.file.includes(QQ_PKG) && s.file.endsWith('world.ts')), '都落在 QQ 扩展的 src/world.ts', JSON.stringify(specs.map((s) => s.file)));
    ok(specs.every((s) => s.worldId === 'qqbot'), '两处都挂在 world「qqbot」上（切到官方 QQ 扩展后自动跳过）', JSON.stringify(specs.map((s) => s.worldId)));
    ok(specs.every((s) => typeof s.what === 'string' && s.what.length > 4), '每处都有说明');

    head('改写规则（单文件）');
    const rel = rulesFor('qq-image-relpaths');
    ok(typeof rel?.done === 'function' && typeof rel?.apply === 'function', 'qq-image-relpaths 有 done/apply');
    ok(Boolean(rel.apply('export const nope = 1;\n')?.error), '认不出原文时报失败，不瞎改');
    const relOut = rel.apply(QQ_FIXTURE);
    ok(!relOut?.error, '打卡片上的原文能改出来', relOut?.error ?? '');
    ok((relOut?.text ?? '').includes('function resolveLocalImagePath(p: string, memoryDir: string, packageDir: string): string {'), '插进了按工作区解析的助手');
    ok((relOut?.text ?? '').includes('const p = resolveLocalImagePath(image, this.config.memoryDir, this.packageDir);'), '发图那行改成按工作区解析');
    ok((relOut?.text ?? '').includes('const p = resolveLocalImagePath(url, this.config.memoryDir, this.packageDir);'), '看图那行改成按工作区解析');
    ok(rel.done(relOut?.text ?? ''), '改完认成「已打过」（幂等）');
    ok((relOut?.text ?? '').includes("import { existsSync } from 'node:fs';") && (relOut?.text ?? '').includes("import { isAbsolute, join } from 'node:path';"), '本来就够的导入不动一行');

    const hints = rulesFor('qq-image-hints');
    ok(typeof hints?.done === 'function' && typeof hints?.apply === 'function', 'qq-image-hints 有 done/apply');
    ok(Boolean(hints.apply('export const nope = 1;\n')?.error), '一句都认不出来时报失败');
    const hintOut = hints.apply(QQ_FIXTURE);
    ok(!hintOut?.error, '三处说明都能改出来', hintOut?.error ?? '');
    ok((hintOut?.text ?? '').includes('本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）或 http(s) 链接。'), '发图参数说明改成「绝对路径或相对工作区」');
    ok((hintOut?.text ?? '').includes('或本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）；给了就不再翻缓冲。'), '看图参数说明同步');
    ok((hintOut?.text ?? '').includes('`image` 给本地文件路径（绝对路径，或相对桌宠工作区的路径，如 blobs/xx.jpg）或 http(s) 链接'), '工具总说明同步');
    ok(hints.done(hintOut?.text ?? ''), '改完认成「已打过」（幂等）');
    // 上游把某一句整句换掉：跳过那一处，不算失败（否则每次启动都记一条失败）。
    const reworded = QQ_FIXTURE.replace("'本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。'", "'图片本地路径或链接。'");
    const partial = hints.apply(reworded);
    ok(!partial?.error && (partial?.text ?? '').includes('给了就不再翻缓冲。'), '上游换掉一句时只跳过那一处，不算失败', partial?.error ?? '');

    head('落盘 / 备份 / 还原（副本）');
    const a1 = makeFakeApp(join(work, 'run1'));
    const first = applyChatImagePatches(a1.app, { stateDir: join(work, 'state1') });
    ok(first.patched.length === 2, '两处都打上了（文件形式）', JSON.stringify(first.results.map((r) => `${r.id}:${r.state}`)));
    ok(first.failed.length === 0, '没有失败项', first.failed.join(','));
    const onDisk = readFileSync(a1.qq, 'utf8');
    ok(onDisk.includes('resolveLocalImagePath(image, this.config.memoryDir'), '磁盘上那份真的改了');
    ok(existsSync(`${a1.qq}.coopanion-orig`) && readFileSync(`${a1.qq}.coopanion-orig`, 'utf8') === QQ_FIXTURE, '改写前留了原文备份（.coopanion-orig）');
    ok(first.restartPending === true, '第一次改过文件 → 请求重启');

    const second = applyChatImagePatches(a1.app, { stateDir: join(work, 'state1') });
    ok(second.patched.length === 0 && second.failed.length === 0, '再跑一遍是幂等的（0 改动、0 失败）', JSON.stringify({ patched: second.patched, failed: second.failed }));
    ok(second.results.every((r) => r.state === 'done'), '两处都记 done', JSON.stringify(second.results.map((r) => r.state)));
    ok(second.restartPending === false, '没改东西就不请求重启');

    const rows = patchBackupStatus(a1.app);
    ok(rows.length === 2 && rows.every((r) => r.patched && r.hasBackup && !r.same), '备份状态：两处都「已打 + 有备份 + 与当前不同」', JSON.stringify(rows.map((r) => `${r.id}:${r.patched}/${r.hasBackup}/${r.same}`)));

    const back = restoreChatImagePatches(a1.app, { stateDir: join(work, 'state1') });
    ok(back.restored.length === 1 && !back.failed.length, '按备份还原了 1 个文件', JSON.stringify({ restored: back.restored, failed: back.failed }));
    ok(readFileSync(a1.qq, 'utf8') === QQ_FIXTURE, '还原后与原文逐字节一致');
    const reapply = applyChatImagePatches(a1.app, { stateDir: join(work, 'state1') });
    ok(reapply.patched.length === 2, '还原之后还能再打回去（可逆）', JSON.stringify(reapply.patched));

    head('没装 / 改坏了 QQ 扩展');
    const a2 = makeFakeApp(join(work, 'run2'), { qqText: null });
    const noQq = applyChatImagePatches(a2.app, { stateDir: join(work, 'state2') });
    ok(noQq.failed.length === 0 && noQq.results.every((r) => r.state === 'absent'), '没装 QQ 扩展时两处记 absent、不算失败', JSON.stringify(noQq.results.map((r) => `${r.id}:${r.state}`)));
    ok(!noQq.restartPending, '没装 QQ 扩展时不请求重启');

    const a3 = makeFakeApp(join(work, 'run3'), { qqText: 'export class QQWorld { /* 上游大改 */ }\n' });
    const broken = applyChatImagePatches(a3.app, { stateDir: join(work, 'state3') });
    ok(broken.failed.length === 2, '认不出原文时两处都记失败', JSON.stringify(broken.results.map((r) => `${r.id}:${r.state}`)));
    ok(readFileSync(a3.qq, 'utf8') === 'export class QQWorld { /* 上游大改 */ }\n', '认不出就不动那个文件');
    ok(existsSync(`${a3.qq}.coopanion-orig`) === false, '没改成也就不会留备份');

    head('旧桌宠补丁的还原（0.3.0）');
    const a4 = makeFakeApp(join(work, 'run4'));
    const petFile = join(a4.petDir, 'world.ts');
    const petPristine = 'export class DesktopPetWorld {}\n';
    writeFileSync(petFile, `${petPristine}/* coopanion-chat-image: pet_show_image 的旧补丁 */\n`);
    writeFileSync(`${petFile}.coopanion-orig`, petPristine);
    const rev = applyChatImagePatches(a4.app, { stateDir: join(work, 'state4') });
    ok(rev.reverted.some((r) => r.reverted), '桌宠包上的旧补丁被还原', JSON.stringify(rev.reverted));
    ok(readFileSync(petFile, 'utf8') === petPristine, '桌宠包回到上游原样（一个字节都没留）');
    ok(rev.restartPending === true, '还原也算「这次改了东西」→ 请求重启');
    const revAgain = applyChatImagePatches(a4.app, { stateDir: join(work, 'state4') });
    ok(revAgain.reverted.every((r) => !r.reverted), '还原过一次之后不再重复还原');

    head('世界没开时跳过（切到官方 QQ 扩展）');
    const a5 = makeFakeApp(join(work, 'run5'));
    writeWorldSwitch(a5.app, { qqbot: { enabled: false }, qq: { enabled: true } });
    const off = applyChatImagePatches(a5.app, { stateDir: join(work, 'state5') });
    ok(off.results.length === 2 && off.results.every((r) => r.state === 'absent'), 'qqbot 关掉时两处都记 absent', JSON.stringify(off.results.map((r) => `${r.id}:${r.state}`)));
    ok(off.results.every((r) => /worlds\.qqbot\.enabled=false/.test(r.error ?? '')), 'absent 里写明是「世界没开」', JSON.stringify(off.results.map((r) => r.error)));
    ok(!readFileSync(a5.qq, 'utf8').includes('resolveLocalImagePath'), '文件一个字节都没动');
    ok(!existsSync(`${a5.qq}.coopanion-orig`), '也不会平白留一份备份');
    ok(off.restartPending === false, '不请求重启');
    ok(patchBackupStatus(a5.app).length === 0, '状态页的备份行也不显示它');

    const a6 = makeFakeApp(join(work, 'run6'));
    writeWorldSwitch(a6.app, { qqbot: { enabled: true } });
    const on = applyChatImagePatches(a6.app, { stateDir: join(work, 'state6') });
    ok(on.patched.length === 2, 'qqbot 开着时照常打上', JSON.stringify(on.results.map((r) => `${r.id}:${r.state}`)));
    ok(patchBackupStatus(a6.app).length === 2, '开着时备份状态两行');

    head('控制台端口');
    const cfgApp = join(work, 'port');
    mkdirSync(join(cfgApp, 'data', 'home', 'companion'), { recursive: true });
    writeFileSync(join(cfgApp, 'data', 'home', 'companion', 'config.json'), JSON.stringify({ web: { port: 18099 } }));
    ok(consolePort({ appRoot: join(cfgApp, 'resources', 'app') }) === 18099, '端口从 <安装>/data/home/companion/config.json 读出来');
    ok(consolePort({ appRoot: join(cfgApp, 'resources', 'app'), explicit: 12345 }) === 12345, '显式 --port 优先');
    ok(consolePort({ appRoot: join(work, 'nope') }) === 17788, '读不到就回默认 17788');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return failures.length === 0;
}

/** 真安装上那两处补丁的现状（不改动任何东西，只读）。 */
function inspectReal(appRoot) {
  const spec = patchSpecs(appRoot)[0];
  if (!spec?.file || !existsSync(spec.file)) return;
  const text = readFileSync(pristine(spec.file), 'utf8');
  head(`真安装上的 QQ 扩展（${basename(spec.file)}）`);
  const rel = rulesFor('qq-image-relpaths');
  const hints = rulesFor('qq-image-hints');
  ok(rel.done(text) || rel.apply(text)?.text, 'qq-image-relpaths 认得这份原文（不认识的只是版本变了，记在状态页）');
  ok(hints.done(text) || hints.apply(text)?.text, 'qq-image-hints 认得这份原文');
}

/** 控制台端口：优先命令行，其次安装里的 config.json。 */
function consolePortOf(appRoot) {
  return consolePort({ appRoot, botDir: join(PACKAGE_DIR, '..', 'data', 'home', 'companion'), explicit: opt('port') });
}

function apply(appRoot) {
  head(`落盘（${appRoot}）`);
  const res = applyChatImagePatches(appRoot, { stateDir: PACKAGE_DIR, log: { info: (m) => console.log(`  ..   ${m}`), warn: (m) => console.log(`  !!   ${m}`) } });
  for (const r of res.results) console.log(`  ${r.state.padEnd(8)} ${r.id}  ${basename(r.file ?? '')}${r.error ? ` — ${r.error}` : ''}`);
  for (const r of res.reverted ?? []) if (r.reverted) console.log(`  还原     ${basename(r.file)}（旧桌宠补丁）`);
  ok(res.failed.length === 0, '没有失败项', res.failed.join(', '));
  if (res.patched.length || res.reverted.some((r) => r.reverted)) {
    console.log(`  改了 ${res.patched.length} 处；QQ 扩展那侧的改动要重启进程才装载${res.restartPending ? '' : '（这次不自动重启）'}`);
  } else console.log('  没有要改的：补丁都在。');
  if (res.stuck) console.log('  !!   上一轮已经为同一处请求过重启，这次仍然缺——先别重启，查文件是不是只读。');
  return res;
}

/** 看每一处补丁的目标文件与它的 `.coopanion-orig`（更新下发的原文）现状。 */
function backups(appRoot) {
  head(`备份状态（${appRoot}）`);
  const rows = patchBackupStatus(appRoot);
  if (!rows.length) return ok(false, '认不出这份安装里的补丁目标文件（QQ 扩展可能没装）');
  for (const r of rows) {
    const state = r.patched ? '已打' : '未打';
    const b = r.hasBackup ? `备份 ${r.backupBytes}B${r.same ? '（=当前文件）' : `，覆盖于 ${r.backupAt}`}` : '没有备份';
    console.log(`  ${state}  ${r.id.padEnd(20)} ${basename(r.file ?? '')}  ${r.fileBytes}B  ${b}${r.hasFile ? '' : '  ← 文件不在'}`);
  }
  ok(rows.filter((r) => !r.hasFile).length === 0, '所有目标文件都在', rows.filter((r) => !r.hasFile).map((r) => r.id).join(', '));
  ok(rows.filter((r) => r.patched && !r.hasBackup).length === 0, '打过补丁的每一处都留着更新下发的原文备份');
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
  if (res.restored.length) console.log(`  还原了 ${res.restored.length} 个文件；重启控制台后 QQ 发图回到「只认扩展目录的相对路径」。`);
  else console.log('  没有要还原的：文件本身就是更新下发的原文。');
  return res;
}

const appRoot = findAppRoot();
if (!appRoot && !wantSelfTest) {
  console.error('找不到 Coopanion 的 resources/app；用 --app <目录> 指定。');
  process.exit(2);
}
if (appRoot) console.log(`安装：${appRoot}`);

if (wantSelfTest) {
  selfTest();
  if (appRoot) inspectReal(appRoot);
  else console.log('\n（没找到装在附近的 Coopanion，跳过真安装上的只读检查）');
}
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

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
process.exit(failures.length ? 1 : 0);

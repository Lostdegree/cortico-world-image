/**
 * describe.json（框架 0.2 的自描述）生成与核对：
 *   node --experimental-transform-types tools/describe.mts          生成（内容真变了才写盘）并核对
 *   node --experimental-transform-types tools/describe.mts --check  只核对，不写盘
 *
 * 判据直接读这套安装里的框架源码（`<安装>/resources/app/build/cortico/src/extensions/`），不靠手抄：
 * `parseExtensionManifest()` 过 manifest、`exportDescribe()` 从定义生成自描述、
 * `checkDescribe()` 复核包里那份与代码一致、`dryMountWorld()` 在假部署里造实例查工具与配置路径。
 * 框架位置按 `COOPANION_APP_ROOT` → 从本包往上找 `resources/app` 的顺序定位；
 * 用 tsx 跑会因为 esbuild 起子进程被沙箱拦（spawn EPERM）；node 自带的类型擦除不吃参数属性，
 * 所以必须带 --experimental-transform-types。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const checkOnly = process.argv.includes('--check');
const scratchDir = mkdtempSync(join(tmpdir(), 'image-describe-'));

/** 找这套安装的 `resources/app`：显式变量优先，其次从本包目录往上找。 */
function findAppRoot(): string {
  const explicit = process.env.COOPANION_APP_ROOT;
  if (explicit && existsSync(join(explicit, 'build', 'cortico', 'src', 'extensions', 'dry-mount.ts'))) return explicit;
  let dir = pkgDir;
  for (let i = 0; i < 8; i += 1) {
    const cand = join(dir, 'resources', 'app');
    if (existsSync(join(cand, 'build', 'cortico', 'src', 'extensions', 'dry-mount.ts'))) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

const appRoot = findAppRoot();
if (!appRoot) {
  console.error('找不到这套安装的 resources/app —— 用 COOPANION_APP_ROOT 指一下（例如 D:\\Coopanion\\resources\\app）');
  process.exit(2);
}
const frameworkDir = join(appRoot, 'build', 'cortico', 'src', 'extensions');
const { checkDescribe, exportDescribe, DEFAULT_DESCRIBE_FILE } = await import(pathToFileURL(join(frameworkDir, 'describe-export.ts')).href);
const { EXTENSION_API_VERSIONS, parseExtensionManifest } = await import(pathToFileURL(join(frameworkDir, 'manifest.ts')).href);
const { dryMountWorld } = await import(pathToFileURL(join(frameworkDir, 'dry-mount.ts')).href);

let passed = 0;
let warned = 0;
let failed = 0;
const ok = (line: string): void => { passed++; console.log(`  ok    ${line}`); };
const bad = (line: string): void => { failed++; console.log(`  FAIL  ${line}`); };
const hint = (line: string): void => { warned++; console.log(`  提醒  ${line}`); };

try {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const { default: def } = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
  const opts = { scratchDir, packageDir: pkgDir };

  console.log('manifest');
  const parsed = parseExtensionManifest(manifest);
  if (!parsed.ok) bad(`框架解析 manifest 失败：${parsed.reasons.join('；')}`);
  else {
    const expected = EXTENSION_API_VERSIONS[parsed.manifest.kind];
    ok(`框架解析 manifest 通过（kind=${parsed.manifest.kind}，api=${parsed.manifest.api}，框架期望 ${expected}）`);
    if (parsed.manifest.api !== expected) bad(`api=${parsed.manifest.api} 与框架的 ${expected} 不等，装配层会拒绝加载。`);
    if (parsed.manifest.id !== undefined && def?.id !== parsed.manifest.id) {
      bad(`manifest 里的 id（${parsed.manifest.id}）与 def.id（${def?.id}）不一致`);
    }
    const client = parsed.manifest.webUiClient;
    if (client && !existsSync(join(pkgDir, client))) bad(`manifest 声明的 ${client} 不在包里`);
    else if (client) ok(`manifest 声明的面板产物 ${client} 在包里`);
    else hint('manifest 没有声明 webUiClient：这个 World 没有浏览器面板。');
  }
  for (const warning of parsed.warnings ?? []) hint(warning);

  console.log('\n自描述');
  const file = await exportDescribe('world', def, opts);
  if (!file) {
    bad('定义里没有 describe：框架 0.2 起每个 World 都要声明全部工具与事件。');
  } else {
    const rel = manifest.cortico?.describe ?? DEFAULT_DESCRIBE_FILE;
    const target = join(pkgDir, rel);
    const next = `${JSON.stringify(file, null, 2)}\n`;
    const toolNames = (file.tools ?? []).map((tool) => tool.name);
    ok(`定义生成的工具表：${toolNames.length ? toolNames.join(', ') : '(空)'}；事件表：${(file.events ?? []).length} 个`);
    if (checkOnly) {
      if (!existsSync(target)) bad(`${rel} 不存在（去掉 --check 生成它）`);
      else ok(`${rel} 在包里（${readFileSync(target, 'utf8').length} 字节）`);
    } else if (existsSync(target) && readFileSync(target, 'utf8') === next) {
      ok(`${rel} 已是最新，未改动`);
    } else {
      writeFileSync(target, next);
      ok(`写入 ${rel}（${next.length} 字节）`);
    }
    const report = await checkDescribe('world', def, manifest.cortico?.describe, opts);
    for (const line of report.ok) ok(line);
    for (const line of report.warnings) hint(line);
    for (const line of report.failures) bad(line);
  }

  console.log('\n假部署装配');
  const report = await dryMountWorld(def, { ...opts, hasWebUiClient: Boolean(manifest.cortico?.webUiClient) });
  for (const line of report.ok) ok(line);
  for (const line of report.warnings) hint(line);
  for (const line of report.failures) bad(line);
} catch (error) {
  bad(`未捕获的异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);

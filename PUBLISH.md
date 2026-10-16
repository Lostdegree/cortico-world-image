# 发布流程（维护者用）

这个仓库既是 GitHub 上的源码，也是一个 npm 包 `cortico-world-image`。
Coopanion 的控制台「设置 → 扩展」页就是从 npm registry 搜包、读包文档、按版本装到 `<安装目录>\data\extensions\` 的，
所以「发布」就是把这里的源码原样推到 registry 上。

本文件只给维护者看，**不会被打进 tarball**（不在 `package.json` 的 `files` 里）。

---

## 1. 三个目录，各是干什么的

| 目录 | 角色 | 谁改它 |
| --- | --- | --- |
| 开发/自测副本 | 平时写代码、跑测试的地方（同一个 npm 包名，本地 `link:` 装进 Coopanion 用） | 改代码就在这里改 |
| 本仓库（GitHub） | **源码真相**：脱敏后的代码 + 文档，`git push` 的对象 | 从开发副本同步过来，再改文档/元数据 |
| 发布目录 | `npm publish` 的根：每次发布**整份重刷**，里面不留手工改动 | 只由脚本从本仓库同步 |

三个目录的内容必须一致，差别只在于：开发副本可能还带着运行期文件（`.chat-image-patch.json`、`*.coopanion-orig`）、
本仓库多 `.git`/`.gitignore`/`PUBLISH.md`、发布目录两者都没有。

```powershell
# 下文的两个变量，按自己的机器改
$SRC = 'D:\src\cortico-world-image'      # 本仓库（源码真相）
$NPM = 'D:\src\npm'                      # 发布目录（npm publish 的根）
```

---

## 2. 一次性准备

### 2.1 npm 账号

```powershell
npm login                 # 浏览器/OTP 双因子按提示走
npm whoami                # 打印用户名才算登录成功
```

* 没登录时 `npm publish` 会报 `E401 Unauthorized`；`npm whoami` 也是 `E401`。
* 账号开了 2FA 的话，发布会要求 OTP；CI 用 Automation Token，见 §6.1。
* 包名属于账号作用域：`cortico-world-image` 已经被本账号占用后，别人再发同名包会被拒（`E403`）。

### 2.2 确认包名没被别人抢

```powershell
npm view cortico-world-image version
```

* 干净地 404（`E404`）＝ 名字可用。
* 返回版本号＝已存在。要么换名字，要么你就是所有者（那就继续发新版本）。
* 想确认 registry 本身通不通：`npm view cortico-world-memory version` 应该打印出一个版本号。

### 2.3 registry

扩展的安装走宿主自己读到的 registry（`pnpm config get registry`），
用户的机器上可能是国内镜像（`npmmirror` 之类）。**发布必须显式指向 npmjs**，否则可能推到镜像的私有空间：

```powershell
npm config get registry                       # 期望 https://registry.npmjs.org/
npm publish --registry https://registry.npmjs.org/    # 或者每次显式带上
```

### 2.4 缓存目录

npm 的默认缓存可能在受限目录里（受管环境、沙箱里会 `EPERM`）。先试 `npm ping`，
通了就不用管；报错就把缓存挪到可写目录：

```powershell
$env:npm_config_cache = "$PWD\.npm-cache"
npm ping                                      # 期望 PONG
```

---

## 3. 从本仓库刷到发布目录

发布目录是纯产物，**整份重刷**（别在里面手改，改了下次就被覆盖）：

```powershell
robocopy $SRC $NPM /MIR /XD .git /XF .gitignore .gitattributes PUBLISH.md
```

没有 `robocopy` 就用：

```powershell
Remove-Item "$NPM\*" -Recurse -Force
Copy-Item "$SRC\*" $NPM -Recurse -Force -Exclude '.gitignore','.gitattributes','PUBLISH.md'
```

刷完**逐文件对一遍哈希**，确认两边一模一样：

```powershell
Get-ChildItem $SRC -Recurse -File |
  Where-Object { $_.Name -notin '.gitignore','.gitattributes','PUBLISH.md' } |
  ForEach-Object {
    $rel = $_.FullName.Substring($SRC.Length + 1)
    $dst = Join-Path $NPM $rel
    if (-not (Test-Path $dst)) { "MISSING $rel" }
    elseif ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash $dst).Hash) { "DIFF    $rel" }
  }
```

---

## 4. 发布前自检

```powershell
node tools/prepublish.mjs                       # 自动找本机 Coopanion 安装
node tools/prepublish.mjs --app D:\Coopanion\resources\app
node tools/prepublish.mjs --only-static         # 只做静态检查（CI / 没装 Coopanion）
```

它会：

1. 按宿主 `src/extensions/manifest.ts` 的同一套规则验 `package.json`：
   `type: module`、`cortico.kind`/`cortico.api`（`world` 这一类当前是 **api 6**，旧了或新了宿主都拒收）、
   `webUiClient` 是包内相对路径且文件真在、`describe` 指向包内 `describe.json` 且是合法 JSON、
   `keywords` 里有 `cortico-world`（否则控制台搜不到这个包）。
2. 按 `files` 展开一遍发布物，确认入口（`main`/`exports`）、面板产物与自描述都真的在里面。
3. 扫隐私：本机绝对路径、私有端点、私有密钥变量名、`.coopanion-orig`、`.chat-image-patch.json` 之类。
4. 每个 `.js`/`.mjs` 过一遍 `node --check`。
5. 跑离线检查 `tools/check.mjs`；找得到 Coopanion 安装时再跑 `tools/patch.mjs` 自测、`tools/drymount.mts`（用框架自己的判据真跑装配）与 `tools/describe.mts --check`（自描述与代码是否一致）。

退出码 `0` = 可以发；`1` = 有失败项，修完再来。`prepublishOnly` 也挂了同一个脚本，
所以 `npm publish` 会先自动跑它——**它没过就不会发包**。

再看一眼包内容（不会真的发）：

```powershell
npm pack --dry-run
```

要看的点：

* 文件数/体积合理（`dist/webui.js` 是浏览器面板，几百 KB 以内）。
* **没有** `.chat-image-patch.json`、`*.coopanion-orig`、`.npm-cache`、`tools/_probe-*.mjs` 这类东西。
* `README.md`、`LICENSE`、`src/`、`dist/`、`tools/`、`ENV_PROMPT.md`、`describe.json` 都在。

离线只想跑脚本、不想打 tarball 的话：`npm run selfcheck`。

---

## 5. 抬版本

```powershell
# package.json 里的 version 三处（本仓库、发布目录同步出来的那份）必须同一个值
```

* 口径：修 bug / 改文案 = patch（`0.2.0` → `0.2.1`）；加配置项、加工具、加补丁 = minor。
* **同一个版本号不能发第二次**（`E403`/`E409`：`cannot publish over previously published version`）。
  发错了只能换号，或者 24 小时内 `npm unpublish cortico-world-image@0.2.0`（见 §9）。
* 控制台的资源 URL 里带版本（`/assets/extensions/cortico-world-image/<版本>/webui.js`），
  所以**改控制台面板（`dist/webui.js`）必须抬版本**，不然用户浏览器可能还拿着旧脚本。

---

## 6. 发布

```powershell
Set-Location $NPM
npm publish --dry-run --registry https://registry.npmjs.org/    # 最后一次确认
npm publish --registry https://registry.npmjs.org/              # 正式发
```

开了 2FA 会要求 OTP，照提示填。成功后：

```powershell
npm view cortico-world-image version dist.tarball
```

应该立刻返回刚发的版本号与 tarball 地址（registry CDN 有时要几十秒才刷新，`npm view` 慢一点正常）。

### 6.1 用 Token 发（CI / 无人值守）

```powershell
# npm 网站 → Access Tokens → Generate New Token → Automation（绕过 2FA）
$env:NODE_AUTH_TOKEN = '<token>'
npm publish --registry https://registry.npmjs.org/
```

---

## 7. 发完之后

```powershell
git add -A
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin HEAD --tags
```

* 打 tag 后可以在 GitHub 上建 Release（把 README 里那节的要点抄进去就行，可选）。
* 打开 `https://www.npmjs.com/package/cortico-world-image` 确认：描述、README、仓库链接、版本号、维护者都对。
* 用户侧怎么装：控制台「设置 → 扩展」搜 `cortico-world-image`（或关键词 `cortico-world`）→ 安装 → **重启 Coopanion**。
  开发者也可以用 §8.2 的命令行装法。

---

## 8. 用户视角：装、升级、回退

### 8.1 控制台（推荐）

「设置 → 扩展」→ 搜 `cortico-world-image` → 安装。装完页面会提示 **pending-restart**，
**必须重启进程**：扩展是 ESM 模块，运行中换了代码也不会重新加载。

### 8.2 命令行（等价）

```powershell
Set-Location 'D:\Coopanion\data\extensions'
pnpm add cortico-world-image --ignore-workspace      # 或 cortico-world-image@0.2.0 钉住版本
Set-Location 'D:\Coopanion'
.\Coopanion.exe                                      # 重启生效
```

### 8.3 升级

重跑一遍安装（控制台「扩展」页会显示已装版本与该版本可用更新）。升级后同样要重启。
升级不会动 `data\` 下的用户数据（作品库、配置都在 bot 的 workspace / 扩展数据里）。

### 8.4 回退

```powershell
pnpm add cortico-world-image@0.1.4 --ignore-workspace   # 装回旧版
```

### 8.5 本地开发（不走 npm）

```powershell
pnpm add "D:\path\to\cortico-world-image" --ignore-workspace
```

或者手工把目录 junction 到 `data\extensions\node_modules\` 再在 `data\extensions\package.json` 里写
`"cortico-world-image": "link:D:/path/to/cortico-world-image"`。

---

## 9. 撤回

```powershell
npm deprecate cortico-world-image@0.2.0 "这个版本有 bug，请用 0.2.1"   # 推荐：留版本、给提示
npm unpublish cortico-world-image@0.2.0 --force                        # 24 小时内、且没别的包依赖它
```

`unpublish` 会把版本号**永久占用**（不能再发同一个号），而且已经装了这版的用户不会自动退回，
所以只在包整个废掉时才 `npm unpublish cortico-world-image --force`（整包撤回限制更严）。
一般用「发一个 patch 版本 + `deprecate` 旧版」就够。

---

## 10. 常见报错

| 报错 | 意思 | 怎么办 |
| --- | --- | --- |
| `E401 Unauthorized` / `ENEEDAUTH` | 没登录，或 token 过期 | `npm login`，或给 `NODE_AUTH_TOKEN` |
| `E403 Forbidden` / `You do not have permission` | 包名被别人占了，或账号没权限 | 换名字，或让所有者加你为维护者 |
| `E403 ... cannot publish over previously published version` / `E409 Conflict` | 这个版本号已经发过了 | 抬版本（§5） |
| `E404 Not Found` on publish | registry 指错了（镜像/私有源） | `--registry https://registry.npmjs.org/` |
| `EPERM ... npm-cache` | 默认缓存目录不可写 | `$env:npm_config_cache = "$PWD\.npm-cache"`（§2.4） |
| 发布成功但控制台搜不到 | keywords 少了 `cortico-world`，或 registry 缓存 | 看 `prepublish.mjs` 的关键词检查；等一两分钟重搜 |
| 控制台装上了但扩展没加载 | `cortico.api` 与当前框架不匹配、`describe` 缺失，或没重启 | 看控制台「扩展」页的 problems；重启进程 |
| 面板能开但样式/脚本是旧的 | 面板资源 URL 带版本，旧脚本被浏览器缓存 | 抬版本重发（§5） |

---

## 11. 发布检查清单

- [ ] 开发副本的测试全过（`node tools/check.mjs`、`node tools/patch.mjs --app ...`、`node --experimental-transform-types tools/drymount.mts`、`node --experimental-transform-types tools/describe.mts --check`）
- [ ] 隐私内容已清（本机路径、私有端点、密钥变量名、用户名）
- [ ] `cortico.describe` 指向的 `describe.json` 已重新生成（改了工具描述 / `describe.events` / `ENV_PROMPT.md` 之后）
- [ ] `package.json`：`version` 已抬、`cortico.api` 与当前框架匹配、`files` 覆盖到 `src`/`dist`/`tools`/`README.md`/`describe.json`
- [ ] README 里的版本示例、补丁处数、目录结构与代码一致
- [ ] 本仓库 → 发布目录已 /MIR 同步，哈希核对无 `DIFF`/`MISSING`
- [ ] `node tools/prepublish.mjs --app ...` 全绿
- [ ] `npm pack --dry-run` 内容正常
- [ ] `npm publish --registry https://registry.npmjs.org/`
- [ ] `git commit` + `git tag vX.Y.Z` + `git push --tags`
- [ ] npm 页面与用户侧安装各试一次

# 图片工坊 · cortico-world-image

给 Coopanion 桌宠加两件事：**调用图片生成 API 画图，并把图交回对话**；以及**把本地任意一张图贴进控制台的「对话」页**——后者靠一套自愈补丁给桌宠加一个 `pet_show_image` 工具，程序自动更新把这些文件覆写回原样之后，扩展下次启动会自己补回来。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 5`），只补一个 `image` 世界，
不依赖任何第三方 npm 包（纯 ESM JS + Node 内置模块）。

> **性质说明**：这是给 Coopanion 写的**非官方**扩展，走的是框架公开的扩展接口
> （`kind: world` + `consoleClient` 面板）。唯一伸手动别人的地方是「对话页发图」那一节的
> 自愈补丁——它按锚点改写安装目录下的几个文件（`resources/app` 里的浏览器 bundle、桌宠包
> 的 `src/*.ts`，以及可选的第三方 QQ 扩展），改之前一律留 `.coopanion-orig` 备份，
> 程序自动更新覆写后会自己补回来，细节与还原方式都在那一节里。不愿意让脚本动这些文件，
> 就只用 `image_*` 四个工具，别装那份补丁（补丁是懒触发的，只在扩展启动时检查）。
>
> MIT 许可，见 [LICENSE](LICENSE)。

## 它做了什么

装好并启用之后，桌宠会多出四个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `image_draw` | `act` | 按文字描述画一张新图，落盘、记进索引 |
| `image_edit` | `act` | 拿一张已有的图按指令改（支持上传改图，或阿里云百炼式的 `image` 扩展字段） |
| `image_gallery` | `read` | 列出画过的图，带编号与绝对路径 |
| `image_show` | `speak` | 把一张旧图重新放回对话与作品页 |

画好的图有三条去向：

1. **进对话**：工具回执带 `blobs`，Core 会把它 intern 成句柄，图片作为图片分片进入模型上下文与日志，所以桌宠自己看得见自己画的东西。
2. **进作品页**：扩展自带控制台页「图片工坊 → 作品」，缩略图墙、看大图、复制路径、删除、清空、打开文件夹、离线自检样图。
3. **发给别人**：回执文本里带着**绝对路径**，交给已有的 `qq_send_image`（或别的渠道工具）就能真的发出去。

> 为什么不让图直接出现在桌宠气泡里？框架当前的聊天时间线只有**用户侧**消息带图片槽位
> （`src/web/client/features/chat/index.ts` 的 `ChatItem` 联合里只有 `kind: 'user'` 带 `images`），
> 桌宠窗口的说话气泡也只会渲染纯文本——只有选项卡片的图片位认 `data:image/`。
> 硬往气泡里塞图会改框架，不是扩展该做的事。所以本扩展走「工具回执 blob + 自己的控制台页」这条正规通道。
>
> 例外是**控制台的「对话」页**：那里现在是打补丁支持了桌宠侧的图片（见下一节），
> 但桌宠**头顶气泡**仍然只画文字。

## 对话页发图：`pet_show_image` + 自愈补丁

桌宠多出一个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `pet_show_image` | `act` | 把一个**本地图片路径**（绝对路径，或相对桌宠工作区，如 `blobs/xx.jpg`）贴到控制台「对话」页，可选一句配文 |

- 认 PNG / JPEG / WebP / GIF（先嗅文件头，认不出才看后缀），单张上限 8 MB；
- 标签是 `act` 不是 `speak`，**名字也不是 `pet_say`**，所以 CosyVoice TTS 那类只监听 `pet_say`
  的扩展不会把它念出来；
- 图片随事件存成附件（`log:` 句柄），对话页通过面板的 `blob` 方法取图；对话记录里翻回旧消息也还在。

### 为什么要打补丁

对话页的时间线是**桌宠世界自己**推的流：只有它能写 `source: 'desktop-pet'` 的事件。0.1.22 及更早的框架里：

- `node_modules/cortico-world-desktop-pet/src/chat.ts` 的 `chatItem()` 在 `kind: 'say'` 分支只取
  `meta.beats`，把事件上的 `blobs` 丢掉；
- 浏览器侧 bundle 里 say 那一段只画 `pet-bubble`/`mood`，没有图片槽位（只有用户侧消息有）。

所以「另写一个扩展往对话页推图」是走不通的（别的世界推的事件不会经过桌宠的
`chat.broadcast`，`chatPage()` 也只读 `source === 'desktop-pet'`）。0.1.23 之前靠补丁把这两段补上；
**0.1.23 框架自己已经内置，那 4 处补丁已经删掉**（见下一节）。现在补丁一共 8 处：
前 6 处是你这份安装里本来就有的文件（`world.ts` 5 处 + `definition.ts` 1 处，最后 3 处让
`pet_show_image` 也认相对路径），后 2 处（`optional`）落在**第三方 QQ 扩展**上，没装那个扩展就记
`absent`——不算失败、也不进状态页的总数：

| 补丁 id | 文件 | 做什么 |
| --- | --- | --- |
| `pet-fs-import` | 桌宠 `src/world.ts` | `node:fs` 导入加 `readFileSync`（`{ statSync }` 与 `{ existsSync, statSync }` 两种写法都认） |
| `pet-path-import` | 桌宠 `src/world.ts` | `node:path` 导入加 `basename/extname/isAbsolute` |
| `pet-show-image-tool` | 桌宠 `src/world.ts` | `CHAT_IMAGE_TOOL` 常量、`sniffImageMime()`、`showImage()`、挂进 `tools()` |
| `pet-workspace-option` | 桌宠 `src/world.ts` | 世界选项加 `workspaceDir?: () => string`（装配层注入桌宠工作区） |
| `pet-workspace-relpaths` | 桌宠 `src/world.ts` | `pet_show_image` 的相对路径按 `workspaceDir()` 拼，说明也改成「绝对路径或相对工作区」 |
| `pet-workspace-wire` | 桌宠 `src/definition.ts` | 装配层把 `join(ctx.botDir, 'workspace')` 传进世界 |
| `qq-image-relpaths`（可选） | `<安装>\data\extensions\node_modules\cortico-world-qq-better-alont1\src\world.ts` | `qq_send_image` / `qq_view_image` 认「相对桌宠工作区」的路径（见下） |
| `qq-image-hints`（可选） | 同上 | 那两个工具的参数说明也改成「相对桌宠工作区的路径，如 `blobs/xx.jpg`」 |

改法一律是**精确锚点 + 幂等标记**（`coopanion-chat-image`）：
认不出锚点就记一条失败并**不动那个文件**，绝不硬猜。第一次改写前会把原文留一份
`<文件>.coopanion-orig`。

补丁器不写死源码里的变量名：`tools()` 那处不写死
`DESKTOP_PET_TOOL_DECLS.map(...)`，而是包住 `tools()` 里现有的 `return ...;`。
所以升级换了写法之后照样能打上。

### 框架 0.1.23 之后为什么少了 4 处补丁

0.1.23 起「把图发到对话页」是框架原生能力，不再是这个扩展要补的洞：

- 桌宠 `pet_say` 工具原生就有 `images` 参数（给 `[blob …]` 句柄），`world.ts` 的
  `record(meta, text, blobs = [])` 原生把图片附件写进事件；
- `chat.ts` 原生有 `wireImages()`：把事件 `blobs` 里 `image/*` 的映射成 `WireImage`，`ChatItem` 的
  say 变体本身带 `images?: WireImage[]`；
- 客户端 bundle 的 say 一段原生就画 `chat-thumb` 缩略图并挂 lightbox。

原先为此打的 4 处——`client-say-images`（改客户端 bundle）、`pet-say-images`、`pet-say-type`
（都改 `chat.ts`）、`pet-record-blobs`（改 `world.ts` 的 `record()`）——已经删掉。留着不只是多余：
0.1.23 的 bundle 与新 `chat.ts` 已经换了写法，那几条锚点认不出来，每次启动都会白记三条失败。

**但 `pet_show_image` 仍然保留**：原生的 `pet_say.images` 只认 `[blob …]` 句柄，不认文件路径，而
`pet_show_image` 正是唯一「按路径贴图」的入口——它的实现与「相对桌宠工作区」那几处补丁照样必需。

### 为什么顺手改了 QQ 扩展（`optional` 那两处）

桌宠从 QQ 收到图会先 `save_blob` 存进自己的 `blobs/`（那条路本来就按工作区解析），但要**发出去**
得调 `qq_send_image` / `qq_view_image`，而这两个工具过去只认「绝对路径」或「**相对扩展目录**」：
桌宠手里只有 `blobs/qq-test.jpg` 这种相对工作区的路径，工具先去扩展目录里找，找不到就回一句
「本地没有这个文件：…」，图发不出去。

补上的这一处只做一件事——`resolveLocalImagePath()`：相对路径**先按桌宠工作区
（`this.config.memoryDir`，装配层给的 `<botDir>/workspace`）解析，工作区没有才退回扩展目录**
（装配层没给工作区时退回老行为）；绝对路径原样返回。工具的参数说明也跟着改成
「绝对路径，或相对桌宠工作区的路径，如 `blobs/xx.jpg`」——模型只看得到说明，说明不改它不敢写短路径。

这个包是 `.pnpm` 装的第三方扩展，升级会换目录、文件也会被覆写，所以走同一套自愈：找不到那份
`world.ts` 记 `absent`（没装这个扩展不算失败、不进总数），认不出它原来的写法记 `failed` 并且
**不动那个文件**，原文备份同样是 `world.ts.coopanion-orig`。改的是 TS 源码，**要重启才生效**。

### `pet_show_image` 的相对路径（`pet-workspace-*` 那三处）

同样的毛病在桌宠自己身上（`pet_show_image` 也只认绝对路径，所以「记一句、再发回来」这条最自然的
用法反而要桌宠去背一长串绝对路径）。桌宠那份世界和 QQ 扩展不一样：它的选项里**没有**工作区字段，
所以得三处一起改——世界选项加一个可选的 `workspaceDir?: () => string`（`pet-workspace-option`），
`showImage()` 里那行 `const raw = …` 改成 `let` 并加一段「相对路径就拼工作区，没给工作区仍然报错、
只认绝对路径」（`pet-workspace-relpaths`，同时改工具说明），最后在装配层
`cortico-world-desktop-pet/src/definition.ts` 里把 `join(ctx.botDir, 'workspace')` 传进去
（`pet-workspace-wire`）。

三处都是**精确锚点**，认不出原文就记 `failed` 且不动文件；`pet-workspace-relpaths` 的 `done` 判据是
「真的拼上了工作区」（`raw = join(ws, raw);`），光有工具说明不算打过。装配层没给 `workspaceDir`
（比如桌宠包又改了装配代码、只有前两处打上）时，行为退回老样子：相对路径报错、要求绝对路径——
不会静默拿到错的路径。

### 自愈怎么工作

扩展模块的顶层代码**每次启动都会跑**（`loadExtensions()` 无差别 import 所有已装扩展，与
`worlds.<id>.enabled` 无关），所以这里不用等用户做任何事：

1. 启动时打一遍补丁 → 如果这次真的改了文件，状态文件里记 `requested: true`，并在 4 秒后
   `POST http://127.0.0.1:<web.port>/api/run/restart` 请控制台重启一次（桌宠侧的 TS 源码要重启才装载）；
2. 重启后再跑：文件已经是打过补丁的样子 → 8 处全部 `done`（没装 QQ 扩展的那 2 处是 `absent`）→ 不再请求重启（**不会反复重启**）；
3. 程序自动更新把文件覆写回原样 → 下一轮启动又补上，再重启一次，回到第 2 步；
4. 万一「已经请求过重启，这次还是缺」——说明补丁根本落不到进程真正加载的那份文件上，
   这时记 `stuck`，**故意不再重启**（防死循环），并在「状态」页把 `id — 原因` 列出来给人看。

状态文件是扩展目录下的 `.chat-image-patch.json`（`{at, appRoot, patched, failed, requested}`）。
想彻底关掉这套自愈（比如做回归测试），设环境变量 `COOPANION_CHAT_IMAGE_PATCH=0`。

控制台「图片工坊 → 状态」页多出一张**发图补丁**卡片：装没装上、8 处在不在、上次检查时间、
每一处的备份（`<文件>.coopanion-orig` 在不在、与当前文件是否一致）、上次还原记录、
上次重启请求的结果，外加三个按钮：

- **重打补丁**——立刻再对一遍（不改就不请求重启）；
- **还原备份**——用更新下发的原文把改动过的文件覆盖回去（可逆，备份不删，随时能再打回来）；
- **重启控制台**——等价于点菜单里的重启。

### 备份与还原

| 做什么 | 面板 | 命令行 |
| --- | --- | --- |
| 手动打补丁 | **重打补丁** | `node tools/patch.mjs --app <resources/app> --apply` |
| 看备份现状 | 卡片里那行「备份」 | `node tools/patch.mjs --app <resources/app> --backups` |
| 按备份还原 | **还原备份** | `node tools/patch.mjs --app <resources/app> --restore` |

备份是**每份目标文件旁边的 `<文件>.coopanion-orig`**，第一次改写前拷一次，之后一直留着
（再打补丁不会覆盖它——它永远是「更新下发的原文」）。还原 = 拿它覆盖回去，所以：

- 还原后桌宠那一侧要**重启控制台**才回到「没有发图功能」；面板上的「还原备份」故意不自动重启；
- 还原不是终点：下次启动（或再点**重打补丁**）会自动补回来，所以试错很安全。

### 页面陈旧与浏览器缓存

控制台换版本（0.1.19 → 0.1.21）或控制台重启之后，**已经开着的那个标签页可能不再更新**：对话页停在
旧内容，自己发的和桌宠新说的都不冒出来。这跟补丁无关，服务端一直是对的——已经实测过：直接连
`ws://127.0.0.1:17788/ws/providers/world%3Adesktop-pet/panels/chat` 发 `{"t":"hello"}` 会收到
`init`（历史 267 项），桌宠说话也会收到 `item {kind:'say',…}`。**Ctrl+F5 硬刷新一次**就恢复了。

还有一条是我们这边造成的：扩展面板脚本由服务端按 `/assets/extensions/<包>/<版本>/console.js`
分配，响应头是 `Cache-Control: public, max-age=31536000, immutable`，而 URL 里的版本号来自
`package.json`。所以**改了面板 UI 却没抬版本号时，浏览器会一直用旧脚本**（看不到新按钮）。
改了 `dist/console.js` 就顺手把 `version` 抬一格，或者让用户硬刷新。

**程序内那个控制台窗口更顽固**（Coopanion.exe 自己的窗口，不是外部浏览器）：它是长驻的 Chromium
渲染进程，磁盘缓存在 `<安装>\data\Cache`，而 `immutable` 让它在新鲜期内**连重启都不回源**。
实测证据：`<安装>\data\Cache\Cache_Data\f_0002a1`（19,410 B，2026/10/09 19:38）就是旧的面板
脚本，整个缓存里**没有任何 `patchRestore`**——说明程序内窗口从没取过新脚本，而外部浏览器
（缓存里没有那条）拿到的是新的。

修法是抬版本 + 重启，主程序会在 Core 就绪时自动重载控制台外壳（
`resources\app\app\main.cjs:285` `if (settings) settings.loadURL(consoleUrl());`）：

1. 把 `package.json` 的 `version` 抬一格（例如 `0.1.3` → `0.1.4`）；
2. 重启控制台（状态页「重启控制台」或 `node tools/patch.mjs --restart`）；
3. 程序内窗口自动重载 → 新的 URL `/assets/extensions/cortico-world-image/0.1.4/console.js`
   取到新脚本，旧 URL 立刻变 404。

不想抬版本也行，但要**先完全退出程序**再删缓存目录：`<安装>\data\Cache`、
`<安装>\data\Code Cache`（还有 `<安装>\data\pet-window\Cache`）。

### 手动用

```powershell
node tools/patch.mjs                                              # 在临时副本上自测（不动安装）
node tools/patch.mjs --app <安装目录>\resources\app --apply     # 真落盘
node tools/patch.mjs --app <安装目录>\resources\app --backups   # 看备份现状
node tools/patch.mjs --app <安装目录>\resources\app --restore   # 按备份还原（可逆）
node tools/patch.mjs --app <安装目录>\resources\app --restart   # 请控制台重启
```

（`<安装目录>` 就是 `Coopanion.exe` 那一层，例如 `D:\Coopanion`；下面同理。）

`--app` 省略时按 `COOPANION_APP_ROOT` → `process.resourcesPath/app` → 本扩展目录往上找
`resources/app` → 当前工作目录往上找，认「同时有 `build/cortico/src/paths.ts` 和
`node_modules/cortico-world-desktop-pet/src/world.ts`」的那一层。`--port` 省略时读
`<bot 目录>/config.json` 或 `<安装>/data/home/companion/config.json` 的 `web.port`，再不然 17788。


## 安装

这个包按 npm 包发布（包名 `cortico-world-image`，维护者的发布流程见 [PUBLISH.md](PUBLISH.md)）：
registry 上有版本时直接从 npm 装；想自己改代码、或者 `npm view cortico-world-image version` 还查不到版本，
就用下面的本地装法。

**A. 从 npm 装（推荐，不用下载源码）**

控制台 → 设置 → 扩展 → 搜 `cortico-world-image`（或按关键词 `cortico-world` 搜）→ 安装。
或者用命令行，在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add cortico-world-image --ignore-workspace        # 想钉住版本就写 cortico-world-image@0.1.4
```

装完重启。升级同理：重跑一遍（控制台的「扩展」页会显示已装版本与最新版本），装完同样要重启。

**B. 控制台里装本地目录**

如果你已经把源码拉下来了：设置 → 扩展 → 安装本地扩展，把本目录选给它。

**C. 命令行装本地目录**

在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add "D:\path\to\cortico-world-image" --ignore-workspace
```

它会往 `extensions/package.json` 的 `dependencies` 里写一条 `link:` 路径并连到 `node_modules/`。

**D. 手工连**

把 `data/extensions/node_modules/cortico-world-image` 做成指向本目录的目录联接，
并自己在 `extensions/package.json` 里加 `"cortico-world-image": "link:D:\\path\\to\\cortico-world-image"`。

**装完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后在
`config.json` 的 `worlds.image.enabled` 上打开（控制台里也有这个开关），四个工具才会挂给桌宠。
同一轮启动里，扩展还会把「对话页发图」那 8 处补丁检查一遍（其中 2 处是 QQ 扩展的可选补丁，没装就跳过），缺了就补、并自己请控制台重启一次
（详见上一节）。

### 一份能用的 `worlds.image` 长什么样

`<安装目录>\data\home\<bot 目录>\config.json` 里，最小可用的一段（换成你自己的端点与模型）：

```json
{
  "worlds": {
    "image": {
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-image-1",
      "apiKeySecret": "IMAGE_API_KEY",
      "timeoutMs": 300000
    }
  }
}
```

密钥本体不写在这里（见下面「密钥」一节）。改之前建议先备份
`config.json`（例如存成 `config.json.bak-image-<时间戳>`），出问题直接盖回去。

**改完必须重启 Coopanion**：扩展是 ESM 模块，进程内不会重新加载。重启后控制台
左栏会多出「图片工坊」，「作品」页看画过的图、「状态」页改配置与密钥。

## 配置

都在 `worlds.image` 段，控制台「图片工坊 → 状态/设置」里改了就地生效，不用重启：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否把四个工具挂给桌宠 |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容的图片接口根地址 |
| `apiKeySecret` | `IMAGE_API_KEY` | 密钥的**变量名**：先看部署 `.env`，再退到同级的端点 `.env` |
| `model` | `gpt-image-1` | 模型名 |
| `size` | `1024x1024` | 尺寸，`auto` 或留空就不发这个参数 |
| `quality` | `auto` | `low`/`medium`/`high` 或 `standard`/`hd`；`auto` 不发 |
| `format` | `png` | 接口没给格式时按这个存盘（`png`/`jpeg`/`webp`） |
| `timeoutMs` | `180000` | 单次画图等待上限 |
| `saveDir` | 空 | 留空 = 本插件数据目录下的 `images/` |
| `keep` | `200` | 超出后自动删最旧的，`0` = 不清理 |
| `pushToConsole` | `true` | 画完实时推给「作品」页 |

### 密钥

密钥**不写进 `config.json`**。两种填法：

- 控制台 →「图片工坊 → 状态」→ 把 key 粘进输入框 → 保存。它会写进 `<bot 目录>/.env` 的 `IMAGE_API_KEY=...`，并立刻在这次进程里生效。
- 自己在那份 `.env` 里写一行 `IMAGE_API_KEY=sk-...`，然后重启。

`apiKeySecret` 改名成别的变量名也行，`.env` 里跟着改。

**还可以直接借用已有的端点密钥。** 找不到部署 `.env` 里的那一行时，插件会去
`<部署目录>/../providers/<端点>/.env` 里挨个找同名变量，找到就用，并在「状态」页的
「密钥来源」一行写明是哪个端点的。比如你已经在某个图片端点里配好了 key，那把
`apiKeySecret` 填成**那个端点里用的变量名**就够了——密钥仍然只有那份 `.env` 一份，不会多出副本。

### 能用的端点

只要能对上这两条 OpenAI 形状的路：

- `POST <baseUrl>/images/generations`（JSON，`{model, prompt, size, quality, n}`）
- `POST <baseUrl>/images/edits`（multipart，`image` 文件 + `prompt`）——只有 `image_edit` 要它。
  端点没有这条路由（回 404/405）时，`image_edit` 会自动退回 `/images/generations`，把原图编成
  `data:` URI 放进扩展字段 `image`——阿里云百炼的 OpenAI 兼容模式就是这么改图的，配上
  `baseUrl` 和模型（如 `qwen-image-3.0-pro`）即可，不用额外设置。

响应里认这些形状：`{data:[{b64_json|url}]}`、`{images:[...]}`、`{output|artifacts|content:[...]}`，
以及顶层的 `{image|url|b64_json|image_url}`。base64 直接落盘，`http(s)` 链接会再下载一次。
常见的 `baseUrl`：

- OpenAI：`https://api.openai.com/v1`
- 硅基流动：`https://api.siliconflow.cn/v1`
- 智谱：`https://open.bigmodel.cn/api/paas/v4`
- 火山方舟：`https://ark.cn-beijing.volces.com/api/v3`
- 阿里云百炼：`https://dashscope.aliyuncs.com/compatible-mode/v1`（图生图走 `/images/generations` 的 `image` 字段）

## 自检（不联网）

控制台「图片工坊 → 作品」有个 **插入自检样图** 按钮：它会用手写的极简 PNG 编码器造一张图，
走完「落盘 → 索引 → 面板取图 → 缩略图显示」整条路。看不到这张图，说明是扩展或面板的问题，
不是图片接口的问题。

开发侧一共有四份检查脚本，外加一份发布前自检。

不碰 DOM 的那份覆盖模块形状、dry-mount 那套判据、工具回执、索引与两个面板的挂载（自带假 DOM）：

```powershell
node tools/check.mjs
```

另一份**直接用框架自己的判据**（`resources/app/build/cortico/src/extensions/dry-mount.ts`
与 `manifest.ts`）在临时目录里真跑一遍装配检查：`parseExtensionManifest()` 过声明、
`dryMountWorld()` 造实例、查工具名与其它已装扩展的冲突、核对配置路径：

```powershell
node --experimental-transform-types tools/drymount.mts
```

> 用 `tsx` 跑不通：node 自带的**纯类型擦除**（`--experimental-strip-types`）不支持框架源码里的
> 参数属性（报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），所以必须带
> `--experimental-transform-types`（node 22.6+）。带上这个开关就不需要任何额外的 loader。

第三份会**真的联网画一张图**：拿部署里已有端点的密钥（只读那份 `.env`，不打印密钥），
走完「工具回执带图 → 落盘 → 索引 → 面板取图 → 状态页读数」整条路，图存在临时目录里：

```powershell
$env:LIVE_BOT_DIR = "D:\Coopanion\data\home\<bot 目录>"   # 必填
node tools/live.mjs                                       # 可加 LIVE_BASE_URL / LIVE_MODEL / LIVE_KEY_SECRET
```

跑一次视端点而定，通常 20–60 秒（一张 1024×1024）。没有配好密钥的端点就别跑这一份。

第四份管「对话页发图」那套补丁：默认在临时副本上自测（认锚点、幂等、留备份、还原、esbuild 语法、
上游改过锚点时必须报失败、自动更新覆写后能补回来但不进重启死循环），另有 `--apply` /
`--backups` / `--restore` / `--restart` 四种真动作，见上面「对话页发图」一节。

```powershell
node tools/patch.mjs
```

第五份是**发布前自检**：按宿主 `manifest.ts` 的同一套规则验 `package.json`（`type: module`、
`cortico.api` 是否等于当前框架的 `world` 契约、`consoleClient` 是否真在包里、keywords 里有没有
`cortico-world`）、按 `files` 展开一遍发布物、扫本机路径与私有端点之类的痕迹、逐个 `node --check`，
然后自动跑上面的 `check.mjs`（找得到本机 Coopanion 安装时连 `patch.mjs` 自测与 `drymount.mts` 一起跑）。

```powershell
node tools/prepublish.mjs                              # 或 npm run selfcheck
node tools/prepublish.mjs --app D:\Coopanion\resources\app
node tools/prepublish.mjs --only-static                # 只做静态检查
```

`npm publish` 之前它会自动跑一遍（挂在 `prepublishOnly` 上），没过就不发包。

## 目录结构

```
cortico-world-image/
├─ package.json        # cortico: { kind: world, api: 5, consoleClient: dist/console.js }
├─ README.md
├─ PUBLISH.md          # 发布流程（维护者用，不打进 npm 包）
├─ ENV_PROMPT.md       # 随环境提示词交给桌宠的说明（含 {{image.dir}} / {{image.ready}} 占位符）
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create
│  ├─ config.js        # worlds.image 默认值、中英文案、配置组 schema
│  ├─ world.js         # ImageWorld：工具、控制台面板、流式推送、生命周期
│  ├─ chat-image-patch.js # 对话页发图的 8 处补丁（含 3 处工作区相对路径、2 处可选的 QQ 扩展）、状态文件、重启请求（自愈核心）
│  ├─ api.js           # OpenAI 兼容客户端的取图/落盘/错误归一化
│  ├─ gallery.js       # 作品仓库：目录 + index.json
│  └─ png.js           # 零依赖 PNG 编码器 + 自检样图
├─ dist/console.js     # 浏览器侧面板 bundle（export default { panels })
└─ tools/
   ├─ check.mjs        # 离线检查（自带假 DOM）
   ├─ drymount.mts     # 用框架自带判据跑 dry-mount
   ├─ live.mjs         # 联网真画一张（自测整条链路）
   ├─ patch.mjs        # 对话页发图补丁：自测 / --apply / --backups / --restore / --restart
   └─ prepublish.mjs   # 发布前自检：契约 / files / 隐私串 / 语法，顺手跑上面几套
```

## 已知限制

- 控制台页面自己有缓存/陈旧问题：换版本或控制台重启后，更新之前就开着的那个标签页可能不再更新，
  Ctrl+F5 即可（详见「页面陈旧与浏览器缓存」）。
- 桌宠**头顶气泡**仍然只画文字；`pet_show_image` 的图出现在控制台「对话」页（靠上面那套补丁），不在气泡里。
- `pet_show_image` 的相对路径按桌宠工作区解析（`pet-workspace-*` 那三处补丁）；万一装配层那处
  （`pet-workspace-wire`）没打上、世界里没拿到 `workspaceDir`，行为退回老样子：相对路径报错、
  要求给绝对路径——不会静默拼出一个错的路径。
- `image_edit` 先走 `/images/edits`（multipart 上传）；端点没这条路由（404/405）时自动退回
  `/images/generations` 的 `image` 扩展字段（data URI，阿里云百炼那类）。两条路都不通时会回一条
  带 HTTP 码的错误，不是静默失败。
- 只有 Windows 上的「打开文件夹」会真的弹资源管理器；其他平台返回一句说明。
- 画图本身要联网，只有自检样图是纯本地的。

## 发布（维护者）

这个仓库同时就是 npm 包 `cortico-world-image` 的源码。发一版的流程：

1. 改完代码、跑完自检（`node tools/prepublish.mjs --app <安装目录>\resources\app` 全绿）；
2. 抬 `package.json` 的 `version`（改了 `dist/console.js` 必须抬，否则浏览器缓存旧脚本）；
3. 把本仓库整份同步到发布目录（一份纯产物副本，`npm publish` 的根）；
4. 提交并推进 GitHub；
5. 在发布目录里 `npm publish --registry https://registry.npmjs.org/`。

README 里只写结论，**逐步命令、npm 账号/Token、registry、缓存目录、撤回与常见报错都写在
[PUBLISH.md](PUBLISH.md)**。要点：`npm publish` 会自动先跑 `tools/prepublish.mjs`，没过就不发包。

## 许可

MIT，见 [LICENSE](LICENSE)。

这是一个**非官方**扩展：与 Coopanion / cortico 的作者无关。「对话页发图」那部分补丁直接改写
安装目录里的框架文件与第三方扩展源码（`resources/app` 与 `data/extensions` 下的位置），
升级、重装或自动更新前请先看那一节并留好 `.coopanion-orig` 备份；`node tools/patch.mjs --restore`
就是按这些备份还原。

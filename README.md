# 图片工坊 · cortico-world-image

给 Coopanion 桌宠加两件事：**调用图片生成 API 画图，并把图交回对话**；以及**把图贴进控制台的「对话」页**——后者用桌宠包自带的 `pet_say.images`（本扩展的工具回执里带着附件句柄），不再给桌宠打补丁。**不再改写任何人的安装目录**：早期给第三方 QQ 扩展打的发图路径补丁已整体搬到「补丁台」（`cortico-world-patchkit`），这里只负责算图与写标签。

这是一个 `cortico` 的 **World 扩展**（`kind: world`，`api: 6`），只补一个 `image` 世界，
不依赖任何第三方 npm 包（纯 ESM JS + Node 内置模块）。

> **性质说明**：这是给 Coopanion 写的**非官方**扩展，走的是框架公开的扩展接口
> （`kind: world` + `webUiClient` 面板 + 必需的 `describe.json` 自描述）。
> 从 0.7.0 起它**不写任何别的扩展的文件**：早期按锚点改写第三方 QQ 扩展源码的那几处可选补丁
> （旧版 `cortico-world-qq-better-alont1` 的 `src/world.ts`、新版 `cortico-world-qq-final` 的
> `src/normalize.ts` 与 `src/world.ts`，带 `.coopanion-orig` 备份与自动重打）已整体搬到
> **「补丁台」`cortico-world-patchkit`**，那里有卡片开关、备份与还原。桌宠包同样完全不碰
> （0.3.0 起改用官方的 `pet_say.images`）。
>
> MIT 许可，见 [LICENSE](LICENSE)。

## 它做了什么

装好并启用之后，桌宠会多出四个工具：

| 工具 | 标签 | 作用 |
| --- | --- | --- |
| `image_draw` | `act` | 按文字描述画一张新图，落盘、记进索引（可带 `model` 点名用哪一档） |
| `image_edit` | `act` | 拿已有的图按指令改（`image` 一张，或 `images` 最多四张参考图；同样能带 `model`）。多张参考图在支持多图编辑的端点上直接生效，只支持单图的地方会在回执里说「只有第一张参与了」 |
| `image_gallery` | `read` | 列出画过的图，带编号与绝对路径 |
| `image_show` | `speak` | 把一张旧图重新放回对话与作品页 |

画好的图有三条去向：

1. **进对话**：工具回执带 `blobs`，Core 会把它 intern 成句柄，图片作为图片分片进入模型上下文与日志，所以桌宠自己看得见自己画的东西。
2. **进作品页**：扩展自带控制台页「图片工坊 → 作品」，缩略图墙、看大图、复制路径、删除、清空、打开文件夹、离线自检样图。
3. **发给别人**：回执文本里带着**绝对路径**和一个现成的 `[图片:<文件名>]` 标签行，交给已有的渠道工具就能真的发出去——旧版 QQ 扩展用 `qq_send_image`（填绝对路径）；`cortico-world-qq-final` 在 `qq_send` 正文里写那行标签（0.6.36 起要先把 QQ 插件的 `imageDir` 指到本扩展的保存目录，见下文）。

> 为什么不让图直接出现在桌宠气泡里？框架当前的聊天时间线只有**用户侧**消息带图片槽位
> （`src/web/client/features/chat/index.ts` 的 `ChatItem` 联合里只有 `kind: 'user'` 带 `images`），
> 桌宠窗口的说话气泡也只会渲染纯文本——只有选项卡片的图片位认 `data:image/`。
> 硬往气泡里塞图会改框架，不是扩展该做的事。所以本扩展走「工具回执 blob + 自己的控制台页」这条正规通道。
>
> 例外是**控制台的「对话」页**：那里用桌宠包自带的 `pet_say.images` 就能显示图（见下一节），
> 但桌宠**头顶气泡**仍然只画文字。

## 把图贴到「对话」页：官方 `pet_say` 的 `images`

桌宠包从 **0.2.0** 起，`pet_say` 自带 `images` 参数，所以本扩展**不再给桌宠打任何补丁**：

```js
pet_say({ script: '', images: ['<句柄>'] })            // 只贴图、不说话
pet_say({ script: '看，画好了。', images: ['<句柄>'] })  // 气泡里说一句，图贴到对话页
```

- 参数收的是**附件句柄**：就是工具回执里 `[blob <handle> <mime> <name>]` 那一行的 `<handle>`。
  本扩展的 `image_draw` / `image_edit` / `image_show` 回执本来就带附件，框架会把它渲染成这样一行交给模型。
- `script` 空串 = 只有图、没台词；图只进控制台「对话」页，**不进气泡**。写一句话就同时说、同时贴。
- **任意本地文件要两步**：先 `image_show({ path })` 把文件读成附件、拿到句柄，再 `pet_say`。
  多一次工具调用，并且那张图会被渲染给模型看（约 1k+ token/张，一次性）；对话里刚画好的图
  直接用 `image_draw` 回执里的句柄，不额外花。
- 0.3.0 起**没有 `pet_show_image` 这个工具了**。

### QQ 发图：补丁已经不在这里了

0.6.2 及更早，本扩展启动时会顺手改写**第三方 QQ 扩展**的源码，让 `[图片:…]` / `qq_send_image`
认绝对路径和桌宠工作区相对路径（旧版 `cortico-world-qq-better-alont1` 的 `src/world.ts`，
新版 `cortico-world-qq-final` 的 `src/normalize.ts` 与 `src/world.ts`）。
**0.7.0 起这套机制整体搬到「补丁台」（`cortico-world-patchkit`）**：本扩展不再导入、不再备份、
也不再写别人的安装目录，只负责把图算出来、把标签写好。

| 你用的 QQ 扩展 | 怎么发图 | 要做什么 |
| --- | --- | --- |
| 官方 `cortico-world-qq`（world `qq`） | `qq_draft` 的 `image` 填 `[blob …]` 句柄 | 不用配 |
| 旧版 `cortico-world-qq-better-alont1` | `qq_send_image` 填路径 | 装「补丁台」，开「发图认路径」 |
| `cortico-world-qq-final` ≤ 0.6.35（带 `src/`） | `qq_send` 正文写 `[图片:文件名或路径]` | 装「补丁台」，开「发图认路径」 |
| `cortico-world-qq-final` 0.6.36+（只发 `dist/`） | `qq_send` 正文写 `[图片:文件名]` | 把本扩展的保存目录填进 QQ 插件的 `worlds.qqbot.imageDir` |

为什么 0.6.36 起打不了补丁：那一版只发布压缩过的 `dist/index.js`，没有 `src/` 可改。它的
`buildOutgoing()` 只认「自己图片库目录里的文件名」：`[图片:…]` 里的路径会被丢掉、只留文件名去
那个目录里找，找不到就把整条括注当普通文本发出去（用户看到的是文字）。正解是让两边看同一个目录：

```jsonc
// <安装>\data\home\companion\config.json
"worlds": {
  "qqbot": {
    "enabled": true,
    "imageDir": "<安装>\\data\\home\\companion\\data\\images"
  }
}
```

`imageDir` 写本扩展「作品 → 打开文件夹」那个目录的**绝对路径**（也就是设置页「保存目录」显示的值，
默认 `<bot 数据目录>/images`）。改完重启控制台，之后模型在 `qq_send` 正文里写
`[图片:<文件名>]` 就能发出去——本扩展的回执本来就把这一行单独列出来，照抄即可。

另外两点：0.6.36 的标签正则仍是 `[^\[\]]{1,40}`（方括号内最多 40 字），所以回执只给文件名、
不给超长绝对路径；`cortico-world-qq-final` 的图片索引在它自己包里（`image-index.json`），
往图片库目录里丢文件不会出现在它的 `qq_image list` 里，但不影响按文件名发图。

### 页面陈旧与浏览器缓存
### 页面陈旧与浏览器缓存

控制台换版本（0.1.19 → 0.1.21）或控制台重启之后，**已经开着的那个标签页可能不再更新**：对话页停在
旧内容，自己发的和桌宠新说的都不冒出来。这跟补丁无关，服务端一直是对的——已经实测过：直接连
`ws://127.0.0.1:17788/ws/providers/world%3Adesktop-pet/panels/chat` 发 `{"t":"hello"}` 会收到
`init`（历史 267 项），桌宠说话也会收到 `item {kind:'say',…}`。**Ctrl+F5 硬刷新一次**就恢复了。

还有一条是我们这边造成的：扩展面板脚本由服务端按 `/assets/extensions/<包>/<版本>/webui.js`
分配，响应头是 `Cache-Control: public, max-age=31536000, immutable`，而 URL 里的版本号来自
`package.json`。所以**改了面板 UI 却没抬版本号时，浏览器会一直用旧脚本**（看不到新按钮）。
改了 `dist/webui.js` 就顺手把 `version` 抬一格，或者让用户硬刷新。

**程序内那个控制台窗口更顽固**（Coopanion.exe 自己的窗口，不是外部浏览器）：它是长驻的 Chromium
渲染进程，磁盘缓存在 `<安装>\data\Cache`，而 `immutable` 让它在新鲜期内**连重启都不回源**。
实测证据：`<安装>\data\Cache\Cache_Data\f_0002a1`（19,410 B，2026/10/09 19:38）就是旧的面板
脚本，整个缓存里**没有任何 `patchRestore`**——说明程序内窗口从没取过新脚本，而外部浏览器
（缓存里没有那条）拿到的是新的。

修法是抬版本 + 重启，主程序会在 Core 就绪时自动重载控制台外壳（
`resources\app\app\main.cjs:285` `if (settings) settings.loadURL(consoleUrl());`）：

1. 把 `package.json` 的 `version` 抬一格（例如 `0.5.0` → `0.5.1`）；
2. 重启控制台（状态页「重启控制台」）；
3. 程序内窗口自动重载 → 新的 URL `/assets/extensions/cortico-world-image/0.5.1/webui.js`
   取到新脚本，旧 URL 立刻变 404。

不想抬版本也行，但要**先完全退出程序**再删缓存目录：`<安装>\data\Cache`、
`<安装>\data\Code Cache`（还有 `<安装>\data\pet-window\Cache`）。

### 手动用

```powershell
node tools/check.mjs                                    # 离线自检（不需要宿主）
node tools/prepublish.mjs --app <安装目录>\resources\app  # 发布前全套（含 dry-mount）
```

（`<安装目录>` 就是 `Coopanion.exe` 那一层，例如 `D:\Coopanion`；下面同理。）
要打/还原 QQ 发图补丁，请用「补丁台」的卡片或它的 `tools/check.mjs`。


## 安装

这个包按 npm 包发布（包名 `cortico-world-image`，维护者的发布流程见 [PUBLISH.md](PUBLISH.md)）：
registry 上有版本时直接从 npm 装；想自己改代码、或者 `npm view cortico-world-image version` 还查不到版本，
就用下面的本地装法。

**A. 从 npm 装（推荐，不用下载源码）**

控制台 → 设置 → 扩展 → 搜 `cortico-world-image`（或按关键词 `cortico-world` 搜）→ 安装。
或者用命令行，在 `data/extensions` 目录里（`extensions/package.json` 所在处）执行：

```powershell
pnpm add cortico-world-image --ignore-workspace        # 想钉住版本就写 cortico-world-image@0.5.1
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
从 0.7.0 起，扩展启动时**只挂工具、不动任何别人的文件**（不再检查/重打 QQ 补丁，也不再请求重启）。

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
| `baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容的图片接口根地址（没配 `models` 时用它） |
| `apiKeySecret` | `IMAGE_API_KEY` | 密钥的**变量名**：先看部署 `.env`，再退到同级的端点 `.env` |
| `model` | `gpt-image-1` | 模型名（没配 `models` 时用它） |
| `models` | 空 | 模型链：一串后端按优先级顺序试，见下面「模型链」（0.4.0 起） |
| `size` | `1024x1024` | 尺寸：`1024x1536`、比例 `16:9`/`4:3`、或 `square`/`portrait`/`landscape`；`auto` 或留空＝不指定（云端不发这个参数，本地按图生图规则处理） |
| `quality` | `auto` | `low`/`medium`/`high` 或 `standard`/`hd`；`auto` 不发 |
| `format` | `png` | 接口没给格式时按这个存盘（`png`/`jpeg`/`webp`） |
| `timeoutMs` | `180000` | 单次画图等待上限 |
| `saveDir` | 空 | 留空 = 本插件数据目录下的 `images/` |
| `keep` | `200` | 超出后自动删最旧的，`0` = 不清理 |
| `pushToConsole` | `true` | 画完实时推给「作品」页 |

### 模型链：一串后端按顺序试（0.4.0）

`worlds.image.models` 是一份 JSON 数组，**数组顺序就是优先级**。前档连不上、超时、额度用完、
模型没装、参数不支持时自动换下一档；只有「内容审核拦了提示词」这类换谁都一样的错才不换。
状态页的「模型链」卡片里它就是**一串小卡片**（见下），不用手写 JSON。

```json
[
  { "name": "local", "preset": "comfyui", "baseUrl": "http://127.0.0.1:8188", "ckpt": "sd_xl_base_1.0.safetensors" },
  { "name": "cloud", "preset": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-image-1" }
]
```

留空 = 用上面那套单档 `baseUrl` + `model`。两种 `preset`：

- `openai`：原有的 OpenAI 兼容接口（`/images/generations`、`/images/edits`），要密钥。
- `comfyui`：本地 ComfyUI（默认 `http://127.0.0.1:8188`），**不要密钥**，但要写模型文件：
  `ckpt`（checkpoint 文件名，就是 `ComfyUI/models/checkpoints/` 里那个），或者 **裸 UNet 三件套**
  `unet` + `textEncoder` + `vaeName`（Anima、Flux 这类不是 all-in-one 的模型；填了 `unet` 就不看 `ckpt`）。

每档都能写这些。`baseUrl` / `model` / `apiKeySecret` / `size` / `quality` / `format` / `timeoutMs` 不写就继承
`worlds.image` 的单档设置；其余（`ckpt`、`loras`、采样参数等）只有链里的档才有，按下面的默认值走：

| 键 | 说明 |
| --- | --- |
| `name` | 这一档的名字；面板与报错里用它，工具参数 `model` 也按它点名 |
| `preset` | `openai` / `comfyui` |
| `baseUrl` / `model` / `apiKeySecret` / `size` / `quality` / `format` / `timeoutMs` | 同上面那张表 |
| `ckpt` | ComfyUI 的 checkpoint 文件名（`comfyui` 必填，除非写了 `unet`） |
| `unet` / `textEncoder` / `vaeName` | 裸 UNet 三件套：`ComfyUI/models/diffusion_models`、`text_encoders`、`vae` 里的文件名。**填了 `unet` 就顶掉 `ckpt`**，只出裸 UNet 那份工作流 |
| `textEncoderType` | `unet` 的文本编码器类型，默认 `stable_diffusion`；Qwen 系编码器填 `qwen_image`（还认 `sd3` / `flux` / `cosmos` / `lumina2`） |
| `loras` | ComfyUI 的 LoRA：`["add_detail.safetensors:0.6", {"name":"x.safetensors","strength":0.4,"clipStrength":0.25}]`（名字带扩展名，文件得先在 ComfyUI 的 `models/loras` 里） |
| `steps` / `cfg` / `sampler` / `scheduler` / `denoise` / `negative` | ComfyUI 采样参数（默认 25 / 7 / euler / normal / 0.6）。`denoise` 在改图时就是改动幅度：0.6 起改得明显，只微调用 0.2~0.35 |
| `workflow` | 自定义 ComfyUI API 工作流（对象）。给了就整份替换内置模板，占位符见下。面板里点本地档的「工作流」按钮粘贴即可，不用手写 JSON |
| `edit` | `false` = 这一档只用来画、不接改图（改图会跳到下一档） |
| `enabled` | `false` = 跳过这一档 |

工具参数 `model` 可以点名某一档（`name`、`ckpt` 或 `model` 三者之一）：点了名就**只用那一档**，
失败了直接报错、不偷偷换——想让它自己挑就别传 `model`。

状态页的「模型链」卡片默认就是友好编辑：一档一张小卡片，填「名称 / 类型 / 地址 / 模型或 ckpt」，
用「上移 / 下移」调优先级、「删除」去掉一档，「＋ 本地 ComfyUI」「＋ 云端接口」加档。
本地 ComfyUI 那档还多一个「高级参数」按钮：能加**多行 LoRA**（文件名 / 强度 / CLIP 强度，文件名要带
扩展名、可带子目录），也能改 `negative`、`steps`、`cfg`、`sampler`、`scheduler`、`denoise`，
以及**裸 UNet 三件套**（`unet` / `textEncoder` / `textEncoderType` / `vaeName`；填了它就忽略这一档的 `ckpt`）
——存的就是该档的 `loras`、`negative`、`steps`、`unet` 这些字段，等于面板版的「高级：JSON」。
**自定义工作流**：本地 ComfyUI 那档的行里有个「工作流」按钮，点开是个大框，把 ComfyUI 里
⚙ 菜单 →「Save (API Format)」存下来的 JSON 整份粘进去，点「校验」它会当场说能不能跑（几个节点、
几个采样器、哪些占位符不认识、有没有 `{{image1}}` 这种多图位），点「保存工作流」就挂到这一档，
行里会显示「工作流 · 已用自定义」。要回到内置模板就点「清空」。「高级：JSON」里仍能看到同一份
（`workflow` 字段），两种改法等价。

保存就是写 `worlds.image.models`；`workflow` 这类只能手写的字段也可以点「高级：JSON」改原文——**链还空着时它自带一份现成范例**
（一档本地 ComfyUI，带 `ckpt`、两条 LoRA、采样参数与负面提示；一档云端），
把 `ckpt` / `loras` 换成自己 `models` 里的文件名，「应用 JSON」再「保存模型链」就能用。
「测试模型链」会挨档探活：ComfyUI 看 `/system_stats`，再用 `/object_info` 一次性核对 `ckpt`（或
`unet` / `textEncoder` / `vaeName`）在不在；OpenAI 兼容看 `/models`（端点没这条路由也算在线）。
探活每档最多等 6 秒；链上有没保存的改动时会先拦住。

#### ComfyUI 这档会调哪些路

`POST /prompt`（提交工作流）、`GET /history/<prompt_id>`（轮询等结果）、`GET /view?filename=…`
（取成品图）、`POST /upload/image`（改图时把参考图放进 `input/`）、`POST /interrupt`（超时收尾）、
`GET /system_stats`、`GET /object_info`（核对模型文件名，拿不到就跳过核对）。

不会替你去下模型：checkpoint 与 LoRA 得先放进 ComfyUI 的 `models/checkpoints` 与 `models/loras`，
`ckpt` 写文件名（在子目录里就写相对路径）；裸 UNet 的三个文件放进 `models/diffusion_models`、
`models/text_encoders`、`models/vae`。自定义 `workflow` 里可用的占位符：
`prompt`、`negative`、`ckpt`、`width`、`height`、`size`、`steps`、`cfg`、`sampler`、`scheduler`、
`seed`、`denoise`、`image`（第一张参考图）、`image1`/`image2`/`image3`/`image4`（依次对应
`image_edit` 的 `images`）、`images`（逗号连起来的所有参考图）、`loras`、`prefix`、`filename`、
`note`（一小行说明，写工作流时不用管）；写成 `{{prompt}}` 这样，认不出的原样留着。
占位符两边有别的字符（比如 `"a photo, {{prompt}}"`）时按字符串拼进去；整个值就是一个占位符时保留原类型。

### 密钥

密钥**不写进 `config.json`**。两种填法：

- 控制台 →「图片工坊 → 状态」→ 把 key 粘进输入框 → 保存。它会写进 `<bot 目录>/.env` 的 `IMAGE_API_KEY=...`，并立刻在这次进程里生效。
- 自己在那份 `.env` 里写一行 `IMAGE_API_KEY=sk-...`，然后重启。

`apiKeySecret` 改名成别的变量名也行，`.env` 里跟着改。

**只认自己部署的密钥库。** 早期版本找不到密钥时会去 `<部署目录>/../providers/<端点>/.env`
里翻别的扩展的同名变量——那是越界的，0.7.2 起已经去掉：插件只通过宿主的 `ctx.secret(name)`
读本部署的 `.env`，别家扩展目录里的文件一个都不读。要用别处的 key，就往本部署的 `.env`
里写一份（或改用环境变量注入），而不是去读别人的。

### 能用的端点

只要能对上这两条 OpenAI 形状的路：

- `POST <baseUrl>/images/generations`（JSON，`{model, prompt, size, quality, n}`）
- `POST <baseUrl>/images/edits`（multipart，`image` 文件 + `prompt`）——只有 `image_edit` 要它。
  端点没有这条路由（回 404/405）时，`image_edit` 会自动退回 `/images/generations`，把原图编成
  `data:` URI 放进扩展字段 `image`——阿里云百炼的 OpenAI 兼容模式就是这么改图的，配上
  `baseUrl` 和模型（如 `qwen-image-3.0-pro`）即可，不用额外设置。

**多张参考图（`image_edit` 的 `images`，最多四张）**：`/images/edits` 会把每张都作为 `image[]`
一起传上去（支持多图编辑的端点——比如 OpenAI 的 `gpt-image-1` 系列、百炼的多图模式——直接生效）；
退回 `/images/generations` 的那条路只认第一张，回执会明说「这个端点的改图退路只认第一张参考图，
后面 N 张没参与」，不会假装已经用上。ComfyUI 那边则是 `{{image1}}`…`{{image4}}` 占位符，
内置模板只用第一张；要真正合成多张，就在自定义工作流里各接一个 `LoadImage`。

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
不是图片接口的问题。「状态」页也有同一个按钮，两边都能用（`status.selftest` 与 `gallery.selftest`
都认；0.5.5 前只有后者，从状态页点会报 `未知面板方法：status.selftest`，issue #3 一起修了）。

开发侧一共有五份检查脚本，外加一份发布前自检。

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

框架 0.2 起每个扩展还要带一份**自描述**（`cortico.describe` → `describe.json`：工具表、事件表，
以及环境提示词模板的原文）。这份脚本按同一套判据从定义重新生成一遍，跟包里那份逐字比对：

```powershell
node --experimental-transform-types tools/describe.mts          # 生成 / 刷新 describe.json
node --experimental-transform-types tools/describe.mts --check  # 只核对，不写盘
```

改了工具描述、`describe.events` 或 `ENV_PROMPT.md` 之后要重新生成一次，否则发布前自检会拦下来。

第三份会**真的联网画一张图**：拿部署里已有端点的密钥（只读那份 `.env`，不打印密钥），
走完「工具回执带图 → 落盘 → 索引 → 面板取图 → 状态页读数」整条路，图存在临时目录里：

```powershell
$env:LIVE_BOT_DIR = "D:\Coopanion\data\home\<bot 目录>"   # 必填
node tools/live.mjs                                       # 可加 LIVE_BASE_URL / LIVE_MODEL / LIVE_KEY_SECRET
```

跑一次视端点而定，通常 20–60 秒（一张 1024×1024）。没有配好密钥的端点就别跑这一份。

还有一份是**发布前自检**：按宿主 `manifest.ts` 的同一套规则验 `package.json`（`type: module`、
`cortico.api` 是否等于当前框架的 `world` 契约、`webUiClient` 与 `describe` 是否真在包里、keywords 里有没有
`cortico-world`）、按 `files` 展开一遍发布物、扫本机路径与私有端点之类的痕迹、逐个 `node --check`，
然后自动跑上面的 `check.mjs`（找得到本机 Coopanion 安装时连 `drymount.mts` 与
`describe.mts --check` 一起跑）。

```powershell
node tools/prepublish.mjs                              # 或 npm run selfcheck
node tools/prepublish.mjs --app D:\Coopanion\resources\app
node tools/prepublish.mjs --only-static                # 只做静态检查
```

`npm publish` 之前它会自动跑一遍（挂在 `prepublishOnly` 上），没过就不发包。

## 目录结构

```
cortico-world-image/
├─ package.json        # cortico: { kind: world, api: 6, webUiClient: dist/webui.js, describe: describe.json }
├─ README.md
├─ PUBLISH.md          # 发布流程（维护者用，不打进 npm 包）
├─ ENV_PROMPT.md       # 随环境提示词交给桌宠的说明（含 {{image.dir}} / {{image.ready}} 占位符）
├─ src/
│  ├─ index.js         # 入口：default 导出 WorldDefinition
│  ├─ definition.js    # id/label/defaults/preflight/create
│  ├─ config.js        # worlds.image 默认值、中英文案、配置组 schema
│  ├─ world.js         # ImageWorld：工具、控制台面板、流式推送、生命周期
│  ├─ chain.js         # 模型链：解析 worlds.image.models、排序、逐档回退、报错归纳
│  ├─ comfyui.js       # 本地 ComfyUI 适配器（内置工作流 / 自定义 workflow / 改图 / 探活）
│  ├─ api.js           # OpenAI 兼容客户端的取图/落盘/错误归一化
│  ├─ gallery.js       # 作品仓库：目录 + index.json
│  └─ png.js           # 零依赖 PNG 编码器 + 自检样图
├─ describe.json       # 自描述（框架 0.2 起必需）：工具表、事件表、环境提示词原文
├─ dist/webui.js       # 浏览器侧面板 bundle（export default { panels })
└─ tools/
   ├─ check.mjs        # 离线检查（自带假 DOM）
   ├─ describe.mts     # 生成 / 核对 describe.json（--check 只核对）
   ├─ drymount.mts     # 用框架自带判据跑 dry-mount
   ├─ live.mjs         # 联网真画一张（自测整条链路）
   └─ prepublish.mjs   # 发布前自检：契约 / files / 隐私串 / 语法，顺手跑上面几套
```

## 已知限制

- 控制台页面自己有缓存/陈旧问题：换版本或控制台重启后，更新之前就开着的那个标签页可能不再更新，
  Ctrl+F5 即可（详见「页面陈旧与浏览器缓存」）。
- 桌宠**头顶气泡**仍然只画文字；图片出现在控制台「对话」页（`pet_say.images`），不在气泡里。
- 贴**任意本地文件**要两步（先 `image_show` 换句柄，再 `pet_say`），会比以前的 `pet_show_image` 多一次
  工具调用、多花约 1k+ token/张（那次调用会把图渲染给模型看）。
- 桌宠包早于 0.2.0 时没有 `pet_say.images`，贴图这条路走不通（0.3.0 也因此不再支持老桌宠包）。
- `image_edit` 先走 `/images/edits`（multipart 上传）；端点没这条路由（404/405）时自动退回
  `/images/generations` 的 `image` 扩展字段（data URI，阿里云百炼那类）。两条路都不通时会回一条
  带 HTTP 码的错误，不是静默失败。多张参考图（`images`，最多四张）在 `/images/edits` 上一起传，
  退回退路时只用第一张并在回执里说明。
- 本地 ComfyUI 那档可以**整份替换内置工作流**：行里的「工作流」按钮粘 ComfyUI 的
  「Save (API Format)」JSON，「校验」会当场挑毛病（界面格式、缺 `class_type`、连线指向不存在节点、
  不认识的占位符），README 这节的占位符表就是它能认的全部；点「清空」回到内置模板。
- 尺寸：`size` 能写 `1024x1536`、比例 `16:9` / `4:3`、或 `square` / `portrait` / `landscape`（中文
  `竖图` / `横图` / `方图` 也认），比例会换成一套对齐好的尺寸（16:9 → 1344×768，4:3 → 1152×864）；
  写死的数字只按 latent 要求对齐到 8，不动你写的整数。
- 云端那档（OpenAI 兼容端点）**只认 `宽x高`**：别名和比例会先换成它认的三档之一
  （`1024x1024` / `1536x1024` / `1024x1536`），认不出来的值就不发这个字段、让服务端用自己的默认，
  并在回执里说明一句。以前是原样透传，`square` 这种会让上游直接失败（报成 503「无返回结果」，
  很难联想到 size），issue #3 修的就是这个。
- 改图的尺寸：ComfyUI 那档**不传 `size`、或写 `auto`，就照参考图的比例**出图（最长边压到 1536、对齐
  16），传了 `size` 就按给的；云端那档走接口自己的默认（一般不传尺寸）。所以改一张 1600×1200 的图
  会出 1536×1152，不会变成方图。图生图的回执/作品页记的是**实际出的尺寸**，不再是 `auto`。
- 模型链的 ComfyUI 那档**不会替你下模型**：checkpoint / LoRA 得先放进 ComfyUI 的
  `models/checkpoints`、`models/loras`，`ckpt` 写文件名；本机没开 ComfyUI 时这档直接算不可用，
  链会落到下一档。**裸 UNet 要放 `models/diffusion_models`**（老版本是 `models/unet`），放错到
  `checkpoints` 里会被当成 checkpoint、`UNETLoader` 那边永远看不到——这种时候插件会把 ComfyUI 的
  校验错误翻成人话：缺哪个字段、给了什么值、它现在认哪些名字、文件该放哪个目录。
- 用错加载方式也会解释：拿 checkpoint 节点去开一个没有 CLIP / VAE 的裸模型时，ComfyUI 只丢一句
  `clip input is invalid: None`，插件会说明「这是裸模型 → 改用模型文件三件套、文件放 diffusion_models」；
  显存不足、缺自定义节点也各有对应的一句话。
- 只有 Windows 上的「打开文件夹」会真的弹资源管理器；其他平台返回一句说明。
- 画图本身要联网，只有自检样图是纯本地的。

## 发布（维护者）

这个仓库同时就是 npm 包 `cortico-world-image` 的源码。发一版的流程：

1. 改完代码、跑完自检（`node tools/prepublish.mjs --app <安装目录>\resources\app` 全绿）；
2. 抬 `package.json` 的 `version`（改了 `dist/webui.js` 必须抬，否则浏览器缓存旧脚本）；
3. 把本仓库整份同步到发布目录（一份纯产物副本，`npm publish` 的根）；
4. 提交并推进 GitHub；
5. 在发布目录里 `npm publish --registry https://registry.npmjs.org/`。

README 里只写结论，**逐步命令、npm 账号/Token、registry、缓存目录、撤回与常见报错都写在
[PUBLISH.md](PUBLISH.md)**。要点：`npm publish` 会自动先跑 `tools/prepublish.mjs`，没过就不发包。

## 许可

MIT，见 [LICENSE](LICENSE)。

这是一个**非官方**扩展：与 Coopanion / cortico 的作者无关。

**边界自述（0.7.2 起）**：本扩展在加载、运行、卸载的任何时刻都**不写、不改、不删别人的文件**——
它只读自己的配置、往自己的数据目录（`saveDir`，默认 `<数据目录>/images`）写作品与索引，密钥只通过
宿主的 `ctx.secret()` 读本部署的 `.env`。早期（≤0.6.2）那套按锚点改写第三方 QQ 扩展源码、扫
`providers/*/.env` 的做法已经全部移除：写别人源码的能力搬去了需要用户自行安装并手动开启的「补丁台」
（`cortico-world-patchkit`），本扩展既不依赖它、也不为它做任何事。

老机器升级上来的注意：0.6.2 及更早版本可能在第三方 QQ 扩展里留下过改动与 `.coopanion-orig` 备份，
卸载本扩展**不会**把这些改动还原。要回到上游原样，就重装对应的 QQ 扩展，或把 `.coopanion-orig`
备份盖回去。新版本不会再产生这类改动。

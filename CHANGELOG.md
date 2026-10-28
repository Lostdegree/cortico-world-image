# Changelog

## 0.6.0

- **新版 QQ 扩展（`cortico-world-qq-final` 0.6.28 起）不再打补丁**：它只发布压缩后的 `dist/index.js`，`src/normalize.ts` / `src/world.ts` 根本不存在，0.5.7–0.5.9 的那两处补丁无处可打。补丁清单从 4 处降到 2 处，状态页对 qq-final 的提示改成「去改目录」，不再提补丁。
- 新增 `qqFinalShare(appRoot, imagePath)`：读宿主配置 `worlds.qqbot.imageDir`（默认扩展目录下的 `images/`，相对值按扩展目录解析），图片就在里面（含子目录）就把 `[图片:文件名]` 算好写进工具回执让模型抄；不在就明说该把哪个目录指过来。新版本来就是「只认图片库里的文件名」，从 0.6.36 反编出来的正则还写死 40 字上限（绝对路径 60–90 字永远匹配不到），所以指目录比改代码更稳。
- 状态面板「QQ 发图路径」卡片多一行：qq-final 的图片库目录指到图片工坊了没有。指向别处时会直接把应填的路径写出来。
- 修：回执里 `[图片:…]` 的提示从「无条件写一句」改成按实际情况说，不再让模型写出会被丢弃的绝对路径。
- 旧的两处补丁原样保留（只针对老版 `cortico-world-qq-better-alont1`，没装就不进总数）。

## 0.5.8

- 修新版 QQ 扩展里 `[图片:blobs/x.jpg]` 这类**相对路径**发了没反应：解析助手过去只按图片库目录与 `process.cwd()` 拼，而 coopanion 的桌宠工作区在 `<安装>\data\home\companion\workspace`，两头都拼不到。现在会从 `cwd` 与图片库目录逐级往上找 6 层，把 `workspace/`、`blobs/`、`data/home/companion/workspace/` 都当基底试一遍。
- 顺带修 0.5.7 的替换逻辑在 CRLF 源码上认不出结尾的问题（真装的 qq-final 就是 CRLF，补丁会记「结构认不出来」而不动手）。
- 边界不变：图片库文件名最优先，带 `..` 一律拒绝，只认图片扩展名，长度上限 1024。

## 0.5.7

- 修 QQ 发图 `[图片:G:\…\blobs\x.png]` 被当**普通文本**发出去：上游那行标签正则写死了「方括号内最多 40 个字符」，而 Windows 绝对路径动辄 60–90 字，根本匹配不到。
- 补丁只把 `表情包:` / `图片:` 两种标签放宽到 900 字，普通 `[……]` 仍是 40 字，不会把长段括注误认成图片。

## 0.5.6

- 支持新版第三方 QQ 扩展 `cortico-world-qq-final`：`qq_send` 正文里的 `[图片:…]` 认**绝对/相对路径**，工具说明同步写明（两个补丁：`qqf-image-paths`、`qqf-image-hints`）。
- 四个 QQ 补丁统一按世界开关让路（`worlds.qqbot.enabled` 不是 `true` 就整段跳过）。

## 0.5.5

- 修 #3：云端那档把 `size` 别名（`square` / `portrait` / `16:9`…）原样透传给上游，被包装成「503 无返回结果」把人往提示词方向带。现在统一折算成 `宽x高`，认不出的**不发这个字段**，回执里说明这次按默认尺寸出图。
- 状态页也能自检（`status.selftest`），不再报「未知面板方法」。

## 0.5.4

- `size` 支持比例与别名（`16:9`、`9:16`、`portrait`、`3:4`…），按比例折算宽高并对齐到 8 的倍数，最长边 1536。
- 修宿主配置 `size: "auto"` 时每一档都继承成 `1024x1024`、图生图被压成方图的问题；`auto` 现在表示「不指定，交给模型」。

## 0.5.3

- ComfyUI 执行阶段（`/history` 里回 `error`）的报错也翻成人话，例如「裸模型被放进 checkpoints，应该放 diffusion_models」。

## 0.5.2

- ComfyUI 校验不过（文件不在列表）时把上游报错翻成人话，写清楚该把文件放进哪个子目录。

## 0.5.1

- 图生图没给尺寸时按参考图比例出图，不再一律方图；最长边仍是 1536。

## 0.5.0

- 支持裸 UNet 三件套（Anima / Flux 这类非 all-in-one 模型）：档位里写 `unet` + `textEncoder` + `vaeName`，面板「高级参数 → 模型文件」可填，编码器类型支持 `stable_diffusion` / `qwen_image` / `sd3` / `flux` / `cosmos` / `lumina2`。
- 有自定义 `workflow` 时不再强制要求 `ckpt`；探活改成按 `/object_info` 核对四类文件，拿不到就只报「在线」。

## 0.4.2

- 本地 ComfyUI 档新增「高级参数」面板：多行 LoRA（文件名 / 强度 / CLIP 强度）、负面提示词、steps、cfg、sampler、scheduler、denoise。

## 0.4.1

- 模型链从裸 JSON 改成行编辑器：一档一张卡（名称 / 类型 / 地址 / 模型或 ckpt，上移下移删除）。
- 「高级：JSON」空着打开时自带一份本地 ComfyUI + LoRA 范例，改一半收起再打开保留草稿。

## 0.4.0

- 多模型**优先级链**：按顺序试，前一档失败自动换下一档，回执写清最终是哪一档出的图。
- 新增本地 **ComfyUI 适配器**（`/prompt` → 轮询 `/history` → `/view`），支持文生图、图生图与 LoRA。
- 原本的 OpenAI 兼容云端档保留，两档可以在 `models` 里混排。

## 0.3.1

- `worlds.qqbot` 没开时跳过 QQ 补丁：不再给一个根本不加载的文件留备份，状态页也不再写「2 处都在」。

## 0.3.0

- 去掉桌宠补丁：控制台发图改用官方 `pet_say` 的 `images`（直接给 blob 句柄）。
- 旧机器上升级会自动还原被改过的桌宠源码（`.coopanion-orig`）。

## 0.2.2

- 桌宠 `describe` 补丁改成按结构匹配，上游把那一行换写法也认得出。

## 0.2.1

- 修桌宠 `describe` 漏声明 `pet_show_image` 导致的「工具不在 describe.tools 里」告警。

## 0.2.0

- 适配框架 0.2 契约（world 6）：面板改名 WebUI、产物换成 `dist/webui.js`、定义加 `describe` 并附 `describe.json` 给扩展市场读。

## 0.1.4

- QQ 说明补丁容忍上游改措辞（0.1.16 把 image 那句换成了 `/home/user` 示例）。

## 0.1.3

- 带上 PR #2：`image_edit` 在端点没有 `/images/edits` 时退回 `/images/generations`（阿里云百炼这类只给 generations 的服务）。

## 0.1.2

- 适配 Coopanion 0.1.23：框架原生支持发图后，去掉 4 处多余的补丁。

## 0.1.1

- 首个版本：用任意 OpenAI 兼容接口画图/改图，落盘成作品库，并把图贴进控制台「对话」页。

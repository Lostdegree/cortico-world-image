/**
 * 工具声明与自描述共用同一份数据。
 *
 * `tools()` 拿它加 handler，`describe.tools`（框架 0.2 起必需）直接把它去掉 handler 交出去，
 * 两边就不会漂移：框架只核对实例给出的工具**名**都在 describe.tools 里，
 * 描述或参数写岔了它看不出来，所以只能靠这里共用一份。
 *
 * 每条里 `summary` 是给人和扩展市场看的一句话（`{ zh, en }`），不进提示词，也不进 `tools()`。
 */

export const TOOL_SPECS = [
  {
    name: 'image_draw',
    description: 'Draw a picture from a text description through the configured model chain (a local ComfyUI, an OpenAI-compatible cloud endpoint, or both in priority order). '
      + 'The picture is saved to disk, attached to this conversation so you can see it, and shown in the Image Studio console page. '
      + 'The reply carries the absolute file path; hand that path to a channel tool such as qq_send_image to actually deliver the picture to someone.',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw: subject, style, composition, lighting. Any language.',
        },
        model: {
          type: 'string',
          description: 'Optional chain entry name (for example "local" or "cloud"). Leave empty to try the chain in priority order.',
        },
        note: {
          type: 'string',
          description: 'Short label for this picture in the studio list.',
        },
        size: {
          type: 'string',
          description:
            'Override the configured size: "1024x1536", a ratio like "16:9" or "4:3", or "square" / "portrait" / "landscape".',
        },
        quality: {
          type: 'string',
          description: 'Override the configured quality, e.g. low / medium / high. Ignored by ComfyUI.',
        },
      },
      required: ['prompt'],
    },
    summary: {
      zh: '按一段文字描述画一张新图（本地 ComfyUI 或云端接口，按模型链的顺序），存到磁盘、贴进对话，并显示在作品页。',
      en: 'Draw a new picture from a text description through the model chain, save it to disk and show it in the conversation.',
    },
  },
  {
    name: 'image_edit',
    description: 'Redraw existing local picture(s) following a text instruction, through the same model chain as image_draw. '
      + '`image` takes one absolute file path (or a picture id from image_gallery); `images` takes several for models that accept multiple references. '
      + 'OpenAI-compatible entries use /images/edits (multipart upload, several pictures as image[]) or a base64 `image` field on /images/generations (e.g. Aliyun Bailian, one picture only); '
      + 'ComfyUI entries upload the picture(s) and run an img2img workflow — several pictures need a custom workflow with {{image1}} / {{image2}} placeholders.',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to change or how to restyle it.' },
        image: { type: 'string', description: 'Absolute path of the source picture, or a picture id from image_gallery.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Several source pictures, same notation as `image` (absolute path or gallery id), up to 4. '
            + 'Use it when the instruction refers to more than one picture ("把这两张拼起来", "照这个风格改那张"). '
            + 'If the chosen backend cannot take several references, the tool says so instead of quietly dropping them.',
        },
        model: { type: 'string', description: 'Optional chain entry name. Leave empty to try the chain in priority order.' },
        note: { type: 'string', description: 'Short label for the result in the studio list.' },
        size: {
          type: 'string',
          description:
            'Override the output size: "1024x1024", a ratio like "16:9", or "square" / "portrait" / "landscape". ' +
            'Leave it empty to keep the source picture ratio (local ComfyUI) — that is the usual choice for edits.',
        },
        quality: { type: 'string', description: 'Override the configured quality. Ignored by ComfyUI.' },
      },
      required: ['prompt'],
    },
    summary: {
      zh: '按一句指令改已有的本地图（一张或多张参考图），结果同样落盘并贴进对话；后端吃不下多图时直说。',
      en: 'Redraw existing local picture(s) following a text instruction; says so when the backend cannot take several references.',
    },
  },
  {
    name: 'image_gallery',
    description: 'List pictures drawn so far, newest first, with their ids and absolute file paths. '
      + 'Ids can be handed to image_show.',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to list, 1-50. Defaults to 12.' },
      },
      required: [],
    },
    summary: {
      zh: '列出已经画好的图，最新的在前，带编号与绝对路径。',
      en: 'List pictures drawn so far, newest first, with their ids and absolute paths.',
    },
  },
  {
    name: 'image_show',
    description: 'Put an existing picture back in front of the user: it is re-attached to this conversation and highlighted in the Image Studio console page. '
      + 'Use it to look at or talk about an older picture again.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Picture id from image_gallery, or its absolute path.' },
      },
      required: ['id'],
    },
    summary: {
      zh: '把一张已有的图重新贴回对话，并在作品页高亮。',
      en: 'Put an existing picture back in front of the user.',
    },
  },
];

/** 给 describe 的工具表：去掉 handler，保留发给模型的字段与给人看的一句话。 */
export const toolDescribe = () => TOOL_SPECS.map(({ name, description, parameters, tags, summary }) => ({
  name, description, parameters, tags, summary,
}));

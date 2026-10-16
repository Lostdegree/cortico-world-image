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
    description: 'Draw a picture from a text description through the configured image API. '
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
        note: {
          type: 'string',
          description: 'Short label for this picture in the studio list.',
        },
        size: {
          type: 'string',
          description: 'Override the configured size, e.g. 1024x1024 or 1024x1536.',
        },
        quality: {
          type: 'string',
          description: 'Override the configured quality, e.g. low / medium / high.',
        },
      },
      required: ['prompt'],
    },
    summary: {
      zh: '按一段文字描述画一张新图，存到磁盘、贴进对话，并显示在作品页。',
      en: 'Draw a new picture from a text description, save it to disk and show it in the conversation.',
    },
  },
  {
    name: 'image_edit',
    description: 'Redraw an existing local picture with the image API, following a text instruction. '
      + '`image` takes an absolute file path, or a picture id from image_gallery. '
      + 'Works with endpoints that implement /images/edits (multipart upload) and with those that take a base64 `image` field on /images/generations instead (e.g. Aliyun Bailian).',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to change or how to restyle it.' },
        image: { type: 'string', description: 'Absolute path of the source picture, or a picture id from image_gallery.' },
        note: { type: 'string', description: 'Short label for the result in the studio list.' },
        size: { type: 'string', description: 'Override the configured size.' },
        quality: { type: 'string', description: 'Override the configured quality.' },
      },
      required: ['prompt', 'image'],
    },
    summary: {
      zh: '按一句指令改一张已有的本地图，结果同样落盘并贴进对话。',
      en: 'Redraw an existing local picture following a text instruction.',
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

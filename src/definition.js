/**
 * WorldDefinition：装配层在构造所有可用定义时也会跑 create()，
 * 所以构造函数必须是纯的（不建目录、不发请求、不读密钥也行）。
 */
import { DEFAULTS, ID, LABEL } from './config.js';
import { toolDescribe } from './tools.js';
import { ImageWorld } from './world.js';

export const imageDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.image` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  /**
   * 自描述（框架 0.2 起必需）：全部工具与会推出的事件，给人和扩展市场看，不进提示词。
   * 工具表来自 src/tools.js，与实例 tools() 同一份；这个 World 不推事件（面板推送走 stream，不算事件）。
   */
  describe: {
    tools: toolDescribe(),
    events: [],
  },
  preflight: () => {
    if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
      throw new Error('图片工坊需要 Node 22+ 的全局 fetch / FormData / Blob');
    }
  },
  create: (ctx) => new ImageWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    packageDir: ctx.packageDir,
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
  }),
};

export default imageDefinition;

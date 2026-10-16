/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * `cortico.<kind> = world`、`api = 6` 与 `keywords` 里的 `cortico-world` 见 package.json。
 */
import definition, { imageDefinition } from './definition.js';

export default definition;
export { imageDefinition };
export { ImageWorld } from './world.js';
export { ID as IMAGE_WORLD_ID, DEFAULTS as IMAGE_DEFAULTS } from './config.js';

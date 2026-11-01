/**
 * 「本地出图后空闲 N 分钟，就让 ComfyUI 把模型从显存里卸掉」的那点算术。
 *
 * 单独放一个文件，是为了让规则能被测试直接钉住：`usedAt` 是「这个地址最后一次被用」
 * 的时间戳表，纯函数算出「现在该卸谁」和「下一次什么时候再看」。
 */

/** 把配置里的分钟数收成可用值：0 / 负数 / 非数字都算「关」。 */
export function idleMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : 0;
}

/** 现在该卸载的地址（最后一次使用距今 ≥ minutes 分钟）。 */
export function dueTargets(usedAt, now, minutes) {
  const m = idleMinutes(minutes);
  if (!m || !(usedAt instanceof Map)) return [];
  const deadline = m * 60000;
  const due = [];
  for (const [baseUrl, at] of usedAt) {
    const used = Number(at);
    if (!Number.isFinite(used)) { due.push(baseUrl); continue; }
    if (now - used >= deadline) due.push(baseUrl);
  }
  return due;
}

/** 下一次检查该等多久（毫秒）：取「最早到点」的那个；没有目标返回 0。 */
export function nextDelay(usedAt, now, minutes) {
  const m = idleMinutes(minutes);
  if (!m || !(usedAt instanceof Map) || usedAt.size === 0) return 0;
  const deadline = m * 60000;
  let wait = Infinity;
  for (const at of usedAt.values()) {
    const used = Number(at);
    const left = Number.isFinite(used) ? deadline - (now - used) : 0;
    if (left < wait) wait = left;
  }
  return Number.isFinite(wait) ? Math.max(0, Math.round(wait)) : 0;
}

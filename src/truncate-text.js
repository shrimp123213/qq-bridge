// 按码点截断文本的小工具：桥接里所有"截断给人看"的地方共用。

/**
 * 截断到最多 `max` 个字符，**绝不切开代理对**。
 *
 * 为什么不直接用 `text.slice(0, max)`：`String.prototype.slice` 按 UTF-16 **码元**切，
 * 而聊天里常见的 emoji / 生僻字占**两个**码元。切点正好落在中间时会留下一个孤立高代理
 * ——它不是一个合法字符，写进 JSON、日志、提示词后一律渲染成替换符（�）。
 * 桥接里"截断给人看"的地方很多（记忆、旁观窗口、消息详情、角色卡），全部中招。
 *
 * 语义：上限按**码点**算（对纯 BMP 文本与 slice 完全一致；对含 emoji 的文本只多留不切坏）。
 * `max` 非有限数时返回空串 —— 与 `slice(0, NaN)` 的既有行为一致，不做静默放宽。
 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 切在高代理上：前移一个码元
  if (cut <= 0) { // limit=1 且开头就是代理对：至少保留一个完整码点
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
  }
  return s.slice(0, cut);
}

/**
 * {@link truncateText} 的尾部版本：保留**最后** `max` 个字符。
 *
 * 对应 `text.slice(-max)` —— 它同样按码元切，只是切点落在**低**代理上：
 * 结果开头会多出一个孤立低代理，同样是坏字符。判据镜像处理。
 */
export function truncateTextTail(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let start = s.length - limit;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) { // 切点在低代理上
    const before = s.charCodeAt(start - 1);
    // 前面是高代理 ⇒ 这对是一个完整字符，一起留下（宁可多一个码元，也不留孤立代理）；
    // 否则是畸形输入里的孤儿低代理，丢掉它。
    start = (start > 0 && before >= 0xd800 && before <= 0xdbff) ? start - 1 : start + 1;
  }
  return s.slice(start);
}

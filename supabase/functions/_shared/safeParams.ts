// 解析 URL 查询参数:防御 NaN 攻击
// 原代码: const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'))
// 当 searchParams.get('page') = 'abc' 时, parseInt 返回 NaN,
// Math.max(1, NaN) 也返回 NaN, 后续 .range(NaN, NaN) 触发 500
// 现在返回安全默认值 (1)
export function safeParseInt(value: string | null | undefined, fallback: number, min = 1, max?: number): number {
  if (value == null) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

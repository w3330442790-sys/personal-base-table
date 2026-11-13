/** 把滚轮事件换算成表格视口的滚动增量:Shift 横向、触控板横向、表格横向溢出时兜底。 */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}
export interface ScrollMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}
export interface ScrollDelta {
  dx: number;
  dy: number;
}

const OVERFLOW = 1;

export function wheelScroll(input: WheelInput, metrics: ScrollMetrics, lineHeight = 16): ScrollDelta | null {
  // Ctrl/Cmd + 滚轮留给缩放,不拦截
  if (input.ctrlKey || input.metaKey) return null;
  const scale = input.deltaMode === 1 ? lineHeight : input.deltaMode === 2 ? Math.max(metrics.clientWidth, metrics.clientHeight, 1) : 1;
  const x = input.deltaX * scale;
  const y = input.deltaY * scale;
  if (!x && !y) return null;
  const horizontal = metrics.scrollWidth - metrics.clientWidth > OVERFLOW;
  const vertical = metrics.scrollHeight - metrics.clientHeight > OVERFLOW;
  if (!horizontal && !vertical) return null;
  if (input.shiftKey) return horizontal ? { dx: x || y, dy: 0 } : null;
  if (Math.abs(x) > Math.abs(y)) return horizontal ? { dx: x, dy: 0 } : null;
  if (vertical) return { dx: 0, dy: y };
  return horizontal ? { dx: y, dy: 0 } : null;
}

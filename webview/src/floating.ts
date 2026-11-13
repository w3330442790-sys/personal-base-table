export interface FloatingAnchor {
  element: HTMLElement;
  offsetX: number;
  offsetY: number;
}

export function pointerAnchor(element: HTMLElement, x: number, y: number): FloatingAnchor {
  const rect = element.getBoundingClientRect();
  return { element, offsetX: x - rect.left, offsetY: y - rect.top };
}

export function belowAnchor(element: HTMLElement): FloatingAnchor {
  return { element, offsetX: 0, offsetY: element.getBoundingClientRect().height + 4 };
}

export function floatingPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } {
  return {
    left: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

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

export interface FloatingBounds { left: number; top: number; width: number; height: number }

export function visibleViewport(view: { innerWidth: number; innerHeight: number; visualViewport?: Pick<VisualViewport, 'offsetLeft' | 'offsetTop' | 'width' | 'height'> | null }): FloatingBounds {
  const viewport = view.visualViewport;
  return viewport
    ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
    : { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
}

/** Intersect client-coordinate rectangles, returning coordinates local to the owner. */
export function visibleOwnerBounds(owner: FloatingBounds, viewport: FloatingBounds): FloatingBounds {
  const left = Math.max(owner.left, viewport.left);
  const top = Math.max(owner.top, viewport.top);
  return {
    left: Math.min(owner.width, Math.max(0, left - owner.left)),
    top: Math.min(owner.height, Math.max(0, top - owner.top)),
    width: Math.max(0, Math.min(owner.left + owner.width, viewport.left + viewport.width) - left),
    height: Math.max(0, Math.min(owner.top + owner.height, viewport.top + viewport.height) - top),
  };
}

export function floatingPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, viewportLeft = 0, viewportTop = 0): { left: number; top: number } {
  return {
    left: Math.max(viewportLeft + 8, Math.min(x, viewportLeft + viewportWidth - width - 8)),
    top: Math.max(viewportTop + 8, Math.min(y, viewportTop + viewportHeight - height - 8)),
  };
}

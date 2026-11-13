import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { floatingPosition, type FloatingAnchor } from "./floating";

/** Portals escape Obsidian leaf containment while retaining the table theme. */
export function FloatingPanel({ anchor, className, role = "dialog", onDismiss, children }: {
  anchor: FloatingAnchor;
  className: string;
  role?: "dialog" | "menu";
  onDismiss: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [theme, setTheme] = useState<CSSProperties>({});
  const document = anchor.element.ownerDocument;
  const view = document.defaultView ?? window;
  const surface = anchor.element.closest(".wbt-root");

  useLayoutEffect(() => {
    const computed = view.getComputedStyle(anchor.element);
    const properties: Record<string, string> = {};
    for (let i = 0; i < computed.length; i++) {
      const property = computed[i];
      if (property.startsWith("--")) properties[property] = computed.getPropertyValue(property);
    }
    setTheme(properties as CSSProperties);
    const update = () => {
      if (!anchor.element.isConnected) { onDismiss(); return; }
      if (!panel.current) return;
      const target = anchor.element.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const next = floatingPosition(target.left + anchor.offsetX, target.top + anchor.offsetY, bounds.width, bounds.height, view.innerWidth, view.innerHeight);
      setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next);
    };
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.element.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onDismiss(); } };
    update();
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    observer.observe(anchor.element);
    document.addEventListener("scroll", update, true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    view.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", update, true);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      view.removeEventListener("resize", update);
    };
  }, [anchor, document, view, onDismiss]);

  return createPortal(<div className={`${surface?.className ?? "wbt-root"} personal-floating-root`} style={{ ...theme, position: "fixed", width: 0, height: 0, background: "transparent", pointerEvents: "none", zIndex: 1000 }}>
    <div ref={panel} role={role} className={className} style={{ position: "fixed", ...position, pointerEvents: "auto", maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)", overflowY: "auto", boxSizing: "border-box", margin: 0 }} onMouseDown={event => event.stopPropagation()}>
      {children}
    </div>
  </div>, document.body);
}

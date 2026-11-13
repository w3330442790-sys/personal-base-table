import { useLayoutEffect, useState, type RefObject } from 'react';
import { visibleWorkbookHeight } from './tablet-viewport';

export function useTabletViewport(ref: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [viewport, setViewport] = useState<{ height?: number; keyboard: boolean }>({ keyboard: false });
  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    const visual = view.visualViewport;
    const update = () => {
      // A reduced visual viewport with scale=1 is the Android keyboard, not pinch zoom.
      const keyboard = !!visual && visual.scale === 1 && visual.height < view.innerHeight * .8;
      const top = element.getBoundingClientRect().top;
      const parentBottom = element.parentElement?.getBoundingClientRect().bottom ?? view.innerHeight;
      const height = visual && visual.scale === 1 ? visibleWorkbookHeight(top, Math.max(0, parentBottom - top), { top: visual.offsetTop, height: visual.height }) : undefined;
      setViewport(previous => previous.height === height && previous.keyboard === keyboard ? previous : { height, keyboard });
    };
    update();
    const observer = new ResizeObserver(update);
    if (element.parentElement) observer.observe(element.parentElement);
    view.addEventListener('resize', update);
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    return () => { observer.disconnect(); view.removeEventListener('resize', update); visual?.removeEventListener('resize', update); visual?.removeEventListener('scroll', update); };
  }, [ref, ready]);
  return viewport;
}

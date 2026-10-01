import { useLayoutEffect, useRef, useState } from "react";

const SLACK_PX = 16;

const px = (value: string) => Number.parseFloat(value) || 0;

function natural(group: Element): number {
  const items = [...group.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetWidth > 0);
  const gap = px(getComputedStyle(group).columnGap);
  return items.reduce((sum, item) => sum + item.offsetWidth, 0) + gap * Math.max(0, items.length - 1);
}

function overflow(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const groups = [...row.children];
  const gap = px(style.columnGap) * Math.max(0, groups.length - 1);
  const need = px(style.paddingLeft) + px(style.paddingRight) + gap + groups.reduce((sum, group) => sum + natural(group), 0);
  return need - row.clientWidth;
}

export function useComposerFit() {
  const root = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ narrow: false, threshold: 0 });

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const check = () => {
      const width = element.clientWidth;
      const over = row ? overflow(row) : 0;
      setFit((prev) => {
        if (row) return over > 0 ? { narrow: true, threshold: width + over } : prev;
        return prev.narrow && width >= prev.threshold + SLACK_PX ? { narrow: false, threshold: prev.threshold } : prev;
      });
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [row]);

  return { root, row: setRow, narrow: fit.narrow };
}

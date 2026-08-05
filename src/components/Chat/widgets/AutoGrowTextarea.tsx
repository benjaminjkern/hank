"use client";

// Auto-growing textarea — mirrors the composer's input behavior (starts at
// `minRows`, expands on line-wrap up to `maxRows`, then scrolls internally).
// The composer keeps its own bespoke autosize because it's tangled with focus
// management + the thinking shimmer; this is the shared version for widget
// inputs (e.g. the shortlist note). Reads line-height / padding off the live
// computed style so any styled() wrapper's typography is respected without
// hard-coding pixel constants. forwardRef so styled(AutoGrowTextarea) can pass
// a ref through without a React warning.

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  minRows?: number;
  maxRows?: number;
};

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function AutoGrowTextarea(
    { minRows = 2, maxRows = 6, value, ...rest },
    externalRef,
  ) {
    const innerRef = useRef<HTMLTextAreaElement>(null);

    const setRefs = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof externalRef === "function") externalRef(node);
        else if (externalRef) externalRef.current = node;
      },
      [externalRef],
    );

    const autosize = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      const extra =
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth) +
        parseFloat(cs.borderBottomWidth);
      const min = Math.round(line * minRows + extra);
      const max = Math.round(line * maxRows + extra);
      el.style.height = "auto";
      const next = Math.min(max, Math.max(min, el.scrollHeight));
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    }, [minRows, maxRows]);

    // Re-fit on every value change (typing OR programmatic reset).
    useEffect(() => {
      autosize();
    }, [value, autosize]);

    // Re-fit when the textarea's width changes (panel resize, mobile rotation)
    // — text wraps differently so scrollHeight changes. Width-only filter
    // avoids the feedback loop where autosize itself changes the height.
    useEffect(() => {
      const el = innerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      let lastWidth = el.offsetWidth;
      const ro = new ResizeObserver(() => {
        const node = innerRef.current;
        if (!node) return;
        const w = node.offsetWidth;
        if (w === lastWidth) return;
        lastWidth = w;
        autosize();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [autosize]);

    return <textarea ref={setRefs} value={value} rows={minRows} {...rest} />;
  },
);

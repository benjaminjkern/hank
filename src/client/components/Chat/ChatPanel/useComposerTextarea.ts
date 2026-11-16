import { useEffect, useRef } from "react";

import { INPUT_MAX_HEIGHT, INPUT_MIN_HEIGHT } from "./inputBarStyles";

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  const next = Math.min(
    INPUT_MAX_HEIGHT,
    Math.max(INPUT_MIN_HEIGHT, el.scrollHeight),
  );
  el.style.height = `${next}px`;
}

// The composer textarea's DOM behaviour: autosize to its content, and take
// focus when the user starts typing anywhere else on the page. Returns the ref
// to attach to the textarea.
export function useComposerTextarea(text: string) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Re-fit whenever the controlled value changes (typing OR programmatic clear
  // after submit).
  useEffect(() => {
    autosize(inputRef.current);
  }, [text]);

  // Re-fit when the textarea's width changes (window resize, right-pane
  // collapse, mobile rotation). Text wraps differently at different widths, so
  // scrollHeight changes — without this the textarea keeps its last height and
  // shows a stale scrollbar (or extra whitespace). Width-only filter avoids
  // the feedback loop where autosize itself changes the height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (!inputRef.current) return;
      const w = inputRef.current.offsetWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      autosize(inputRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-focus the composer when the user starts typing anywhere outside an
  // editable element. The keydown fires before the character commits, so
  // focusing the textarea here routes the resulting input event into it
  // without losing the first keystroke. Skips modifier-keyed shortcuts
  // (Cmd/Ctrl/Alt + key), non-printable keys, when the user is already typing
  // in another field, and while streaming (textarea is disabled).
  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent) {
      const el = inputRef.current;
      if (!el || el.disabled) return;
      if (document.activeElement === el) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      el.focus();
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  return inputRef;
}

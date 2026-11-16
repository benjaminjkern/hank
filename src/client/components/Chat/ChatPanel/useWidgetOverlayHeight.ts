import { useEffect, useRef, useState } from "react";

export function useWidgetOverlayHeight(isEmpty: boolean) {
  // Live height of the sticky widget overlay, fed into MessagesScroll's bottom
  // padding (so the latest message clears the card) and the jump-to-bottom
  // button's offset. 0 when no widget is mounted (overlay shrinks to nothing).
  const [widgetHeight, setWidgetHeight] = useState(0);
  const widgetSlotRef = useRef<HTMLDivElement>(null);

  // Track the widget overlay's height so the scroll region can reserve room
  // below the last message. Re-attaches when the overlay mounts/unmounts with
  // the empty-state swap; the ResizeObserver then catches widget
  // mount/minimize/content changes. Empty overlay (no widget) measures ~0.
  useEffect(() => {
    const el = widgetSlotRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      setWidgetHeight(0);
      return;
    }
    const update = () => setWidgetHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isEmpty]);

  return { widgetHeight, widgetSlotRef };
}

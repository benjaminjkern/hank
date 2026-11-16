"use client";

// What an old session shows in place of a widget whose kind has since been
// retired (see shared/widgetKinds.ts). Only reachable when such a widget is
// still the last thing in the chat — typing past a widget retires it anyway —
// so it says what the card is, why there's nothing to click, and what to do.

import { Meta } from "./sharedStyles";
import { WidgetShell } from "./WidgetShell";

export function RetiredWidget() {
  return (
    <WidgetShell title="An older question" minimizable={false}>
      <Meta>
        This question is from an older version of Hank, so it can’t be answered
        here anymore. Just say in chat what you’d like to do.
      </Meta>
    </WidgetShell>
  );
}

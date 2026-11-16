import { useEffect, useState } from "react";

import { useChatStore } from "@/client/chatStore";

// The composer's controlled text, plus the one path that writes it from
// outside: a message the server bounced back to be retyped.
export function useComposerText() {
  const [text, setText] = useState("");

  // The ALREADY_STREAMING reject path stashes the typed message on the store
  // so we can put it back in the composer here. Clear the slot on consume so
  // a second reject doesn't double-write. Append to whatever's currently
  // typed, with a separator, so we never silently overwrite something the
  // user retyped in the gap.
  const restoreText = useChatStore((s) => s.restoreComposerText);
  useEffect(() => {
    if (restoreText === null) return;
    setText((cur) =>
      cur.length === 0 ? restoreText : `${cur}\n\n${restoreText}`,
    );
    useChatStore.setState({ restoreComposerText: null });
  }, [restoreText]);

  return [text, setText] as const;
}

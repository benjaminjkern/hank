import { useState } from "react";

import type { ErrorSegment } from "@/client/chatStore";

import { Caret } from "../../RightPanel/shared/Caret";

import {
  ErrorChip,
  ToolBlock,
  ToolExpanded,
  ToolFieldLabel,
  ToolHeaderButton,
  ToolPre,
} from "./toolChipStyles";

// One thing the user needs to know, and everything else folded away. A failed
// run's detail is operator text — a Prisma code, an HTTP status, a stack — so
// the collapsed row says only that this stopped short, and the caret opens the
// raw message for when the maintainer (or a bug report) wants it. Same chrome as the tool
// chip on purpose: expandable-thing-in-a-bubble already reads as one pattern.
const ERROR_CHIP_LABEL = "Something went wrong — this step didn't finish";

export function ExpandableError({ segment }: { segment: ErrorSegment }) {
  const [open, setOpen] = useState(false);
  return (
    <ToolBlock>
      <ToolHeaderButton
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Caret open={open} size={9} />
        <ErrorChip>{ERROR_CHIP_LABEL}</ErrorChip>
      </ToolHeaderButton>
      {open && (
        <ToolExpanded>
          <ToolFieldLabel>error</ToolFieldLabel>
          <ToolPre>{segment.detail}</ToolPre>
        </ToolExpanded>
      )}
    </ToolBlock>
  );
}

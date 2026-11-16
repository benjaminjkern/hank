import { useMemo, useState } from "react";

import type { ToolSegment } from "@/client/chatStore";
import { stripToolErrorMarker } from "@/shared/toolErrorMarker";

import { Caret } from "../../RightPanel/shared/Caret";

import { SegmentView } from "./SegmentView";
import {
  ToolBlock,
  ToolChildren,
  ToolChip,
  ToolExpanded,
  ToolFieldLabel,
  ToolHeaderButton,
  ToolPre,
  ToolProgress,
} from "./toolChipStyles";

// Single tool chip. Header (chip + caret) toggles an expanded panel showing:
//   1. the input args this tool was called with,
//   2. the result string the tool returned (when available),
//   3. recursive children — sub-agent inner steps (text + nested tool chips
//      that are themselves expandable).
export function ExpandableToolChip({
  segment,
  role,
}: {
  segment: ToolSegment;
  role: "user" | "assistant";
}) {
  const [open, setOpen] = useState(false);

  const hasChildren = segment.children && segment.children.length > 0;
  const inputJson = useMemo(() => {
    try {
      return JSON.stringify(segment.input ?? {}, null, 2);
    } catch {
      return String(segment.input);
    }
  }, [segment.input]);

  return (
    <ToolBlock>
      <ToolHeaderButton
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Caret open={open} size={9} />
        <ToolChip $status={segment.status}>{segment.name}</ToolChip>
      </ToolHeaderButton>
      {segment.progressLabel && segment.status === "pending" && (
        <ToolProgress>{segment.progressLabel}</ToolProgress>
      )}
      {open && (
        <ToolExpanded>
          <ToolFieldLabel>input</ToolFieldLabel>
          <ToolPre>{inputJson}</ToolPre>
          {segment.result !== undefined ? (
            <>
              <ToolFieldLabel>
                {segment.status === "error" ? "error" : "result"}
              </ToolFieldLabel>
              <ToolPre>{stripToolErrorMarker(segment.result)}</ToolPre>
            </>
          ) : (
            <ToolFieldLabel>running…</ToolFieldLabel>
          )}
          {hasChildren && (
            <>
              <ToolFieldLabel>sub-agent activity</ToolFieldLabel>
              <ToolChildren>
                {segment.children!.map((child, i) => (
                  <SegmentView key={i} segment={child} role={role} />
                ))}
              </ToolChildren>
            </>
          )}
        </ToolExpanded>
      )}
    </ToolBlock>
  );
}

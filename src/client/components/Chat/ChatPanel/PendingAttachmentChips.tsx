import {
  AttachmentRow,
  ChipClose,
  PendingChip,
  PendingName,
  PendingStatus,
} from "./composerChipStyles";

import type { PendingAttachment } from "./storeTypes";

// Files staged for the next send, one chip each, above the composer.
export function PendingAttachmentChips({
  pendingAttachments,
  removePending,
}: {
  pendingAttachments: PendingAttachment[];
  removePending: (tempId: string) => void;
}) {
  if (pendingAttachments.length === 0) return null;
  return (
    <AttachmentRow>
      {pendingAttachments.map((p) => (
        <PendingChip key={p.tempId} $status={p.status} title={p.error}>
          📎 <PendingName>{p.fileName}</PendingName>
          {p.status === "uploading" && (
            <PendingStatus>uploading…</PendingStatus>
          )}
          {p.status === "error" && <PendingStatus>error</PendingStatus>}
          <ChipClose
            onClick={() => removePending(p.tempId)}
            aria-label="remove attachment"
          >
            ×
          </ChipClose>
        </PendingChip>
      ))}
    </AttachmentRow>
  );
}

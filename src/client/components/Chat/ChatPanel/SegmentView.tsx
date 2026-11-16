import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styled from "styled-components";

import type { Segment } from "@/client/chatStore";
import { splitFocusRefTokens } from "@/shared/focusRefToken";
import type { FocusRefTokenPiece } from "@/shared/focusRefToken";
import { splitJobRefTokens } from "@/shared/jobRefToken";
import type { JobRefTokenPiece } from "@/shared/jobRefToken";

import { ExpandableError } from "./ExpandableError";
import { ExpandableToolChip } from "./ExpandableToolChip";
import { MarkdownText, UserText } from "./messageTextStyles";
import { FocusRefChip, JobRefChip } from "./RefChips";

// Pipeline status line — emitted by the deterministic state machine for things
// like "Running shortlist over 15 jobs". Distinct from regular agent text:
// muted background, monospace-ish look, centered, no chat-bubble framing. The
// LLM sees these rendered to plain text on replay (loadSessionMessages converts
// the pipeline_status block into a non-assistant provenance note).
const StatusLine = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: ${({ theme }) => theme.space.xs} 0;
  padding: 6px 12px;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-left: 2px solid ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.sm};
  width: fit-content;
  max-width: 100%;

  &::before {
    content: "▸";
    color: ${({ theme }) => theme.colors.accent};
  }
`;

export function SegmentView({
  segment,
  role,
}: {
  segment: Segment;
  role: "user" | "assistant";
}) {
  if (segment.kind === "tool") {
    return <ExpandableToolChip segment={segment} role={role} />;
  }
  if (segment.kind === "job-ref") {
    return <JobRefChip jobId={segment.jobId} label={segment.label} />;
  }
  if (segment.kind === "status") {
    // Status lines may carry inline <focus-ref/> tokens (emitted by the show_*
    // tools / focus-change seams) that split out into clickable chips at render.
    const parts = splitFocusRefTokens(segment.text);
    return (
      <StatusLine>
        {parts.map((p, i) =>
          p.kind === "focus-ref" ? (
            <FocusRefChip
              key={i}
              {...(p.refKind === "discovery"
                ? { refKind: p.refKind }
                : { refKind: p.refKind, id: p.id })}
              label={p.label}
            />
          ) : (
            p.text
          ),
        )}
      </StatusLine>
    );
  }
  if (segment.kind === "error") {
    return <ExpandableError segment={segment} />;
  }
  if (segment.kind === "widget") {
    // Pipeline widgets render via PipelineWidgetSlot above the composer.
    // Inline rendering is intentionally empty so the message bubble doesn't
    // double-render the widget below the chip. The sticky-bar widget reads
    // the latest WidgetSegment out of message history.
    return null;
  }
  // segment.kind === "text" — may carry inline chips from either token
  // vocabulary: <job-ref/> (a role) and <focus-ref/> (a destination, which the
  // deterministic layer also emits on this channel when the line is prose rather
  // than a status ping). Split on focus-refs first, then run each remaining text
  // run through the job-ref splitter, so one flat list covers both. User text
  // renders verbatim around the chips; assistant text runs each text piece
  // through ReactMarkdown.
  const pieces = splitFocusRefTokens(segment.text).flatMap(
    (p, i): InlinePiece[] =>
      p.kind === "text"
        ? splitJobRefTokens(p.text).map((q, j) => ({ ...q, key: `${i}.${j}` }))
        : [{ ...p, key: `${i}` }],
  );
  const chipFor = (p: Exclude<InlinePiece, { kind: "text" }>) =>
    p.kind === "job-ref" ? (
      <JobRefChip key={p.key} jobId={p.jobId} label={p.label} />
    ) : (
      <FocusRefChip
        key={p.key}
        {...(p.refKind === "discovery"
          ? { refKind: p.refKind }
          : { refKind: p.refKind, id: p.id })}
        label={p.label}
      />
    );
  if (role === "user") {
    return (
      <UserText>
        {pieces.map((p) => (p.kind === "text" ? p.text : chipFor(p)))}
      </UserText>
    );
  }
  return (
    <MarkdownText>
      {pieces.map((p) =>
        p.kind === "text" ? (
          <ReactMarkdown key={p.key} remarkPlugins={[remarkGfm]}>
            {p.text}
          </ReactMarkdown>
        ) : (
          chipFor(p)
        ),
      )}
    </MarkdownText>
  );
}

// A rendered run of one text segment: the two inline-chip vocabularies plus the
// plain text between them, keyed once so a nested split still yields one flat
// list. See the composition in the text branch above.
type InlinePiece = (FocusRefTokenPiece | JobRefTokenPiece) & { key: string };

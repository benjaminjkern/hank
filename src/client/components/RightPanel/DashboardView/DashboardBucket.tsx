import styled from "styled-components";

import { toneColor } from "@/shared/statusColors";

import { BUCKET_META, BUCKET_TONE, type Bucket } from "./buckets";

import type { ReactNode } from "react";

// One bucket: collapsible header on top, content below. Hierarchy comes
// from typography (larger title, muted count) + a small tone-colored dot
// before the title — the dot carries the section's identity without the
// "Trello column" feel of a full-bleed stripe. The whole header is a button;
// hover tints with the tone color so the urgent section reads as urgent on
// touch. `title` attribute carries the bucket hint as a hover tooltip.
const BucketSection = styled.section`
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const BucketHeader = styled.button<{ $tone: Bucket }>`
  // Width = container + 24px, shifted left by 12px, so the box hangs 12px past
  // the cards on each side. width:100% with negative right margin alone is
  // asymmetric — margin-right doesn't move the right edge when width is fixed.
  width: calc(100% + ${({ theme }) => theme.space.md} * 2);
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  margin: 0 -${({ theme }) => theme.space.md} ${({ theme }) => theme.space.sm};
  border: none;
  background: transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background 0.12s ease;

  /* color-mix lets us derive a soft tinted bg per tone without burning
     a dedicated theme color per bucket. ~8% alpha reads as a subtle
     wash, not a panel — supported in evergreen browsers since 2023. */
  &:hover {
    background: ${({ theme, $tone }) =>
      `color-mix(in srgb, ${toneColor(theme, BUCKET_TONE[$tone])} 8%, transparent)`};
  }
`;

const BucketDot = styled.span<{ $tone: Bucket }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme, $tone }) => toneColor(theme, BUCKET_TONE[$tone])};
  flex-shrink: 0;
`;

// SVG chevron rather than a unicode glyph: a text caret like ▸ sits
// asymmetrically inside its em box, so rotating the box pivots around a
// point that isn't the visible mark — the open state ends up looking
// off-center. The SVG draws the chevron centered in its viewBox so a
// 90deg rotation pivots cleanly around the visible apex.
const BucketCaret = styled.svg<{ $open: boolean }>`
  width: 10px;
  height: 10px;
  display: block;
  color: ${({ theme }) => theme.colors.textSubtle};
  flex-shrink: 0;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s ease;
`;

const BucketCount = styled.span`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  margin-left: auto;
`;

const BucketTitle = styled.h3`
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

// `children` renders only while the bucket is open. The count hides at zero
// (only the always-shown Now bucket can be empty).
export function DashboardBucket({
  bucket,
  count,
  open,
  onToggle,
  children,
}: {
  bucket: Bucket;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <BucketSection>
      <BucketHeader
        $tone={bucket}
        onClick={onToggle}
        type="button"
        title={BUCKET_META[bucket].hint}
      >
        <BucketCaret $open={open} viewBox="0 0 10 10" aria-hidden>
          <path
            d="M3.5 2 L7 5 L3.5 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </BucketCaret>
        <BucketDot $tone={bucket} />
        <BucketTitle>{BUCKET_META[bucket].label}</BucketTitle>
        {count > 0 && <BucketCount>{count}</BucketCount>}
      </BucketHeader>
      {open && children}
    </BucketSection>
  );
}

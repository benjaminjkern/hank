"use client";

import {
  memo,
  useState,
  useRef,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
  type DragEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styled from "styled-components";

import { ClientErrorBoundary } from "@/components/ClientErrorBoundary";
import {
  useChatStore,
  type ErrorSegment,
  type Segment,
  type ToolSegment,
  type MessageView,
} from "@/lib/chatStore";
import { splitFocusRefTokens } from "@/lib/focusRefToken";
import type { FocusRefTokenPiece } from "@/lib/focusRefToken";
import { splitJobRefTokens } from "@/lib/jobRefToken";
import type { JobRefTokenPiece } from "@/lib/jobRefToken";
import { NEGOTIATION_PANELS, type NegotiationPanel } from "@/lib/panelMode";
import { stripToolErrorMarker } from "@/server/agent/tools/lib/toolError";

import { HankLogo } from "../HankLogo";

import { DropOverlay } from "./DropOverlay";
import {
  ShortlistCommitCard,
  tryParseShortlistCommit,
} from "./ShortlistCommitCard";
import { PipelineWidgetSlot } from "./widgets";
import { tryParseShortlistProposal } from "./widgets/registry/shortlistProposal/def";
import {
  WidgetResponseCard,
  tryParseWidgetResponse,
} from "./widgets/WidgetResponseCard";

// Flex column. Empty state inserts two `<Spacer />`s (flex: 1) above + below
// the hero/composer block, vertically centering it. Non-empty state swaps the
// spacers out and gives MessagesArea `flex: 1` so it grows to fill while the
// composer docks naturally at the bottom. Stable keys on every child let the
// Composer reuse its mount across the swap (preserves textarea state).
//
// `height: 100%` resolves against the Pane (which sets explicit `height: 100%`
// + `min-height: 0`) so the chain is reliable. Don't substitute `100dvh - topBar`
// — on narrow viewports SplitLayout adds a PanelTabs row above the body, and a
// hardcoded `100dvh - topBar` ignores it, leaving the panel taller than its cell
// and overflowing the viewport.
const Root = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`;

// Pure flex spacer — fills the leftover vertical space above + below the
// centered welcome block. Disappears entirely (no DOM node) in non-empty state.
const Spacer = styled.div`
  flex-grow: 1;
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 0;
`;

// Wrapper around the scroll container so absolutely-positioned overlays (the
// jump-to-bottom button) don't scroll with the message content. `flex: 1`
// makes it claim the leftover space in the Root column once messages exist,
// docking the composer at the bottom.
const MessagesArea = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
`;

const MessagesScroll = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.lg};
`;

// Holds the sticky pipeline widget. Absolutely positioned so it overlays the
// bottom of the chat scroll (z-index above messages) rather than stealing
// layout height — MessagesScroll reserves bottom padding (= this overlay's
// measured height) so the latest message clears it. Capped at 70% of the chat
// area; `pointer-events: none` lets clicks fall through the side gutters to the
// chat, while the card inside re-enables them. Anchored to the bottom so it
// grows upward as the widget gets taller.
const WidgetOverlay = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  max-height: 70%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 0 ${({ theme }) => theme.space.xl};
  pointer-events: none;
`;

const ScrollToBottomButton = styled.button`
  position: absolute;
  z-index: 3;
  bottom: ${({ theme }) => theme.space.md};
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);

  &:hover {
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

// Welcome-screen block — sits above the centered composer when the chat is
// empty. Only rendered in the empty state, so no need to collapse it.
const Hero = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.xl} ${theme.space.lg}`};
  text-align: center;
  flex: 0 0 auto;
`;

const HeroLogoWrap = styled.div`
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const HeroTitle = styled.div`
  font-size: 28px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.25;
`;

const HeroSubtitle = styled.div`
  font-size: 15px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

const OlderLoader = styled.div`
  text-align: center;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  padding: ${({ theme }) => theme.space.sm} 0;
`;

const Bubble = styled.div<{ $role: "user" | "assistant" }>`
  align-self: ${({ $role }) => ($role === "user" ? "flex-end" : "flex-start")};
  max-width: 720px;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  background: ${({ $role, theme }) =>
    $role === "user" ? theme.colors.bgHover : theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  word-wrap: break-word;
  font-size: 14px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.text};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const BubbleAttachments = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
`;

const BubbleAttachment = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
`;

const UserText = styled.div`
  white-space: pre-wrap;
`;

// Inline chip for a `<job-ref/>` token — clicking opens the job-detail view
// in the right panel without touching Hank's focus (per the focus-vs-view
// rule in docs/architecture.md). Label is captured at send time, so the
// chip stays readable after a rename or hard-delete; click no-ops on
// missing jobs via viewJob's 404 handling.
const JobRefChipButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.text};
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  cursor: pointer;
  vertical-align: baseline;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    border-color: ${({ theme }) => theme.colors.accent};
  }
`;

// Tight inside-bubble markdown spacing: paragraphs collapse the bubble's own
// vertical rhythm, code blocks stay inside the bubble, links use the accent.
const MarkdownText = styled.div`
  p {
    margin: 0;
  }
  p + p {
    margin-top: ${({ theme }) => theme.space.sm};
  }
  ul,
  ol {
    margin: ${({ theme }) => theme.space.xs} 0;
    padding-left: ${({ theme }) => theme.space.xl};
  }
  li + li {
    margin-top: 2px;
  }
  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin: ${({ theme }) => theme.space.md} 0 ${({ theme }) => theme.space.xs};
    font-weight: 600;
    line-height: 1.3;
  }
  h1 {
    font-size: 17px;
  }
  h2 {
    font-size: 16px;
  }
  h3 {
    font-size: 15px;
  }
  h4,
  h5,
  h6 {
    font-size: 14px;
  }
  a {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
  code {
    font-family: ${({ theme }) => theme.font.mono};
    background: ${({ theme }) => theme.colors.bgMuted};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    padding: 0 4px;
    font-size: 12px;
  }
  pre {
    background: ${({ theme }) => theme.colors.bgMuted};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    padding: ${({ theme }) => theme.space.sm};
    overflow-x: auto;
    margin: ${({ theme }) => theme.space.sm} 0;
  }
  pre code {
    background: transparent;
    border: none;
    padding: 0;
  }
  blockquote {
    margin: ${({ theme }) => theme.space.sm} 0;
    padding-left: ${({ theme }) => theme.space.md};
    border-left: 3px solid ${({ theme }) => theme.colors.border};
    color: ${({ theme }) => theme.colors.textMuted};
  }
  table {
    border-collapse: collapse;
    margin: ${({ theme }) => theme.space.sm} 0;
  }
  th,
  td {
    border: 1px solid ${({ theme }) => theme.colors.border};
    padding: 4px 8px;
    text-align: left;
  }
`;

type ToolStatus = ToolSegment["status"];

const ToolBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const ToolChip = styled.span<{ $status: ToolStatus }>`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status }) =>
    $status === "error"
      ? theme.colors.danger
      : $status === "done"
        ? theme.colors.success
        : theme.colors.textMuted};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};

  &::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${({ theme, $status }) =>
      $status === "error"
        ? theme.colors.danger
        : $status === "done"
          ? theme.colors.success
          : theme.colors.textSubtle};
  }
`;

// Header chip for a failed run. Danger-toned sibling of ToolChip — same pill
// geometry so the two expandable rows line up, with a warning glyph instead of
// the status dot.
const ErrorChip = styled.span`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 2px 10px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.danger};
  color: ${({ theme }) => theme.colors.danger};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  text-align: left;

  &::before {
    content: "⚠";
    font-size: 10px;
  }
`;

const ToolProgress = styled.span`
  align-self: flex-start;
  padding-left: 22px;
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// Click-anywhere header for an expandable tool chip. Wraps a ToolChip (or the
// shortlist-widget compact chip) plus a rotating caret, all inside a button
// for keyboard accessibility. Caret rotation mirrors the BucketCaret pattern
// from DashboardView.
const ToolHeaderButton = styled.button`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
`;

const ToolCaret = styled.span<{ $open: boolean }>`
  font-size: 9px;
  color: ${({ theme }) => theme.colors.textSubtle};
  display: inline-block;
  width: 8px;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s ease;
`;

// Indented panel under the header showing input, result, and recursive
// children. Border-left stripe so the visual hierarchy of nested chips reads
// as a tree.
const ToolExpanded = styled.div`
  margin: ${({ theme }) => `${theme.space.xs} 0 ${theme.space.sm} 6px`};
  padding-left: ${({ theme }) => theme.space.md};
  border-left: 2px solid ${({ theme }) => theme.colors.border};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
`;

const ToolFieldLabel = styled.div`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

// Monospace pre with wrap + scroll cap. Long tool inputs / results stay
// readable without expanding the chat bubble horizontally past the viewport.
const ToolPre = styled.pre`
  margin: 0;
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
`;

const ToolChildren = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

// `$centered` drops the docked-mode chrome (border-top divider, full-bleed
// panel bg) so the welcome-screen composer reads as a free-floating input
// rather than a docked bar. The width clamp + auto margins keep it readable on
// wide panels while still going edge-to-edge on narrow ones.
const Composer = styled.div<{ $centered: boolean }>`
  /* Opaque + above the messages so the chat scroll never bleeds under the
     input. The widget card no longer tucks behind it — it overlays the chat
     area above the composer (see WidgetOverlay). */
  position: relative;
  z-index: 1;
  border-top: ${({ theme, $centered }) =>
    $centered ? "none" : `1px solid ${theme.colors.border}`};
  background: ${({ theme, $centered }) =>
    $centered ? "transparent" : theme.colors.bgPanel};
  ${({ $centered }) =>
    $centered
      ? `
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  `
      : ""}
`;

// What the chip calls the surface its changes are on. The user is looking at
// one of three screens and needs to know which batch the × would throw away.
const PANEL_NOUN: Record<NegotiationPanel, string> = {
  "shortlist-board": "shortlist",
  discovery: "company",
  application: "application",
};

function panelEditLabel(panel: NegotiationPanel, count: number): string {
  const noun =
    panel === "discovery" ? "company mark" : `${PANEL_NOUN[panel]} change`;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const AttachmentRow = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg} 0`};
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
`;

const PendingChip = styled.div<{ $status: "uploading" | "uploaded" | "error" }>`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.md}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid
    ${({ theme, $status }) =>
      $status === "error" ? theme.colors.danger : theme.colors.border};
  border-radius: 999px;
  font-size: 12px;
  color: ${({ theme, $status }) =>
    $status === "error" ? theme.colors.danger : theme.colors.text};
  max-width: 360px;
`;

const PendingName = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const PendingStatus = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const ChipClose = styled.button`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
  line-height: 1;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

// The second half of the dismiss: × arms it, this confirms. Destructive enough
// to earn the danger colour and a deliberate second click — the marks it throws
// away can't be recovered from the UI.
const ChipConfirm = styled.button`
  color: ${({ theme }) => theme.colors.danger};
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  &:hover {
    text-decoration: underline;
  }
`;

// Outer row — just provides breathing room around the pod. The pod itself
// owns the visual chrome (bg, border, radius, focus ring).
const InputBar = styled.div`
  display: flex;
  align-items: center;
  padding: ${({ theme }) => theme.space.lg};
`;

// The single rounded "pod" that holds attach + textarea + send/stop. One
// shared bg + border + focus-within glow makes the whole input feel like one
// elegant control rather than three loose circles on a flat strip. The
// `$thinking` shimmer rides on the pod (was on the textarea before, where it
// only covered the middle slot) so the working-cue sweep covers the whole
// rounded surface.
const InputPod = styled.div<{ $thinking: boolean }>`
  flex: 1;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 24px;
  padding: ${({ theme }) => theme.space.xs};
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:focus-within {
    border-color: ${({ theme }) => theme.colors.accent};
    box-shadow:
      0 0 0 3px ${({ theme }) => `${theme.colors.accent}22`},
      0 1px 2px rgba(0, 0, 0, 0.04);
  }

  ${({ $thinking, theme }) =>
    $thinking
      ? `
    background: linear-gradient(
      90deg,
      ${theme.colors.bgMuted} 0%,
      ${theme.colors.bgHover} 50%,
      ${theme.colors.bgMuted} 100%
    );
    background-size: 200% 100%;
    animation: thinkingPodShimmer 1.8s ease-in-out infinite;
    @keyframes thinkingPodShimmer {
      0%   { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
  `
      : ""}
`;

// Flat icon button (attach) inside the pod — no border or solid bg of its
// own; the pod already supplies that. Hover gives just a soft hint.
const IconButton = styled.button<{ $disabled?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colors.textSubtle : theme.colors.textMuted};
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: ${({ $disabled }) => ($disabled ? "not-allowed" : "pointer")};
  font-size: 16px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    color: ${({ theme, $disabled }) =>
      $disabled ? theme.colors.textSubtle : theme.colors.text};
    background: ${({ theme, $disabled }) =>
      $disabled ? "transparent" : theme.colors.bgHover};
  }
`;

// Wraps the textarea + the absolutely-positioned hopping HankLogo overlay that
// appears while the agent is streaming. The wrap takes the flex slot so the
// textarea can stay 100%-width inside it without fighting the icon for space.
const InputWrap = styled.div`
  position: relative;
  flex: 1;
  display: flex;
`;

// Dance card — five distinctive keyframe loops that the HopHank picks from
// randomly. `iteration-count: 1` so each move plays once and fires
// `animationend`, where the component picks a *different* move (never the
// same back-to-back) and a `repeat${n}` key forces a fresh animation cycle
// even if the random landed on the same name two picks apart.
const HOP_HANK_ANIMATIONS = [
  "hop",
  "spin",
  "wiggle",
  "squish",
  "moonwalk",
  "backflip",
  "pogo",
  "cartwheel",
  "shimmy",
  "tada",
] as const;
type HopHankAnim = (typeof HOP_HANK_ANIMATIONS)[number];

const HopHank = styled.div<{ $anim: HopHankAnim }>`
  position: absolute;
  left: 14px;
  top: 50%;
  pointer-events: none;
  transform-origin: 50% 100%;
  animation-name: ${({ $anim }) => `hank_${$anim}`};
  animation-duration: 1.1s;
  animation-timing-function: cubic-bezier(0.5, 0, 0.5, 1);
  animation-iteration-count: 1;
  animation-fill-mode: both;

  @keyframes hank_hop {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    25% {
      transform: translateY(calc(-50% - 10px)) rotate(-14deg);
    }
    50% {
      transform: translateY(-50%) rotate(0deg);
    }
    65% {
      transform: translateY(-46%) scaleY(0.85) scaleX(1.12);
    }
    80% {
      transform: translateY(calc(-50% - 6px)) rotate(12deg);
    }
    100% {
      transform: translateY(-50%) rotate(0deg);
    }
  }
  /* Anticipation crouch → big jump with two full spins mid-air → squash landing. */
  @keyframes hank_spin {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    15% {
      transform: translateY(-44%) scale(1.12, 0.82) rotate(0deg);
    }
    30% {
      transform: translateY(calc(-50% - 14px)) rotate(180deg);
    }
    50% {
      transform: translateY(calc(-50% - 20px)) rotate(360deg);
    }
    70% {
      transform: translateY(calc(-50% - 14px)) rotate(540deg);
    }
    85% {
      transform: translateY(-44%) scale(1.12, 0.82) rotate(720deg);
    }
    100% {
      transform: translateY(-50%) rotate(720deg);
    }
  }
  @keyframes hank_wiggle {
    0%,
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    15% {
      transform: translateY(-50%) translateX(-5px) rotate(-12deg);
    }
    35% {
      transform: translateY(-50%) translateX(5px) rotate(12deg);
    }
    55% {
      transform: translateY(-50%) translateX(-4px) rotate(-10deg);
    }
    75% {
      transform: translateY(-50%) translateX(4px) rotate(10deg);
    }
  }
  @keyframes hank_squish {
    0%,
    100% {
      transform: translateY(-50%) scale(1, 1);
    }
    20% {
      transform: translateY(-44%) scale(1.25, 0.7);
    }
    45% {
      transform: translateY(calc(-50% - 8px)) scale(0.9, 1.18);
    }
    70% {
      transform: translateY(-44%) scale(1.2, 0.8);
    }
  }
  @keyframes hank_moonwalk {
    0% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    30% {
      transform: translateY(-50%) translateX(-9px) rotate(-6deg);
    }
    50% {
      transform: translateY(calc(-50% - 4px)) translateX(-4px) rotate(0deg);
    }
    70% {
      transform: translateY(-50%) translateX(7px) rotate(6deg);
    }
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
  }
  /* Backward somersault — leans back into the jump, full negative rotation. */
  @keyframes hank_backflip {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    15% {
      transform: translateY(-44%) scale(1.1, 0.85) rotate(0deg);
    }
    35% {
      transform: translateY(calc(-50% - 16px)) rotate(-120deg);
    }
    55% {
      transform: translateY(calc(-50% - 22px)) rotate(-240deg);
    }
    80% {
      transform: translateY(-44%) scale(1.1, 0.85) rotate(-360deg);
    }
    100% {
      transform: translateY(-50%) rotate(-360deg);
    }
  }
  /* Rapid double-bounce — playground pogo stick. */
  @keyframes hank_pogo {
    0%,
    100% {
      transform: translateY(-50%) scale(1);
    }
    10% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    22% {
      transform: translateY(calc(-50% - 10px)) scale(0.92, 1.1);
    }
    36% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    48% {
      transform: translateY(calc(-50% - 16px)) scale(0.9, 1.15);
    }
    62% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    74% {
      transform: translateY(calc(-50% - 8px)) scale(0.95, 1.08);
    }
    88% {
      transform: translateY(-44%) scale(1.1, 0.85);
    }
  }
  /* Side-to-side wheel motion — arcs over the top going one way, back the other. */
  @keyframes hank_cartwheel {
    0% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    25% {
      transform: translateY(calc(-50% - 14px)) translateX(-12px) rotate(-180deg);
    }
    50% {
      transform: translateY(-50%) translateX(0) rotate(-360deg);
    }
    75% {
      transform: translateY(calc(-50% - 14px)) translateX(12px) rotate(-540deg);
    }
    100% {
      transform: translateY(-50%) translateX(0) rotate(-720deg);
    }
  }
  /* High-frequency micro-shake. Fast and jittery, no big displacement. */
  @keyframes hank_shimmy {
    0%,
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    8% {
      transform: translateY(-50%) translateX(-3px) rotate(-5deg);
    }
    16% {
      transform: translateY(-50%) translateX(3px) rotate(5deg);
    }
    24% {
      transform: translateY(-50%) translateX(-3px) rotate(-5deg);
    }
    32% {
      transform: translateY(-50%) translateX(3px) rotate(5deg);
    }
    44% {
      transform: translateY(-48%) translateX(-2px) scale(1.06) rotate(0deg);
    }
    56% {
      transform: translateY(-50%) translateX(3px) rotate(-5deg);
    }
    64% {
      transform: translateY(-50%) translateX(-3px) rotate(5deg);
    }
    72% {
      transform: translateY(-50%) translateX(3px) rotate(-5deg);
    }
    84% {
      transform: translateY(-50%) translateX(-3px) rotate(5deg);
    }
    92% {
      transform: translateY(-50%) translateX(2px) rotate(-3deg);
    }
  }
  /* Anticipation lean, then a huge tilted pop with a full rotation. */
  @keyframes hank_tada {
    0% {
      transform: translateY(-50%) scale(1) rotate(0deg);
    }
    12% {
      transform: translateY(-42%) scale(1.2, 0.7) rotate(-10deg);
    }
    28% {
      transform: translateY(-42%) scale(1.2, 0.7) rotate(-14deg);
    }
    44% {
      transform: translateY(calc(-50% - 24px)) scale(1.18) rotate(220deg);
    }
    62% {
      transform: translateY(calc(-50% - 14px)) scale(1.08) rotate(360deg);
    }
    82% {
      transform: translateY(-44%) scale(1.06, 0.92) rotate(360deg);
    }
    100% {
      transform: translateY(-50%) scale(1) rotate(360deg);
    }
  }
`;

// Lives inside InputPod, so it has no chrome of its own (no bg, no border, no
// radius). Padding controls the click-target height instead of the visual
// bounds. `$thinking` shimmer now rides on the pod via a CSS variable so the
// effect covers the whole rounded surface rather than just the textarea slot.
const Input = styled.textarea<{ $thinking: boolean }>`
  flex: 1;
  background: transparent;
  border: none;
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.5;
  overflow-y: auto;

  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }

  ${({ $thinking }) =>
    $thinking
      ? `
    &::placeholder {
      animation: thinkingPlaceholder 1.8s ease-in-out infinite;
    }
    @keyframes thinkingPlaceholder {
      0%, 100% { opacity: 0.55; }
      50%      { opacity: 1; }
    }
  `
      : ""}
`;

const Send = styled.button<{ $disabled: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: ${({ theme, $disabled }) =>
    $disabled ? "transparent" : theme.colors.accent};
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colors.textSubtle : theme.colors.onAccent};
  border: none;
  border-radius: 50%;
  cursor: ${({ $disabled }) => ($disabled ? "not-allowed" : "pointer")};
  transition:
    background-color 0.15s ease,
    transform 0.1s ease;

  &:hover {
    background: ${({ theme, $disabled }) =>
      $disabled ? "transparent" : theme.colors.accentHover};
  }
  &:active:not(:disabled) {
    transform: scale(0.95);
  }
`;

const SendIcon = styled.svg`
  width: 16px;
  height: 16px;
  display: block;
`;

// Round button that replaces Send while the agent is streaming. Filled accent
// square icon — "Stop". Clicking it routes through chatStore.stop(), a single
// press that stops the whole run and keeps whatever streamed.
const StopButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: ${({ theme }) => theme.colors.bgHover};
  color: ${({ theme }) => theme.colors.text};
  border: none;
  border-radius: 50%;
  cursor: pointer;
  position: relative;

  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
`;

const StopIcon = styled.svg`
  width: 14px;
  height: 14px;
  display: block;
`;

// Small inline pill rendered under a cut-off assistant message (Stop press,
// dropped connection, or mid-stream error — the stoppedByUser flag covers all
// three). Neutral/muted tone — the partial is saved and Hank can continue.
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

// Soft notice shown above the composer when a turn's stream dropped (tab
// backgrounded / PWA suspended / connection lost) and we're pulling the real
// state from the server. Deliberately low-key — not an error — because the
// turn's progress is safe in the DB and the reconcile repairs the view in a
// beat. Cleared by the store the moment the reconcile lands.
const ReconnectNotice = styled.div`
  align-self: center;
  margin: ${({ theme }) => theme.space.xs} auto;
  padding: 4px 12px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
`;

const StoppedPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: ${({ theme }) => theme.space.xs};
  padding: 2px 8px;
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 999px;
  width: fit-content;
`;

// Input grows from 1 line up to MAX_LINES; beyond that it scrolls internally.
// Inside the InputPod the textarea has no border (the pod owns the chrome)
// and tighter vertical padding so it sits comfortably alongside the 32px
// icon buttons.
// Breathing room between the last message and the top of the sticky widget
// card when the scroll region reserves space for the overlay.
const WIDGET_CLEARANCE = 16;

const MAX_INPUT_LINES = 5;
const INPUT_LINE_HEIGHT = 21; // 14px * 1.5
const INPUT_VPAD = 8; // 2 * theme.space.xs (4px each)
const INPUT_MIN_HEIGHT = INPUT_LINE_HEIGHT + INPUT_VPAD;
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * MAX_INPUT_LINES + INPUT_VPAD;

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const streaming = useChatStore((s) => s.streaming);
  const streamInterrupted = useChatStore((s) => s.streamInterrupted);
  const serverRunActive = useChatStore((s) => s.serverRunActive);
  const stop = useChatStore((s) => s.stop);
  const send = useChatStore((s) => s.send);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const pendingPanelEdits = useChatStore((s) => s.pendingPanelEdits);
  const discardPanelEdits = useChatStore((s) => s.discardPanelEdits);
  // Which chip has its × armed. One at a time is enough — arming is a transient
  // gesture aimed at a specific chip — and it resets on its own when that
  // surface's count reaches zero.
  const [discarding, setDiscarding] = useState<NegotiationPanel | null>(null);
  const pendingPanelTotal = NEGOTIATION_PANELS.reduce(
    (n, panel) => n + pendingPanelEdits[panel],
    0,
  );
  const stageFiles = useChatStore((s) => s.stageFiles);
  const removePending = useChatStore((s) => s.removePending);
  const activePanel = useChatStore((s) => s.activePanel);
  // The blocking modal is the canonical "can the user chat?" signal — when
  // it's up the composer disables (defense in depth — the backdrop already
  // intercepts clicks). Reading from store rather than a server-rendered
  // prop means dismissing the modal after a successful key save unblocks
  // the composer on the same tick, no page refresh required.
  const apiKeyBlocker = useChatStore((s) => s.apiKeyBlocker);
  // Admin view-session mode is read-only — composer disabled, no Send / Stop /
  // upload paths. Same gate covers the chip widget below.
  const readOnly = useChatStore((s) => s.impersonateSessionId !== null);
  const canChat = apiKeyBlocker === null && !readOnly;

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
  const [dragDepth, setDragDepth] = useState(0);
  // Random dance-move state for the hopping HankLogo overlay. `animTick` is
  // bumped on each animationend to force a fresh DOM element (via React key)
  // so the next animation restarts cleanly even if Math.random picked the
  // same move two cycles apart. `animIndex` is the move itself, never equal
  // to the previous pick (see pickNextAnim).
  const [animIndex, setAnimIndex] = useState(0);
  const [animTick, setAnimTick] = useState(0);

  function pickNextAnim() {
    setAnimIndex((prev) => {
      let next = Math.floor(Math.random() * (HOP_HANK_ANIMATIONS.length - 1));
      if (next >= prev) next += 1;
      return next;
    });
    setAnimTick((t) => t + 1);
  }
  // Mirrors !pinnedToBottomRef.current as state so the jump-to-bottom button
  // can render. Kept separate from the ref so the auto-scroll effect and
  // onScroll handler can act on pin status synchronously without waiting for
  // a re-render.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Live height of the sticky widget overlay, fed into MessagesScroll's bottom
  // padding (so the latest message clears the card) and the jump-to-bottom
  // button's offset. 0 when no widget is mounted (overlay shrinks to nothing).
  const [widgetHeight, setWidgetHeight] = useState(0);
  const widgetSlotRef = useRef<HTMLDivElement>(null);
  // True when the user is at (or very near) the bottom — that's when we want
  // streaming deltas to keep the view pinned. Flips to false the moment they
  // scroll up to read history, so we don't yank them back mid-read.
  const pinnedToBottomRef = useRef(true);
  const preserveScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages]);

  // On narrow viewports the chat pane mounts inside a `display: none` Pane
  // when the session loads with a focused entity (activePanel starts "right").
  // scrollHeight reads 0 there, so the [messages] effect above scrolls to a
  // no-op. When the user flips to the Chat tab, re-pin to the bottom.
  useEffect(() => {
    if (activePanel !== "chat") return;
    const el = scrollRef.current;
    if (!el || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }, [activePanel]);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollToBottom(false);
  }

  useEffect(() => {
    const el = scrollRef.current;
    const saved = preserveScrollRef.current;
    if (!el || !saved) return;
    preserveScrollRef.current = null;
    const newScrollTop = el.scrollHeight - saved.scrollHeight + saved.scrollTop;
    el.scrollTop = newScrollTop;
  }, [messages]);

  function autosize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(
      INPUT_MAX_HEIGHT,
      Math.max(INPUT_MIN_HEIGHT, el.scrollHeight),
    );
    el.style.height = `${next}px`;
  }

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

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Re-evaluate pinned state on every user scroll. The threshold tolerates
    // sub-pixel rounding and the gap that opens up between a streaming delta
    // landing and our effect re-pinning.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distFromBottom < 40;
    pinnedToBottomRef.current = pinned;
    setShowScrollToBottom(!pinned);

    if (el.scrollTop > 80) return;
    if (!hasMoreMessages || loadingOlder) return;
    preserveScrollRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    void loadOlderMessages();
  }

  const anyUploading = pendingAttachments.some((p) => p.status === "uploading");
  const anyUploaded = pendingAttachments.some((p) => p.status === "uploaded");
  const busy = streaming || anyUploading;
  // Panel changes are sendable on their own — that's how the user hands a batch
  // of them to Hank without typing anything, on any of the three surfaces.
  const canSend =
    canChat &&
    !busy &&
    (Boolean(text.trim()) || anyUploaded || pendingPanelTotal > 0);

  function submit() {
    if (!canSend) return;
    const t = text.trim();
    setText("");
    // Sending implies "I want to see the response" — snap back even if the
    // user had scrolled up while composing.
    pinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    void send(t);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    stageFiles(Array.from(files));
    e.target.value = "";
  }

  function isFileDrag(e: DragEvent<HTMLDivElement>): boolean {
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    setDragDepth((d) => Math.max(0, d - 1));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) stageFiles(files);
  }

  const isEmpty = messages.length === 0;

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

  return (
    <Root
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isEmpty && <Spacer key="spacer-top" />}
      {isEmpty && (
        <Hero key="hero">
          <HeroLogoWrap>
            <HankLogo size={64} />
          </HeroLogoWrap>
          <HeroTitle>Hi, I&apos;m Hank!</HeroTitle>
          <HeroSubtitle>Drop in your resume to get started</HeroSubtitle>
        </Hero>
      )}
      {!isEmpty && (
        <MessagesArea key="messages">
          <MessagesScroll
            ref={scrollRef}
            onScroll={onScroll}
            style={
              widgetHeight
                ? { paddingBottom: widgetHeight + WIDGET_CLEARANCE }
                : undefined
            }
          >
            {loadingOlder && <OlderLoader>Loading older messages…</OlderLoader>}
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                streamingPlaceholder={streaming && i === messages.length - 1}
              />
            ))}
          </MessagesScroll>
          {showScrollToBottom && (
            <ScrollToBottomButton
              onClick={scrollToBottom}
              aria-label="Scroll to latest"
              title="Scroll to latest"
              style={widgetHeight ? { bottom: widgetHeight + 12 } : undefined}
            >
              ↓
            </ScrollToBottomButton>
          )}
          <WidgetOverlay ref={widgetSlotRef}>
            <ClientErrorBoundary component="ChatWidget">
              <PipelineWidgetSlot />
            </ClientErrorBoundary>
          </WidgetOverlay>
        </MessagesArea>
      )}
      {serverRunActive && !streaming ? (
        // The server is still finishing this session's run without a live
        // stream attached (dropped connection / refresh / busy-session
        // bounce). The store polls and repaints progress as it persists —
        // say so instead of showing a dead chat that looks like Hank bailed.
        <ReconnectNotice role="status">
          Hank is still working — updates will appear as they finish…
        </ReconnectNotice>
      ) : (
        streamInterrupted &&
        !streaming && (
          <ReconnectNotice role="status">
            Connection dropped — catching up…
          </ReconnectNotice>
        )
      )}
      <Composer key="composer" $centered={isEmpty}>
        {NEGOTIATION_PANELS.filter((p) => pendingPanelEdits[p] > 0).map(
          (panel) => (
            <AttachmentRow key={panel}>
              {/* The changes are already saved on the panel; the server attaches
                  them to whatever the user sends next. Dismissing UNDOES them —
                  see discardPanelEdits. */}
              <PendingChip $status="uploaded">
                ☰{" "}
                <PendingName>
                  {discarding === panel
                    ? `Discard ${panelEditLabel(panel, pendingPanelEdits[panel])}?`
                    : `${panelEditLabel(panel, pendingPanelEdits[panel])} — send to hand ${
                        pendingPanelEdits[panel] === 1 ? "it" : "them"
                      } over`}
                </PendingName>
                {discarding === panel ? (
                  <>
                    <ChipConfirm
                      onClick={() => {
                        setDiscarding(null);
                        void discardPanelEdits(panel);
                      }}
                    >
                      Discard
                    </ChipConfirm>
                    <ChipClose
                      onClick={() => setDiscarding(null)}
                      aria-label={`keep my ${PANEL_NOUN[panel]} changes`}
                    >
                      ×
                    </ChipClose>
                  </>
                ) : (
                  <ChipClose
                    onClick={() => setDiscarding(panel)}
                    aria-label={`discard my ${PANEL_NOUN[panel]} changes`}
                    title="Discard these changes — this panel goes back to what Hank last saw"
                  >
                    ×
                  </ChipClose>
                )}
              </PendingChip>
            </AttachmentRow>
          ),
        )}
        {pendingAttachments.length > 0 && (
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
        )}
        <InputBar>
          <input
            ref={fileRef}
            type="file"
            multiple
            onChange={onFile}
            style={{ display: "none" }}
          />
          <InputPod $thinking={streaming}>
            <IconButton
              onClick={() => fileRef.current?.click()}
              $disabled={streaming || !canChat}
              title={
                readOnly
                  ? "Read-only — attachments disabled"
                  : "Attach files (PDF, Word .docx, image, or text) — sent when you hit Send"
              }
            >
              📎
            </IconButton>
            <InputWrap>
              <Input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={
                  readOnly
                    ? "Read-only — viewing another user's session"
                    : streaming
                      ? "Hank is thinking…"
                      : anyUploading
                        ? "Uploading…"
                        : pendingAttachments.length > 0
                          ? "Optionally add a message, then Send…"
                          : "Message Hank…"
                }
                disabled={streaming || !canChat}
                $thinking={streaming}
                rows={1}
                style={{
                  minHeight: INPUT_MIN_HEIGHT,
                  maxHeight: INPUT_MAX_HEIGHT,
                  paddingLeft: streaming ? 38 : undefined,
                }}
              />
              {streaming && (
                <HopHank
                  key={animTick}
                  aria-hidden
                  $anim={HOP_HANK_ANIMATIONS[animIndex]}
                  onAnimationEnd={pickNextAnim}
                >
                  <HankLogo size={20} />
                </HopHank>
              )}
            </InputWrap>
            {streaming ? (
              <StopButton
                onClick={() => void stop()}
                aria-label="Stop"
                title="Stop Hank"
              >
                <StopIcon viewBox="0 0 14 14" aria-hidden>
                  <rect
                    x="3"
                    y="3"
                    width="8"
                    height="8"
                    rx="1"
                    fill="currentColor"
                  />
                </StopIcon>
              </StopButton>
            ) : (
              <Send
                onClick={submit}
                $disabled={!canSend}
                aria-label="Send"
                title="Send"
              >
                <SendIcon viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M8 13 V3 M3.5 7.5 L8 3 L12.5 7.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </SendIcon>
              </Send>
            )}
          </InputPod>
        </InputBar>
      </Composer>
      {isEmpty && <Spacer key="spacer-bottom" />}
      {dragDepth > 0 && <DropOverlay />}
    </Root>
  );
}

// Memoized so that re-renders of ChatPanel triggered by typing in the
// composer, or by the scroll-button visibility toggle, don't re-render every
// bubble in the list (which would re-parse every assistant ReactMarkdown
// block). The `message` prop is referentially stable from zustand, so the
// shallow compare is a no-op except for the actually-changed bubble during
// streaming. `streamingPlaceholder` is false for all but the last bubble, so
// streaming flips don't ripple through earlier messages either.
const MessageBubble = memo(function MessageBubble({
  message,
  streamingPlaceholder,
}: {
  message: MessageView;
  streamingPlaceholder: boolean;
}) {
  // Single-text-segment user messages may be a widget submission (the
  // <!--widget-response:…--> marker) or the legacy <!--shortlist-commit:…-->
  // recap. Both render as a standalone card replacing the bubble, so the raw
  // marker never paints. widget-response is the live path; shortlist-commit is
  // replay-only for pre-2026-06-12 history.
  const singleUserText = useMemo(
    () =>
      message.role === "user" &&
      message.segments.length === 1 &&
      message.segments[0].kind === "text"
        ? message.segments[0].text
        : null,
    [message.role, message.segments],
  );
  const widgetResponseParsed = useMemo(
    () => (singleUserText ? tryParseWidgetResponse(singleUserText) : null),
    [singleUserText],
  );
  const commitParsed = useMemo(
    () => (singleUserText ? tryParseShortlistCommit(singleUserText) : null),
    [singleUserText],
  );

  // Skip rendering bubbles whose only content is widget segments — widgets
  // render via PipelineWidgetSlot / ShortlistProposalWidget above the
  // composer, not inline. Without this, the bubble shows up as an empty
  // box on refresh. The segment is still in `message.segments` (so
  // PipelineWidgetSlot can find it); we just don't paint the chat row.
  const isWidgetOnly =
    message.role === "assistant" &&
    message.segments.length > 0 &&
    message.segments.every((s) => s.kind === "widget");
  if (isWidgetOnly) {
    return null;
  }

  // Skip a finished assistant turn with nothing renderable — no segments, or only
  // empty/whitespace text — which would otherwise paint a blank bubble that
  // survives a refresh (the Snowflake report). Guarded so a still-streaming turn
  // (shows "…") and a stopped-by-user turn (shows the pill) still render.
  const isEmptyAssistant =
    message.role === "assistant" &&
    !streamingPlaceholder &&
    !message.stoppedByUser &&
    (!message.attachments || message.attachments.length === 0) &&
    message.segments.every(
      (s) => s.kind === "text" && s.text.trim().length === 0,
    );
  if (isEmptyAssistant) {
    return null;
  }

  if (widgetResponseParsed) {
    return <WidgetResponseCard parsed={widgetResponseParsed} />;
  }

  if (commitParsed) {
    return (
      <>
        <ShortlistCommitCard payload={commitParsed} />
        {commitParsed.reason && (
          <Bubble $role="user">
            <UserText>Reason: {commitParsed.reason}</UserText>
          </Bubble>
        )}
      </>
    );
  }

  return (
    <Bubble $role={message.role}>
      {message.attachments && message.attachments.length > 0 && (
        <BubbleAttachments>
          {message.attachments.map((a) => (
            <BubbleAttachment key={a.attachmentId}>
              📎 {a.fileName}
            </BubbleAttachment>
          ))}
        </BubbleAttachments>
      )}
      {message.panelEdits && message.panelEdits.length > 0 && (
        <BubbleAttachments>
          {message.panelEdits.map((e, i) => (
            <BubbleAttachment key={i}>
              ☰ {e.title}
              {e.verdict ? ` → ${e.verdict.toLowerCase()}` : ""}
            </BubbleAttachment>
          ))}
        </BubbleAttachments>
      )}
      {message.segments.length === 0 &&
        message.role === "assistant" &&
        streamingPlaceholder && <UserText>…</UserText>}
      {message.segments.map((seg, i) => (
        <SegmentView key={i} segment={seg} role={message.role} />
      ))}
      {message.role === "assistant" && message.stoppedByUser && (
        // Cause-neutral: the stoppedByUser flag is set for a Stop press, a
        // dropped connection, and a genuine mid-stream error alike — all cut the
        // reply off and save the partial. "Interrupted" reads true for all three.
        <StoppedPill>Response interrupted</StoppedPill>
      )}
    </Bubble>
  );
});

function SegmentView({
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

// One thing the user needs to know, and everything else folded away. A failed
// run's detail is operator text — a Prisma code, an HTTP status, a stack — so
// the collapsed row says only that this stopped short, and the caret opens the
// raw message for when the maintainer (or a bug report) wants it. Same chrome as the tool
// chip on purpose: expandable-thing-in-a-bubble already reads as one pattern.
const ERROR_CHIP_LABEL = "Something went wrong — this step didn't finish";

function ExpandableError({ segment }: { segment: ErrorSegment }) {
  const [open, setOpen] = useState(false);
  return (
    <ToolBlock>
      <ToolHeaderButton
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ToolCaret $open={open} aria-hidden>
          ▶
        </ToolCaret>
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

function JobRefChip({ jobId, label }: { jobId: string; label: string }) {
  const viewJob = useChatStore((s) => s.viewJob);
  return (
    <JobRefChipButton
      type="button"
      onClick={() => void viewJob(jobId)}
      title={label}
    >
      {label}
    </JobRefChipButton>
  );
}

// Inline chip for a `<focus-ref/>` token — clicking opens that destination in
// the right panel (view-only, like JobRefChip; never touches focus). Label is
// captured at emit time so it survives a rename / delete, and click no-ops on a
// missing entity via the view*() 404 handling.
//
// This is the doorway BACK to a surface the user has navigated away from, which
// is why the discovery list — reachable no other way, since it hangs off no
// entity and lives in no menu — announces itself with one.
type FocusRefChipProps = { label: string } & (
  | { refKind: "company" | "job" | "opportunity"; id: string }
  | { refKind: "discovery" }
);

function FocusRefChip(props: FocusRefChipProps) {
  const { label } = props;
  const viewCompany = useChatStore((s) => s.viewCompany);
  const viewJob = useChatStore((s) => s.viewJob);
  const viewOpportunity = useChatStore((s) => s.viewOpportunity);
  const viewDiscovery = useChatStore((s) => s.viewDiscovery);
  const onClick = () => {
    if (props.refKind === "discovery") void viewDiscovery();
    else if (props.refKind === "company") void viewCompany(props.id);
    else if (props.refKind === "job") void viewJob(props.id);
    else void viewOpportunity(props.id);
  };
  return (
    <JobRefChipButton type="button" onClick={onClick} title={label}>
      {label}
    </JobRefChipButton>
  );
}

// Single tool chip. Header (chip + caret) toggles an expanded panel showing:
//   1. the input args this tool was called with,
//   2. the result string the tool returned (when available),
//   3. recursive children — sub-agent inner steps (text + nested tool chips
//      that are themselves expandable).
// For propose_shortlist / propose_shortlist_auto with a parsed payload, the
// header keeps its compact "name · company · count" caption so scrollback
// stays readable; the expand panel still works the same. Both tools are RETIRED
// — these names are matched only to replay sessions that predate their removal,
// so don't drop the branch as dead code.
function ExpandableToolChip({
  segment,
  role,
}: {
  segment: ToolSegment;
  role: "user" | "assistant";
}) {
  const [open, setOpen] = useState(false);

  const compactShortlist = useMemo(() => {
    if (
      (segment.name === "propose_shortlist" ||
        segment.name === "propose_shortlist_auto") &&
      segment.status === "done" &&
      segment.result
    ) {
      return tryParseShortlistProposal(segment.result);
    }
    return null;
  }, [segment.name, segment.status, segment.result]);

  const chipLabel = compactShortlist
    ? `${segment.name} · ${compactShortlist.companyName} · ${compactShortlist.viableJobs.length}`
    : segment.name;

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
        <ToolCaret $open={open} aria-hidden>
          ▶
        </ToolCaret>
        <ToolChip $status={segment.status}>{chipLabel}</ToolChip>
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

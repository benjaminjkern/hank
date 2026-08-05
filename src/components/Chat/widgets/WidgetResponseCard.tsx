"use client";

// Chat-side rendering for widget *responses* — the user messages produced
// when someone acts on a pipeline widget (skip yes/no, next-company pick,
// shortlist approve, …). Each submission is persisted as a chat message of
// the shape:
//
//   <!--widget-response:{kind, ...submission, _view?:{…}}-->\n[visible label]
//
// Without this component the raw marker renders verbatim in the bubble (the
// "html-comment-looking message" problem). `tryParseWidgetResponse` detects
// the marker and `WidgetResponseCard` dispatches on `kind` (+ `choice`) to a
// bespoke right-aligned card. Display data the submission doesn't already
// carry (company/job names, logos, the shortlist job list) rides in `_view`,
// embedded by buildWidgetSubmissionMessage so the card survives a reload.
//
// Wired in at MessageBubble level (like ShortlistCommitCard) because the card
// replaces the whole bubble. When `_view` is missing the dispatcher falls back
// to a clean label chip — the marker still never renders raw.

import { useState, type ReactNode } from "react";
import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";
import { asNonEmptyString, asStringArray, isRecord } from "@/utils/guards";
import { initial } from "@/utils/text";

const MARKER_RE = /^<!--widget-response:(\{[\s\S]*?\})-->/;

type ParsedWidgetResponse = {
  kind: string;
  obj: Record<string, unknown>;
  view: Record<string, unknown>;
  /** The visible label after the marker, brackets stripped. */
  label: string;
};

export function tryParseWidgetResponse(
  text: string,
): ParsedWidgetResponse | null {
  if (!text.startsWith("<!--widget-response:")) return null;
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!isRecord(obj) || typeof obj.kind !== "string") return null;
  const rawLabel = text.slice(m[0].length).replace(/^\n/, "").trim();
  const label = rawLabel.replace(/^\[/, "").replace(/\]$/, "");
  return {
    kind: obj.kind,
    obj,
    view: isRecord(obj._view) ? obj._view : {},
    label,
  };
}

export function WidgetResponseCard({
  parsed,
}: {
  parsed: ParsedWidgetResponse;
}) {
  const { kind, obj, view, label } = parsed;

  switch (kind) {
    case "company_checklist": {
      const picked = asStringArray(obj.picked);
      if (picked.length === 0) {
        return <Chip icon="⊘" tone="muted" title="Added none of these" />;
      }
      return (
        <Card>
          <Header>
            <Icon $tone="accent">+</Icon>
            <Title>
              Added {picked.length}{" "}
              {picked.length === 1 ? "company" : "companies"}
            </Title>
          </Header>
          <NameChips>
            {picked.map((n) => (
              <NameChip key={n}>{n}</NameChip>
            ))}
          </NameChips>
        </Card>
      );
    }

    case "confirm_application_submit": {
      const jobId = asNonEmptyString(obj.jobId);
      const jobTitle = asNonEmptyString(view.jobTitle);
      const companyName = asNonEmptyString(view.companyName);
      const subject = [jobTitle, companyName].filter(Boolean).join(" @ ");
      return (
        <Card>
          <Header>
            <Icon $tone="accent">✓</Icon>
            <Title>Submitted application</Title>
          </Header>
          {subject && (
            <Sub>
              {jobId ? <JobLink jobId={jobId} label={subject} /> : subject}
            </Sub>
          )}
        </Card>
      );
    }

    case "next_company_picker": {
      if (obj.choice === "company") {
        const companyId = asNonEmptyString(obj.companyId);
        const name =
          asNonEmptyString(view.name) ?? label.replace(/^Continue with /, "");
        const logoUrl = asNonEmptyString(view.logoUrl);
        return (
          <Chip
            icon={<CompanyLogo name={name} logoUrl={logoUrl} />}
            tone="accent"
            title={`Continuing with ${name}`}
            onClick={companyId ? () => void viewCompany(companyId) : undefined}
          />
        );
      }
      if (obj.choice === "opportunity") {
        const opportunityId = asNonEmptyString(obj.opportunityId);
        const lbl =
          asNonEmptyString(view.label) ?? label.replace(/^Continue with /, "");
        return (
          <Chip
            icon="→"
            tone="accent"
            title={`Continuing with ${lbl}`}
            onClick={
              opportunityId
                ? () => void viewOpportunity(opportunityId)
                : undefined
            }
          />
        );
      }
      if (obj.choice === "job") {
        const jobId = asNonEmptyString(obj.jobId);
        const title =
          asNonEmptyString(view.title) ?? label.replace(/^Continue with /, "");
        const companyName = asNonEmptyString(view.companyName);
        const logoUrl = asNonEmptyString(view.logoUrl);
        return (
          <Chip
            icon={<CompanyLogo name={companyName ?? title} logoUrl={logoUrl} />}
            tone="accent"
            title={`Continuing with ${title}`}
            onClick={jobId ? () => void viewJob(jobId) : undefined}
          />
        );
      }
      return (
        <Chip icon="+" tone="accent" title="Adding companies to watchlist" />
      );
    }

    case "shortlist_proposal":
      return <ShortlistResponseCard view={view} fallback={label} />;

    default:
      return <Chip title={label} />;
  }
}

// ---- shortlist (full expandable recap) --------------------------------

type ShortlistJob = {
  id: string;
  title: string;
  approved: boolean;
  recommended: boolean;
};

function shortlistTag(j: ShortlistJob): "pick" | "pass" | "override" {
  if (j.approved) return j.recommended ? "pick" : "override";
  return j.recommended ? "override" : "pass";
}

function ShortlistResponseCard({
  view,
  fallback,
}: {
  view: Record<string, unknown>;
  fallback: string;
}) {
  const [open, setOpen] = useState(false);

  const companyName = asNonEmptyString(view.companyName);
  const reason = asNonEmptyString(view.reason);
  const jobs = parseShortlistJobs(view.jobs);

  // History without _view (or a malformed payload) → clean label chip.
  if (!companyName || jobs.length === 0) {
    return <Chip icon="✓" tone="accent" title={fallback} />;
  }

  const approved = jobs.filter((j) => j.approved);
  const total = jobs.length;
  const headline =
    approved.length === 0
      ? `Picked none of the ${total} at ${companyName}`
      : approved.length === total
        ? `Shortlisted all ${total} at ${companyName}`
        : `Shortlisted ${approved.length} of ${total} at ${companyName}`;

  return (
    <Card>
      <Header
        as="button"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        $expandable
      >
        <Caret $open={open} aria-hidden>
          ▶
        </Caret>
        <Icon $tone="accent">✓</Icon>
        <Title>{headline}</Title>
      </Header>
      {reason && <Sub>{reason}</Sub>}
      {open && (
        <Body>
          {jobs.map((j) => {
            const tag = shortlistTag(j);
            return (
              <Row key={j.id}>
                <RowMark $approved={j.approved}>
                  {j.approved ? "✓" : "✕"}
                </RowMark>
                <JobLink jobId={j.id} label={j.title} block />
                <Tag $variant={tag}>{tag}</Tag>
              </Row>
            );
          })}
        </Body>
      )}
    </Card>
  );
}

// ---- shared bits ------------------------------------------------------

function Chip({
  icon,
  title,
  tone = "neutral",
  onClick,
}: {
  icon?: ReactNode;
  title: string;
  tone?: Tone;
  onClick?: () => void;
}) {
  const content = (
    <>
      {icon != null && <Icon $tone={tone}>{icon}</Icon>}
      <Title>{title}</Title>
    </>
  );
  if (onClick) {
    return (
      <Card as="button" type="button" onClick={onClick} $clickable>
        <Header as="div">{content}</Header>
      </Card>
    );
  }
  return (
    <Card>
      <Header as="div">{content}</Header>
    </Card>
  );
}

function JobLink({
  jobId,
  label,
  block,
}: {
  jobId: string;
  label: string;
  block?: boolean;
}) {
  return (
    <LinkText
      type="button"
      $block={block}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void viewJob(jobId);
      }}
    >
      {label}
    </LinkText>
  );
}

function CompanyLogo({
  name,
  logoUrl,
}: {
  name: string;
  // Pre-resolved logo URL (the picker runs companyLogoUrl at submit time and
  // embeds the final URL in _view). Empty/null → monogram fallback.
  logoUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  if (!logoUrl || failed) {
    return <LogoFallback aria-hidden>{initial(name)}</LogoFallback>;
  }
  return <LogoImg src={logoUrl} alt="" onError={() => setFailed(true)} />;
}

// chatStore actions read lazily so this module's helpers can call them
// without each card subscribing to the store.
function viewJob(id: string) {
  return useChatStore.getState().viewJob(id);
}
function viewCompany(id: string) {
  return useChatStore.getState().viewCompany(id);
}
function viewOpportunity(id: string) {
  return useChatStore.getState().viewOpportunity(id);
}

function parseShortlistJobs(raw: unknown): ShortlistJob[] {
  if (!Array.isArray(raw)) return [];
  const out: ShortlistJob[] = [];
  for (const j of raw) {
    if (!isRecord(j)) continue;
    if (typeof j.id !== "string" || typeof j.title !== "string") continue;
    out.push({
      id: j.id,
      title: j.title,
      approved: j.approved === true,
      recommended: j.recommended === true,
    });
  }
  return out;
}

// ---- styled ------------------------------------------------------------

type Tone = "accent" | "danger" | "muted" | "neutral";

const Card = styled.div<{ $clickable?: boolean }>`
  align-self: flex-end;
  max-width: 720px;
  width: fit-content;
  min-width: 0;
  background: ${({ theme }) => theme.colors.bgHover};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  text-align: left;
  font: inherit;
  color: ${({ theme }) => theme.colors.text};
  ${({ $clickable }) =>
    $clickable ? `appearance: none; cursor: pointer;` : ``}

  ${({ $clickable, theme }) =>
    $clickable ? `&:hover { background: ${theme.colors.bgMuted}; }` : ``}
`;

const Header = styled.div<{ $expandable?: boolean }>`
  appearance: none;
  background: transparent;
  border: 0;
  text-align: left;
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  color: ${({ theme }) => theme.colors.text};
  font: inherit;
  cursor: ${({ $expandable }) => ($expandable ? "pointer" : "inherit")};
  min-width: 0;

  &:hover {
    background: ${({ theme, $expandable }) =>
      $expandable ? theme.colors.bgMuted : "transparent"};
  }
`;

const Icon = styled.span<{ $tone: Tone }>`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $tone }) =>
    $tone === "accent"
      ? theme.colors.accent
      : $tone === "danger"
        ? theme.colors.danger
        : theme.colors.textMuted};
`;

const Title = styled.span`
  font-size: 13px;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  padding: 0 ${({ theme }) => theme.space.lg} ${({ theme }) => theme.space.sm};
  min-width: 0;
  word-break: break-word;
`;

const Caret = styled.span<{ $open: boolean }>`
  display: inline-block;
  font-size: 10px;
  color: ${({ theme }) => theme.colors.textMuted};
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s ease;
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgPanel};
`;

const Row = styled.div`
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.lg}`};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  &:last-child {
    border-bottom: none;
  }
`;

const RowMark = styled.span<{ $approved: boolean }>`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $approved }) =>
    $approved ? theme.colors.accent : theme.colors.textSubtle};
`;

const LinkText = styled.button<{ $block?: boolean }>`
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  font-size: ${({ $block }) => ($block ? "12px" : "inherit")};
  font-family: inherit;
  color: ${({ theme }) => theme.colors.text};
  cursor: pointer;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
`;

const Tag = styled.span<{ $variant: "pick" | "pass" | "override" }>`
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $variant }) =>
    $variant === "pick"
      ? theme.colors.accent
      : $variant === "override"
        ? theme.colors.danger
        : theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid
    ${({ theme, $variant }) =>
      $variant === "pick"
        ? theme.colors.accent
        : $variant === "override"
          ? theme.colors.danger
          : theme.colors.border};
`;

const NameChips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.xs};
  padding: 0 ${({ theme }) => theme.space.lg} ${({ theme }) => theme.space.sm};
`;

const NameChip = styled.span`
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.text};
`;

const LogoImg = styled.img`
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: contain;
  flex-shrink: 0;
`;

const LogoFallback = styled.span`
  width: 16px;
  height: 16px;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme }) => theme.colors.textMuted};
  flex-shrink: 0;
`;

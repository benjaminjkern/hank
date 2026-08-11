"use client";

import { useMemo, useState } from "react";
import styled from "styled-components";

import {
  useChatStore,
  type DashboardView as DashboardData,
  type DashboardCompany,
  type DashboardPausedCompany,
  type DashboardOpportunity,
  type DashboardClosedCompany,
  type DashboardBlockedCompany,
} from "@/lib/chatStore";
import {
  statusLabel,
  statusTone,
  toneColor,
  jobStatusColor,
  closedActionLabel,
  appliedTierBadge,
  type StatusTone,
} from "@/lib/statusColors";
import { fullDateTime, relativeTime } from "@/utils/date";
import { nowMs } from "@/utils/now";
import { initial } from "@/utils/text";

import { useExpandable } from "./shared/useExpandable";

// Triage buckets surfaced on the dashboard. The user reads top → bottom as
// "deal with this now → employer engaged → applied, waiting → can wait → just
// watching → paused → couldn't read → done". Bucket selection for a company
// maps its CompanyStatus (mostly auto-derived now) + any owed job status;
// bucketForCompany() below is the single decision point.
//
// "In process" (recruiter engaged / interview coming), "In flight" (key:
// awaitingReply — applied, waiting on the employer) and "Watching" (caught-up,
// no work) are three distinct company statuses now — each its own bucket.
type Bucket =
  | "now"
  | "inProcess"
  | "next"
  | "awaitingReply"
  | "watching"
  | "paused"
  | "blocked"
  | "closed";

// Bucket → status-tone color. Drives both the small dot before the section
// title and the tinted hover background on the header. now=Hank purple,
// inProcess=Hank purple (promising), next=dark grey, awaitingReply("In
// flight")=green, watching=teal, paused=amber, blocked=slate, closed=red.
// See [src/lib/statusColors.ts] + [docs/lifecycle.md].
const BUCKET_TONE: Record<Bucket, StatusTone> = {
  now: "focusNow",
  inProcess: "focusNow",
  next: "notStarted",
  awaitingReply: "resting",
  watching: "watching",
  paused: "deferred",
  blocked: "blocked",
  closed: "closed",
};

function userOwes(status: string): boolean {
  // Anything tagged focusNow (= mid-flight work the user actively drives)
  // bumps the company to Now. Currently: PITCHED, SCANNED, SHORTLISTED,
  // INTERVIEW_DEBRIEF, OFFERED.
  return statusTone(status) === "focusNow";
}

// Live buckets a company/opportunity can land in (the rest come pre-split from
// the server: paused / blocked / closed).
type LiveBucket = "now" | "inProcess" | "next" | "awaitingReply" | "watching";

function bucketForCompany(c: DashboardCompany): LiveBucket {
  // An owed job (interview debrief / offer) anywhere bubbles the company to Now,
  // regardless of its engagement status.
  if (c.jobInteractions.some((i) => userOwes(i.status))) return "now";
  // SHORTLISTING (board open, their marks owed) and APPLYING (working the
  // committed picks) are both live work → Now.
  if (c.status === "SHORTLISTING" || c.status === "APPLYING") return "now";
  // IN_PROCESS = an employer engaged (recruiter reply / interview) → its own
  // promising bucket.
  if (c.status === "IN_PROCESS") return "inProcess";
  // IN_FLIGHT = applications out, waiting to hear back → "In flight".
  if (c.status === "IN_FLIGHT") return "awaitingReply";
  // Defensive fallback: any live in-pipeline JobInteraction ⇒ ball's in their court
  // (covers legacy rows whose engagement status hasn't been re-derived).
  if (c.jobInteractions.length > 0) return "awaitingReply";
  // Truly idle / not-yet-started: NEW (no scan yet) and READY (scanned +
  // prescanned, walkthrough not started — also where a company sits while its
  // board is being read, since nothing is owed by the user yet).
  if (c.status === "NEW" || c.status === "READY") return "next";
  // CAUGHT_UP with nothing live: scanned, nothing actionable, just watching
  // for new postings — no work required.
  return "watching";
}

function bucketForOpportunity(o: DashboardOpportunity): LiveBucket {
  // OPEN (focusNow tone) = fresh lead, user owes triage. SCREENING + AWAITING
  // = waiting on the other side → "In flight" (the awaitingReply bucket).
  return statusTone(o.status) === "focusNow" ? "now" : "awaitingReply";
}

const BUCKET_META: Record<Bucket, { label: string; hint: string }> = {
  now: { label: "Now", hint: "deal with these" },
  inProcess: {
    label: "In process",
    hint: "a recruiter's engaged — interview coming",
  },
  next: { label: "Not started", hint: "haven't gotten to these yet" },
  awaitingReply: {
    label: "In flight",
    hint: "applied — ball's in their court",
  },
  watching: {
    label: "Watching",
    hint: "no work right now — checking back for new roles",
  },
  paused: {
    label: "Paused",
    hint: "set aside for now — revive to pick back up",
  },
  blocked: {
    label: "Blocked",
    hint: "couldn't read the board — revive to re-check",
  },
  closed: { label: "Closed", hint: "closed out or done" },
};

// Default-open buckets. Now + In process are expanded by default (the live,
// promising work); the rest are collapsed so the dashboard reads as "here's
// what you should be doing right now", everything else one click away.
const DEFAULT_OPEN: Record<Bucket, boolean> = {
  now: true,
  inProcess: true,
  next: false,
  awaitingReply: false,
  watching: false,
  paused: false,
  blocked: false,
  closed: false,
};

const Header = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const H2 = styled.h2`
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

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

const Group = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  margin-bottom: ${({ theme }) => theme.space.md};
  overflow: hidden;
`;

const GroupHeader = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

const GroupHeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

// Small logo chip rendered next to each dashboard company / closed row.
// 20px square so it sits cleanly on a 13px text line. Same fallback pattern
// as JobDetailView's CompanyLogoChip and the company page's CompanyLogo:
// img with onError → monogram.
const CompanyLogoBox = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  overflow: hidden;
`;

const CompanyLogoImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const CompanyLogoMonogram = styled.span`
  font-size: 11px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.accent};
`;

const GroupName = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const GroupCount = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
  flex-shrink: 0;
`;

const Row = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: baseline;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 3px solid transparent;
  font-size: 13px;
  text-align: left;
  background: transparent;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }

  &:last-child {
    border-bottom: none;
  }
`;

const Title = styled.div`
  color: ${({ theme }) => theme.colors.text};
`;

// Title + meta column inside a grid row. min-width: 0 lets the column shrink
// below its content's intrinsic width so the single-line JobMeta truncates
// with an ellipsis instead of forcing the grid to overflow and shove the
// status pill off the edge of the box.
const RowMain = styled.div`
  min-width: 0;
`;

// Bullet-separated parsed metadata under the job title — location · comp ·
// employment type · department. Mirrors JobDetailView's MetaLine; only the
// fields the scraper actually pulled render (all four are nullable).
const JobMeta = styled.div`
  margin-top: 2px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// `$appliedAt` + `$now` are only passed for job-status pills; without them
// jobStatusColor falls back to the plain tone, so company/opportunity pills can
// route through it unchanged.
const StatusPill = styled.span<{
  $status: string;
  $appliedAt?: string | null;
  $now?: number;
}>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 7px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.bgMuted};
  color: ${({ theme, $status, $appliedAt, $now }) =>
    jobStatusColor(theme, $status, $appliedAt, $now)};
  white-space: nowrap;
`;

const EmptyRow = styled.div`
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  font-size: 12px;
  font-style: italic;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// "+N more" / "Collapse" toggle for company + opportunity job lists that run
// past the preview cap. Full-width row so it reads as a list affordance, not
// a floating button; mono + accent matches the other dashboard chrome.
const MoreButton = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  text-align: left;
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Cap the inline job list inside each company / opportunity box; the rest
// hides behind a "+N more" toggle. Matches the company-detail page's preview.
const DASHBOARD_PREVIEW_COUNT = 5;

const EmptyHint = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-align: center;
  padding: ${({ theme }) => theme.space.xl};
  line-height: 1.5;
`;

// Soft "nothing in this bucket right now" message rendered under a section
// header that has zero items. Keeps the section frame visible so the user
// orients on the layout even when the queue is empty.
const BucketEmpty = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-style: italic;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
`;

// No wrapper opacity — dimming the whole section made rows read as
// non-interactive. Muted text colors on the row itself already signal
// "closed" without sapping the click affordance.
const ClosedSection = styled.div``;

const ClosedRow = styled.button.attrs({ type: "button" })`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  gap: ${({ theme }) => theme.space.md};
  align-items: center;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  margin-bottom: ${({ theme }) => theme.space.xs};
  text-align: left;
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Left side of a closed-company row: logo chip + company name (+ optional
// skip note underneath). Stays one cell of the parent grid so the skip
// reason label keeps its right-aligned position.
const ClosedRowLeft = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const CloseReasonLabel = styled.span`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  white-space: nowrap;
`;

// Freeform skip note under the company name when present. Mirrors the
// company page's closed-jobs treatment — visible inline rather than buried
// in a hover tooltip.
const CloseNoteLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 2px;
  line-height: 1.4;
`;

function emptyHintFor(c: DashboardCompany): string {
  // Defensive: SHORTLISTED commits auto-bump → APPLYING, so an APPLYING company
  // with zero in-pipeline jobs only happens if everything closed out without
  // an explicit move to CAUGHT_UP. Scrape info isn't useful here — the user
  // needs a status transition.
  if (c.status === "APPLYING") {
    return "all jobs closed — needs a caught-up check";
  }
  if (!c.lastScrapedJobsAt) {
    return "not yet scraped";
  }
  const when = relativeTime(c.lastScrapedJobsAt);
  const n = c.recentJobCount;
  const jobsWord = n === 1 ? "job" : "jobs";
  if (c.status === "READY") {
    // PRE_SCAN finished with survivors but the walkthrough hasn't started.
    return n === 0
      ? `scraped ${when} — ready to walk through`
      : `${n} ${jobsWord} scraped ${when} — ready to walk through`;
  }
  if (c.status === "NEW") {
    // Either scraped but no PRE_SCAN survivors landed yet (cold-start path),
    // or scrape returned zero. Distinguish from READY by absence of survivors.
    return n === 0
      ? `scraped ${when} — no jobs found`
      : `${n} ${jobsWord} scraped ${when} — shortlist pending`;
  }
  // CAUGHT_UP: worked through everything posted.
  return n === 0
    ? `scraped ${when} — no jobs found`
    : `${n} ${jobsWord} reviewed · last scrape ${when}`;
}

// ---------------------------------------------------------------------------
// Search / filter
//
// A single client-side filter over the already-loaded dashboard payload — no
// new fetch, no scrape. Typing narrows to a flat results view (companies /
// jobs / leads) that cuts across the triage buckets, since "find this thing"
// is orthogonal to "what's urgent". An empty box restores the normal bucketed
// dashboard. The "Track …" affordance at the bottom hands an unmatched name to
// Hank's existing watchlist-add flow (chat-first — no parallel add endpoint).
// ---------------------------------------------------------------------------

const SearchBar = styled.div`
  position: relative;
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const SearchInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.xl}`};
  font-size: 14px;
  font-family: inherit;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  outline: none;
  transition: border-color 0.12s ease;

  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }
  &:focus {
    border-color: ${({ theme }) => theme.colors.accent};
  }
`;

const SearchIcon = styled.svg`
  position: absolute;
  left: ${({ theme }) => theme.space.sm};
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: ${({ theme }) => theme.colors.textSubtle};
  pointer-events: none;
`;

const ClearButton = styled.button`
  position: absolute;
  right: ${({ theme }) => theme.space.xs};
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
  }
`;

// Section heading inside the search-results view ("Companies 3" / "Jobs 5" /
// "Leads 1"). Lighter than a bucket header — results aren't a triage queue,
// just a typed lookup.
const ResultGroupHead = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space.sm};
  margin: ${({ theme }) => `${theme.space.lg} 0 ${theme.space.sm}`};
`;

const ResultGroupTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
`;

const ResultGroupCount = styled.span`
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

// "Track '<name>'" affordance — the add half of the searchbar. Sends a plain
// "add this company" message into chat, which Hank's watchlist-add flow picks
// up (create_companies → enrich_companies). Full-width, accent-tinted so it
// reads as an action distinct from the result rows above it.
const AddNewButton = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  margin-top: ${({ theme }) => theme.space.md};
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: transparent;
  color: ${({ theme }) => theme.colors.accent};
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
  &:hover {
    background: ${({ theme }) =>
      `color-mix(in srgb, ${theme.colors.accent} 8%, transparent)`};
  }
`;

const AddNewPlus = styled.span`
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
`;

const AddNewQuery = styled.strong`
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`;

const NoResults = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textSubtle};
  text-align: center;
  padding: ${({ theme }) => `${theme.space.lg} ${theme.space.md} ${theme.space.sm}`};
`;

type CompanyHit = {
  companyId: string;
  companyName: string;
  logoUrl: string;
  stateLabel: string;
};
type JobHit = {
  jobId: string;
  title: string;
  companyName: string | null;
  status: string;
  meta: string | null;
  appliedAt: string | null;
};
type LeadHit = { opportunityId: string; label: string; status: string };
type SearchResults = {
  companies: CompanyHit[];
  jobs: JobHit[];
  leads: LeadHit[];
  total: number;
};

const norm = (s: string) => s.normalize("NFKD").toLowerCase().trim();

function buildSearchResults(
  data: DashboardData,
  rawQuery: string,
): SearchResults {
  const q = norm(rawQuery);
  const hit = (s: string | null | undefined) => !!s && norm(s).includes(q);

  // Companies span every bucket — searching should find one whatever its
  // status, so we sweep all four server-split lists, tagging each with a
  // friendly state label for the right-hand chip.
  const companies: CompanyHit[] = [];
  for (const c of data.companies) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: statusLabel(c.status) });
  }
  for (const c of data.closed ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Closed" });
  }
  for (const c of data.paused ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Paused" });
  }
  for (const c of data.blocked ?? []) {
    if (hit(c.companyName))
      companies.push({ ...pickCompany(c), stateLabel: "Blocked" });
  }

  // Jobs come from two places: a tracked company's roles and a lead's pitched
  // roles. Match on title OR the owning company name (so "stripe" surfaces
  // Stripe's roles too), then dedupe by jobId — a job can appear under both.
  const jobMap = new Map<string, JobHit>();
  for (const c of data.companies) {
    for (const i of c.jobInteractions) {
      if (hit(i.title) || hit(c.companyName)) {
        const appliedCaption =
          i.status === "APPLIED" && i.appliedAt
            ? `Applied ${relativeTime(i.appliedAt)}`
            : null;
        const meta = [
          appliedCaption,
          i.location,
          i.compensation,
          i.employmentType,
          i.department,
        ]
          .filter(Boolean)
          .join(" · ");
        if (!jobMap.has(i.jobId))
          jobMap.set(i.jobId, {
            jobId: i.jobId,
            title: i.title,
            companyName: c.companyName,
            status: i.status,
            meta: meta || null,
            appliedAt: i.appliedAt,
          });
      }
    }
  }
  for (const o of data.opportunities ?? []) {
    for (const j of o.jobs ?? []) {
      const co = j.companyDisplayName ?? o.label;
      if (hit(j.title) || hit(co)) {
        if (!jobMap.has(j.jobId))
          jobMap.set(j.jobId, {
            jobId: j.jobId,
            title: j.title,
            companyName: co,
            status: j.status,
            meta: null,
            // Opportunity-pitched roles don't carry an apply date in the
            // dashboard payload — no aging for these search hits.
            appliedAt: null,
          });
      }
    }
  }
  const jobs = [...jobMap.values()];

  const leads: LeadHit[] = [];
  for (const o of data.opportunities ?? []) {
    if (hit(o.label))
      leads.push({
        opportunityId: o.opportunityId,
        label: o.label,
        status: o.status,
      });
  }

  // Prefix matches first within each section, then alphabetical.
  const rank = (s: string) => (norm(s).startsWith(q) ? 0 : 1);
  companies.sort(
    (a, b) =>
      rank(a.companyName) - rank(b.companyName) ||
      a.companyName.localeCompare(b.companyName),
  );
  jobs.sort(
    (a, b) => rank(a.title) - rank(b.title) || a.title.localeCompare(b.title),
  );
  leads.sort(
    (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label),
  );

  return {
    companies,
    jobs,
    leads,
    total: companies.length + jobs.length + leads.length,
  };
}

function pickCompany(c: {
  companyId: string;
  companyName: string;
  logoUrl: string;
}) {
  return {
    companyId: c.companyId,
    companyName: c.companyName,
    logoUrl: c.logoUrl,
  };
}

export function DashboardView({ data }: { data: DashboardData }) {
  const viewCompany = useChatStore((s) => s.viewCompany);
  const viewJob = useChatStore((s) => s.viewJob);
  const viewOpportunity = useChatStore((s) => s.viewOpportunity);
  const send = useChatStore((s) => s.send);
  const setActivePanel = useChatStore((s) => s.setActivePanel);
  // View-session (impersonation) mode is read-only — send() no-ops there, so
  // hide the add affordance rather than render a dead button.
  const canTrackNew = useChatStore((s) => s.impersonateSessionId === null);
  // Per-bucket open/closed state. Initial values from DEFAULT_OPEN — only Now
  // starts open so actionable work is visible on load; every other bucket
  // (Not started / Awaiting reply / Watching / Deferred / Blocked / Closed)
  // starts collapsed.
  const [openBuckets, setOpenBuckets] =
    useState<Record<Bucket, boolean>>(DEFAULT_OPEN);
  const toggleBucket = (b: Bucket) =>
    setOpenBuckets((prev) => ({ ...prev, [b]: !prev[b] }));

  // Searchbar state. Empty → normal bucketed dashboard; non-empty → flat
  // filtered results across companies / jobs / leads.
  const [query, setQuery] = useState("");
  const searching = norm(query).length > 0;
  const results = useMemo(
    () => (searching ? buildSearchResults(data, query) : null),
    [data, query, searching],
  );

  // The add half: hand an unmatched company name to Hank's chat-first
  // watchlist-add flow. Surface the chat pane (narrow viewports), fire the
  // message, and drop back to the bucketed view.
  const trackNew = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setActivePanel("chat");
    void send(`Add ${n} to my watchlist.`);
    setQuery("");
  };

  const hasCompanies = data.companies.length > 0;
  const hasClosed = data.closed.length > 0;
  // `paused` (was `deferred`) — guard older API responses (cached SSR / stale
  // page chunks) that don't include the field. No revisit timer anymore, so
  // every paused company sits in the Paused bucket until revived.
  const pausedList = data.paused ?? [];
  const hasPaused = pausedList.length > 0;
  // `blocked` was added with the BLOCKED status — guard older API responses.
  const blockedList = data.blocked ?? [];
  const hasBlocked = blockedList.length > 0;
  const opportunities = data.opportunities ?? [];
  const hasOpportunities = opportunities.length > 0;

  // Bucket the live items into the "still in motion" buckets. Each carries both
  // companies and opportunities so the user sees one cohesive triage list per
  // urgency band. PAUSED / BLOCKED / CLOSED companies skip this loop entirely
  // — they come pre-split from the server in `data.paused` / `data.blocked` /
  // `data.closed`.
  type BucketContents = {
    companies: DashboardCompany[];
    opportunities: DashboardOpportunity[];
  };
  const liveBuckets: Record<LiveBucket, BucketContents> = {
    now: { companies: [], opportunities: [] },
    inProcess: { companies: [], opportunities: [] },
    next: { companies: [], opportunities: [] },
    awaitingReply: { companies: [], opportunities: [] },
    watching: { companies: [], opportunities: [] },
  };
  for (const c of data.companies) {
    liveBuckets[bucketForCompany(c)].companies.push(c);
  }
  for (const o of opportunities) {
    liveBuckets[bucketForOpportunity(o)].opportunities.push(o);
  }

  return (
    <>
      <Header>
        <H2>Dashboard</H2>
      </Header>

      <SearchBar>
        <SearchIcon viewBox="0 0 16 16" aria-hidden>
          <path
            d="M7 1.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.13A5.5 5.5 0 0 0 7 1.5Zm-4 5.5a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
            fill="currentColor"
          />
        </SearchIcon>
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search companies & jobs…"
          aria-label="Search companies and jobs"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <ClearButton
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            ×
          </ClearButton>
        )}
      </SearchBar>

      {searching && results ? (
        <SearchResultsView
          results={results}
          query={query.trim()}
          canTrackNew={canTrackNew}
          onTrackNew={() => trackNew(query)}
          onPickCompany={(id) => void viewCompany(id)}
          onPickJob={(id) => void viewJob(id)}
          onPickLead={(id) => void viewOpportunity(id)}
        />
      ) : (
        <>
          {!hasCompanies &&
            !hasClosed &&
            !hasPaused &&
            !hasBlocked &&
            !hasOpportunities && (
              <EmptyHint>
                Your watchlist is empty — open chat and ask Hank to add
                companies you&apos;re interested in.
              </EmptyHint>
            )}

          {(
            ["now", "inProcess", "next", "awaitingReply", "watching"] as const
          ).map((b) => {
            const contents = liveBuckets[b];
            const itemCount =
              contents.companies.length + contents.opportunities.length;
            const isEmpty = itemCount === 0;
            // Always render Now so the dashboard's shape stays recognizable
            // across triage states. Hide the rest when empty — they're transient
            // queues often genuinely empty.
            if (b !== "now" && isEmpty) return null;
            const open = openBuckets[b];
            return (
              <BucketSection key={b}>
                <BucketHeader
                  $tone={b}
                  onClick={() => toggleBucket(b)}
                  type="button"
                  title={BUCKET_META[b].hint}
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
                  <BucketDot $tone={b} />
                  <BucketTitle>{BUCKET_META[b].label}</BucketTitle>
                  {itemCount > 0 && <BucketCount>{itemCount}</BucketCount>}
                </BucketHeader>
                {open &&
                  (isEmpty ? (
                    <BucketEmpty>Nothing on your plate right now.</BucketEmpty>
                  ) : (
                    <>
                      {contents.opportunities.map((o) => (
                        <OpportunityRow
                          key={o.opportunityId}
                          opportunity={o}
                          onPickLead={() =>
                            void viewOpportunity(o.opportunityId)
                          }
                          onPickJob={(jobId) => void viewJob(jobId)}
                        />
                      ))}
                      {contents.companies.map((c) => (
                        <CompanyGroup
                          key={c.companyId}
                          company={c}
                          onPickCompany={() => void viewCompany(c.companyId)}
                          onPickJob={(jobId) => void viewJob(jobId)}
                        />
                      ))}
                    </>
                  ))}
              </BucketSection>
            );
          })}

          {hasPaused && (
            <BucketSection>
              <BucketHeader
                $tone="paused"
                onClick={() => toggleBucket("paused")}
                type="button"
                title={BUCKET_META.paused.hint}
              >
                <BucketCaret
                  $open={openBuckets.paused}
                  viewBox="0 0 10 10"
                  aria-hidden
                >
                  <path
                    d="M3.5 2 L7 5 L3.5 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </BucketCaret>
                <BucketDot $tone="paused" />
                <BucketTitle>{BUCKET_META.paused.label}</BucketTitle>
                <BucketCount>{pausedList.length}</BucketCount>
              </BucketHeader>
              {openBuckets.paused && (
                <ClosedSection>
                  {pausedList.map((c) => (
                    <PausedCompanyRow
                      key={c.companyId}
                      company={c}
                      onPick={() => void viewCompany(c.companyId)}
                    />
                  ))}
                </ClosedSection>
              )}
            </BucketSection>
          )}

          {hasBlocked && (
            <BucketSection>
              <BucketHeader
                $tone="blocked"
                onClick={() => toggleBucket("blocked")}
                type="button"
                title={BUCKET_META.blocked.hint}
              >
                <BucketCaret
                  $open={openBuckets.blocked}
                  viewBox="0 0 10 10"
                  aria-hidden
                >
                  <path
                    d="M3.5 2 L7 5 L3.5 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </BucketCaret>
                <BucketDot $tone="blocked" />
                <BucketTitle>{BUCKET_META.blocked.label}</BucketTitle>
                <BucketCount>{blockedList.length}</BucketCount>
              </BucketHeader>
              {openBuckets.blocked && (
                <ClosedSection>
                  {blockedList.map((c) => (
                    <BlockedCompanyRow
                      key={c.companyId}
                      company={c}
                      onPick={() => void viewCompany(c.companyId)}
                    />
                  ))}
                </ClosedSection>
              )}
            </BucketSection>
          )}

          {hasClosed && (
            <BucketSection>
              <BucketHeader
                $tone="closed"
                onClick={() => toggleBucket("closed")}
                type="button"
                title={BUCKET_META.closed.hint}
              >
                <BucketCaret
                  $open={openBuckets.closed}
                  viewBox="0 0 10 10"
                  aria-hidden
                >
                  <path
                    d="M3.5 2 L7 5 L3.5 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </BucketCaret>
                <BucketDot $tone="closed" />
                <BucketTitle>{BUCKET_META.closed.label}</BucketTitle>
                <BucketCount>{data.closed.length}</BucketCount>
              </BucketHeader>
              {openBuckets.closed && (
                <ClosedSection>
                  {data.closed.map((c) => (
                    <ClosedCompanyRow
                      key={c.companyId}
                      company={c}
                      onPick={() => void viewCompany(c.companyId)}
                    />
                  ))}
                </ClosedSection>
              )}
            </BucketSection>
          )}
        </>
      )}
    </>
  );
}

// One flat results view, replacing the bucket layout while a query is active.
// Sections render only when they have hits; the "Track …" affordance is the
// add half — prominent when nothing matched, a quieter footer otherwise.
function SearchResultsView({
  results,
  query,
  canTrackNew,
  onTrackNew,
  onPickCompany,
  onPickJob,
  onPickLead,
}: {
  results: SearchResults;
  query: string;
  canTrackNew: boolean;
  onTrackNew: () => void;
  onPickCompany: (companyId: string) => void;
  onPickJob: (jobId: string) => void;
  onPickLead: (opportunityId: string) => void;
}) {
  const { companies, jobs, leads, total } = results;
  const now = nowMs();
  return (
    <ClosedSection>
      {total === 0 && (
        <NoResults>No companies, jobs, or leads match “{query}”.</NoResults>
      )}

      {companies.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Companies</ResultGroupTitle>
            <ResultGroupCount>{companies.length}</ResultGroupCount>
          </ResultGroupHead>
          {companies.map((c) => (
            <ClosedRow
              key={c.companyId}
              onClick={() => onPickCompany(c.companyId)}
            >
              <ClosedRowLeft>
                <CompanyLogoChip logoUrl={c.logoUrl} name={c.companyName} />
                <Title>{c.companyName}</Title>
              </ClosedRowLeft>
              <CloseReasonLabel>{c.stateLabel}</CloseReasonLabel>
            </ClosedRow>
          ))}
        </>
      )}

      {jobs.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Jobs</ResultGroupTitle>
            <ResultGroupCount>{jobs.length}</ResultGroupCount>
          </ResultGroupHead>
          {jobs.map((j) => {
            const sub = [j.companyName, j.meta].filter(Boolean).join(" · ");
            return (
              <ClosedRow key={j.jobId} onClick={() => onPickJob(j.jobId)}>
                <ClosedRowLeft>
                  <div>
                    <Title>{j.title}</Title>
                    {sub && <CloseNoteLine>{sub}</CloseNoteLine>}
                  </div>
                </ClosedRowLeft>
                <StatusPill
                  $status={j.status}
                  $appliedAt={j.appliedAt}
                  $now={now}
                >
                  {statusLabel(j.status)}
                  {appliedTierBadge(j.appliedAt, now)}
                </StatusPill>
              </ClosedRow>
            );
          })}
        </>
      )}

      {leads.length > 0 && (
        <>
          <ResultGroupHead>
            <ResultGroupTitle>Leads</ResultGroupTitle>
            <ResultGroupCount>{leads.length}</ResultGroupCount>
          </ResultGroupHead>
          {leads.map((l) => (
            <ClosedRow
              key={l.opportunityId}
              onClick={() => onPickLead(l.opportunityId)}
            >
              <ClosedRowLeft>
                <Title>{l.label}</Title>
              </ClosedRowLeft>
              <StatusPill $status={l.status}>
                {statusLabel(l.status)}
              </StatusPill>
            </ClosedRow>
          ))}
        </>
      )}

      {canTrackNew && (
        <AddNewButton type="button" onClick={onTrackNew}>
          <AddNewPlus>+</AddNewPlus>
          <span>
            Track <AddNewQuery>“{query}”</AddNewQuery> as a new company
          </span>
        </AddNewButton>
      )}
    </ClosedSection>
  );
}

function ClosedCompanyRow({
  company,
  onPick,
}: {
  company: DashboardClosedCompany;
  onPick: () => void;
}) {
  const reasonLabel = company.closeReason ?? "OTHER";
  return (
    <ClosedRow onClick={onPick}>
      <ClosedRowLeft>
        <CompanyLogoChip logoUrl={company.logoUrl} name={company.companyName} />
        <div>
          <Title>{company.companyName}</Title>
          {company.closeNote && (
            <CloseNoteLine>{company.closeNote}</CloseNoteLine>
          )}
        </div>
      </ClosedRowLeft>
      <CloseReasonLabel>{reasonLabel}</CloseReasonLabel>
    </ClosedRow>
  );
}

function PausedCompanyRow({
  company,
  onPick,
}: {
  company: DashboardPausedCompany;
  onPick: () => void;
}) {
  const reasonLabel = statusLabel(company.pauseReason ?? "OTHER");
  return (
    <ClosedRow onClick={onPick}>
      <ClosedRowLeft>
        <CompanyLogoChip logoUrl={company.logoUrl} name={company.companyName} />
        <div>
          <Title>{company.companyName}</Title>
          {company.pauseNote && (
            <CloseNoteLine>{company.pauseNote}</CloseNoteLine>
          )}
        </div>
      </ClosedRowLeft>
      <CloseReasonLabel>{reasonLabel}</CloseReasonLabel>
    </ClosedRow>
  );
}

function BlockedCompanyRow({
  company,
  onPick,
}: {
  company: DashboardBlockedCompany;
  onPick: () => void;
}) {
  // Render the raw reason enum (UPPERCASE), matching the closed/deferred reason
  // chips, which show closeReason/deferReason verbatim.
  const reasonLabel = company.blockReason ?? "OTHER";
  return (
    <ClosedRow onClick={onPick}>
      <ClosedRowLeft>
        <CompanyLogoChip logoUrl={company.logoUrl} name={company.companyName} />
        <div>
          <Title>{company.companyName}</Title>
          {company.blockNote && (
            <CloseNoteLine>{company.blockNote}</CloseNoteLine>
          )}
        </div>
      </ClosedRowLeft>
      <CloseReasonLabel>{reasonLabel}</CloseReasonLabel>
    </ClosedRow>
  );
}

function CompanyLogoChip({ logoUrl, name }: { logoUrl: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <CompanyLogoBox>
      {failed ? (
        <CompanyLogoMonogram>{initial(name)}</CompanyLogoMonogram>
      ) : (
        <CompanyLogoImg src={logoUrl} alt="" onError={() => setFailed(true)} />
      )}
    </CompanyLogoBox>
  );
}

// Opportunity group header: lead label on top, contact attribution + next-step
// timing on a sub-line. Mirrors the Company GroupHeader shape so the user's
// eye reads both sections the same way.
const OppGroupHeader = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.md} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: ${({ theme }) => theme.space.sm};
  row-gap: 2px;
  align-items: center;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bg};
  text-align: left;
  cursor: pointer;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
`;

// Top row of the opportunity header: label + status pill inline, mirroring
// the company header (logo + name + status). min-width: 0 keeps a long label
// from shoving the pill out.
const OppGroupLabelRow = styled.div`
  grid-row: 1;
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const OppGroupLabel = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const OppGroupMeta = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  grid-row: 2;
  grid-column: 1;
`;

// "N in pipeline" count in the top-right of the opportunity header, spanning
// both rows so it sits centered like the company header's count.
const OppGroupCount = styled(GroupCount)`
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
`;

// One role row inside an opportunity group. Three columns: title (+ optional
// company), status pill, optional "applied" badge. Click navigates to the
// promoted JobInteraction if there is one, otherwise opens the lead.
const RoleRow = styled.button`
  width: 100%;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.lg}`};
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: ${({ theme }) => theme.space.md};
  align-items: center;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 3px solid transparent;
  font-size: 13px;
  text-align: left;
  background: transparent;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
  }
  &:last-child {
    border-bottom: none;
  }
`;

// Mute closed/rejected jobs so the row count doesn't dominate the visual
// weight of leads where most pitches turned out to be passes.
const MutedRoleRow = styled(RoleRow)`
  opacity: 0.55;
`;

const RoleTitle = styled.div`
  color: ${({ theme }) => theme.colors.text};
`;

const RoleSubLine = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: 1px;
`;

const RolePills = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

function OpportunityRow({
  opportunity,
  onPickLead,
  onPickJob,
}: {
  opportunity: DashboardOpportunity;
  onPickLead: () => void;
  onPickJob: (jobId: string) => void;
}) {
  const metaParts: string[] = [];
  if (opportunity.primaryContact) {
    const name = opportunity.primaryContact.name;
    metaParts.push(
      `via ${name}${opportunity.primaryContact.agency ? ` (${opportunity.primaryContact.agency})` : ""}`,
    );
  }
  if (opportunity.nextStepAt) {
    metaParts.push(`next: ${fullDateTime(opportunity.nextStepAt)}`);
  } else if (opportunity.status === "OPEN") {
    metaParts.push("no call scheduled");
  }

  const jobs = opportunity.jobs ?? [];
  const now = nowMs();
  const {
    visible: visibleJobs,
    truncated,
    canCollapse,
    hiddenCount,
    expand,
    collapse,
  } = useExpandable(jobs, DASHBOARD_PREVIEW_COUNT);

  return (
    <Group>
      <OppGroupHeader onClick={onPickLead}>
        <OppGroupLabelRow>
          <OppGroupLabel>{opportunity.label}</OppGroupLabel>
          <StatusPill $status={opportunity.status}>
            {opportunity.status}
          </StatusPill>
        </OppGroupLabelRow>
        {metaParts.length > 0 && (
          <OppGroupMeta>{metaParts.join(" · ")}</OppGroupMeta>
        )}
        {jobs.length > 0 && (
          <OppGroupCount>{jobs.length} in pipeline</OppGroupCount>
        )}
      </OppGroupHeader>
      {jobs.length === 0 ? (
        <EmptyRow>no roles pitched yet</EmptyRow>
      ) : (
        <>
          {visibleJobs.map((j) => {
            const muted = j.status === "CLOSED" || j.status === "REJECTED";
            const RowComponent = muted ? MutedRoleRow : RoleRow;
            const timingCaption =
              j.status === "APPLIED" && j.appliedAt
                ? `Applied ${relativeTime(j.appliedAt)}`
                : j.closedAt
                  ? `${closedActionLabel(j.status, null)} ${relativeTime(j.closedAt)}`
                  : null;
            const subParts = [
              j.companyDisplayName ? `@ ${j.companyDisplayName}` : null,
              timingCaption,
            ].filter(Boolean);
            return (
              <RowComponent
                key={j.jobInteractionId}
                onClick={() => onPickJob(j.jobId)}
              >
                <RowMain>
                  <RoleTitle>{j.title}</RoleTitle>
                  {subParts.length > 0 && (
                    <RoleSubLine>{subParts.join(" · ")}</RoleSubLine>
                  )}
                </RowMain>
                <RolePills>
                  <StatusPill
                    $status={j.status}
                    $appliedAt={j.appliedAt}
                    $now={now}
                  >
                    {j.status}
                    {appliedTierBadge(j.appliedAt, now)}
                  </StatusPill>
                </RolePills>
              </RowComponent>
            );
          })}
          {truncated ? (
            <MoreButton onClick={expand}>+{hiddenCount} more</MoreButton>
          ) : canCollapse ? (
            <MoreButton onClick={collapse}>Collapse</MoreButton>
          ) : null}
        </>
      )}
    </Group>
  );
}

// One company box in a live bucket: header (logo + name + status + "N in
// pipeline" count) over its job rows, capped at DASHBOARD_PREVIEW_COUNT with
// a "+N more" toggle. Extracted from the bucket render so it can own the
// expand state (hooks can't live in a .map callback).
function CompanyGroup({
  company: c,
  onPickCompany,
  onPickJob,
}: {
  company: DashboardCompany;
  onPickCompany: () => void;
  onPickJob: (jobId: string) => void;
}) {
  const jobs = c.jobInteractions;
  const now = nowMs();
  const {
    visible: visibleJobs,
    truncated,
    canCollapse,
    hiddenCount,
    expand,
    collapse,
  } = useExpandable(jobs, DASHBOARD_PREVIEW_COUNT);

  return (
    <Group>
      <GroupHeader onClick={onPickCompany}>
        <GroupHeaderLeft>
          <CompanyLogoChip logoUrl={c.logoUrl} name={c.companyName} />
          <GroupName>{c.companyName}</GroupName>
          <StatusPill $status={c.status}>{c.status}</StatusPill>
        </GroupHeaderLeft>
        {jobs.length > 0 && (
          <GroupCount>
            {jobs.length} in pipeline
            {c.lastScrapedJobsAt &&
              ` · Scraped ${relativeTime(c.lastScrapedJobsAt)}`}
          </GroupCount>
        )}
      </GroupHeader>
      {jobs.length === 0 ? (
        <EmptyRow>{emptyHintFor(c)}</EmptyRow>
      ) : (
        <>
          {visibleJobs.map((i) => {
            // For an applied job, lead the meta with when it went out so the
            // user sees the wait at a glance (the pill color escalates with it).
            const appliedCaption =
              i.status === "APPLIED" && i.appliedAt
                ? `Applied ${relativeTime(i.appliedAt)}`
                : null;
            const meta = [
              appliedCaption,
              i.location,
              i.compensation,
              i.employmentType,
              i.department,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Row key={i.jobInteractionId} onClick={() => onPickJob(i.jobId)}>
                <RowMain>
                  <Title>{i.title}</Title>
                  {meta && <JobMeta>{meta}</JobMeta>}
                </RowMain>
                <StatusPill
                  $status={i.status}
                  $appliedAt={i.appliedAt}
                  $now={now}
                >
                  {i.status}
                  {appliedTierBadge(i.appliedAt, now)}
                </StatusPill>
              </Row>
            );
          })}
          {truncated ? (
            <MoreButton onClick={expand}>+{hiddenCount} more</MoreButton>
          ) : canCollapse ? (
            <MoreButton onClick={collapse}>Collapse</MoreButton>
          ) : null}
        </>
      )}
    </Group>
  );
}

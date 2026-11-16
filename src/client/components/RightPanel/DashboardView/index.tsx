"use client";

import { useMemo, useState } from "react";
import styled from "styled-components";

import {
  useChatStore,
  type DashboardView as DashboardData,
} from "@/client/chatStore";

import { bucketLiveItems, DEFAULT_OPEN, type Bucket } from "./buckets";
import { buildSearchResults, norm } from "./buildSearchResults";
import { CompanyGroup } from "./CompanyGroup";
import { DashboardBucket } from "./DashboardBucket";
import { DashboardSearchBar } from "./DashboardSearchBar";
import { OpportunityRow } from "./OpportunityRow";
import { SearchResultsView } from "./SearchResultsView";
import {
  BlockedCompanyRow,
  ClosedCompanyRow,
  PausedCompanyRow,
} from "./SetAsideCompanyRows";
import { ClosedSection } from "./sharedStyles";

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

  const liveBuckets = bucketLiveItems(data.companies, opportunities);

  return (
    <>
      <Header>
        <H2>Dashboard</H2>
      </Header>

      <DashboardSearchBar query={query} onQueryChange={setQuery} />

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
            return (
              <DashboardBucket
                key={b}
                bucket={b}
                count={itemCount}
                open={openBuckets[b]}
                onToggle={() => toggleBucket(b)}
              >
                {isEmpty ? (
                  <BucketEmpty>Nothing on your plate right now.</BucketEmpty>
                ) : (
                  <>
                    {contents.opportunities.map((o) => (
                      <OpportunityRow
                        key={o.opportunityId}
                        opportunity={o}
                        onPickLead={() => void viewOpportunity(o.opportunityId)}
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
                )}
              </DashboardBucket>
            );
          })}

          {hasPaused && (
            <DashboardBucket
              bucket="paused"
              count={pausedList.length}
              open={openBuckets.paused}
              onToggle={() => toggleBucket("paused")}
            >
              <ClosedSection>
                {pausedList.map((c) => (
                  <PausedCompanyRow
                    key={c.companyId}
                    company={c}
                    onPick={() => void viewCompany(c.companyId)}
                  />
                ))}
              </ClosedSection>
            </DashboardBucket>
          )}

          {hasBlocked && (
            <DashboardBucket
              bucket="blocked"
              count={blockedList.length}
              open={openBuckets.blocked}
              onToggle={() => toggleBucket("blocked")}
            >
              <ClosedSection>
                {blockedList.map((c) => (
                  <BlockedCompanyRow
                    key={c.companyId}
                    company={c}
                    onPick={() => void viewCompany(c.companyId)}
                  />
                ))}
              </ClosedSection>
            </DashboardBucket>
          )}

          {hasClosed && (
            <DashboardBucket
              bucket="closed"
              count={data.closed.length}
              open={openBuckets.closed}
              onToggle={() => toggleBucket("closed")}
            >
              <ClosedSection>
                {data.closed.map((c) => (
                  <ClosedCompanyRow
                    key={c.companyId}
                    company={c}
                    onPick={() => void viewCompany(c.companyId)}
                  />
                ))}
              </ClosedSection>
            </DashboardBucket>
          )}
        </>
      )}
    </>
  );
}

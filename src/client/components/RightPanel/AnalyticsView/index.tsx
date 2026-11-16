"use client";

import { useEffect, useState } from "react";
import styled from "styled-components";

import { useChatStore } from "@/client/chatStore";
import { withImpersonate } from "@/shared/impersonation";
import type { AnalyticsData } from "@/shared/views/analytics";

import { ActivitySection } from "./ActivitySection";
import { FunnelSection } from "./FunnelSection";
import { Empty } from "./styles";

export function AnalyticsView() {
  const impersonate = useChatStore((s) => s.impersonateSessionId);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(withImpersonate("/api/analytics", impersonate))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d: AnalyticsData) => {
        if (!cancelled) {
          setData(d);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [impersonate]);

  if (loadError)
    return (
      <Empty>
        Couldn&apos;t load your analytics — reopen this view to retry.
      </Empty>
    );
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <Wrap>
      <PageHead>
        <PageTitle>Analytics</PageTitle>
        <PageHint>
          Your search at a glance — daily activity and where every application
          stands.
        </PageHint>
      </PageHead>
      <ActivitySection advancements={data.advancements} />
      <FunnelSection applications={data.applications} />
    </Wrap>
  );
}

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
`;

const PageHead = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
  margin-bottom: ${({ theme }) => theme.space.xs};
`;

const PageTitle = styled.h2`
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: 0;
`;

const PageHint = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

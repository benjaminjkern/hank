import styled from "styled-components";

import { useChatStore } from "@/client/chatStore";

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

export function JobRefChip({ jobId, label }: { jobId: string; label: string }) {
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

export function FocusRefChip(props: FocusRefChipProps) {
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

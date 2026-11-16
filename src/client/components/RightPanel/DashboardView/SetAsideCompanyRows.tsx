import type {
  DashboardBlockedCompany,
  DashboardClosedCompany,
  DashboardPausedCompany,
} from "@/client/chatStore";
import { statusLabel } from "@/shared/statusColors";

import { CompanyLogoChip } from "../shared/CompanyLogoChip";

import {
  CloseNoteLine,
  CloseReasonLabel,
  ClosedRow,
  ClosedRowLeft,
  Title,
} from "./sharedStyles";

// One flat row per company in the Paused / Blocked / Closed buckets: logo +
// name (+ the freeform note) on the left, the reason on the right.

export function ClosedCompanyRow({
  company,
  onPick,
}: {
  company: DashboardClosedCompany;
  onPick: () => void;
}) {
  const reasonLabel = statusLabel(company.closeReason ?? "OTHER");
  return (
    <ClosedRow onClick={onPick}>
      <ClosedRowLeft>
        <CompanyLogoChip
          logoUrl={company.logoUrl}
          name={company.companyName}
          size={20}
        />
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

export function PausedCompanyRow({
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
        <CompanyLogoChip
          logoUrl={company.logoUrl}
          name={company.companyName}
          size={20}
        />
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

export function BlockedCompanyRow({
  company,
  onPick,
}: {
  company: DashboardBlockedCompany;
  onPick: () => void;
}) {
  const reasonLabel = statusLabel(company.blockReason ?? "OTHER");
  return (
    <ClosedRow onClick={onPick}>
      <ClosedRowLeft>
        <CompanyLogoChip
          logoUrl={company.logoUrl}
          name={company.companyName}
          size={20}
        />
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

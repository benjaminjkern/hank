import { useState } from "react";
import styled from "styled-components";

import { initial } from "@/shared/utils/text";

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

export function CompanyLogoChip({
  logoUrl,
  name,
}: {
  logoUrl: string;
  name: string;
}) {
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

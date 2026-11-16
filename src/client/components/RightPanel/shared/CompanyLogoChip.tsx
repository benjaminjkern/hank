import { useState } from "react";
import styled from "styled-components";

import { initial } from "@/shared/utils/text";

// A company's logo in a square chip, falling back to its monogram when there's
// no URL to try or the image fails to load. `logoUrl` arrives already resolved
// through companyLogoUrl, whose "" means "nothing to try".
//
// The monogram scales with the box (40% + 3px: 9px in a 16px chip, 11px in a
// 20px one, 22px in a 48px one), and the corner radius steps up once the chip
// is big enough for a small corner to read as square.
const LARGE_CHIP_PX = 32;

const LogoBox = styled.span<{ $size: number }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  flex-shrink: 0;
  border-radius: ${({ theme, $size }) =>
    $size >= LARGE_CHIP_PX ? theme.radius.md : theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  overflow: hidden;
`;

const LogoImg = styled.img`
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

const Monogram = styled.span<{ $size: number }>`
  font-size: ${({ $size }) => Math.round($size * 0.4 + 3)}px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.accent};
`;

export function CompanyLogoChip({
  logoUrl,
  name,
  size,
}: {
  logoUrl: string | null;
  name: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <LogoBox $size={size}>
      {!logoUrl || failed ? (
        <Monogram $size={size} aria-hidden>
          {initial(name)}
        </Monogram>
      ) : (
        <LogoImg src={logoUrl} alt="" onError={() => setFailed(true)} />
      )}
    </LogoBox>
  );
}

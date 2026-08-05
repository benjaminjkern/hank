"use client";

import styled from "styled-components";

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${({ theme }) => theme.colors.bgPanel}cc;
  border: 2px dashed ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.md};
  pointer-events: none;
`;

const Label = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.accent};
  font-family: ${({ theme }) => theme.font.mono};
`;

export function DropOverlay() {
  return (
    <Overlay>
      <Label>drop files to attach</Label>
    </Overlay>
  );
}

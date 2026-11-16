"use client";

import styled from "styled-components";

import {
  documentsSubPageLabel,
  type DocumentsSubPage,
} from "@/shared/panelMode";

import { PageHead, Wrap } from "./styles";

// Getting back up to the index is the breadcrumb's job (`Dashboard /
// Documents / <this page>`) and the browser's — each sub-page has its own URL.
export function SubPageShell({
  subPage,
  hint,
  children,
}: {
  subPage: DocumentsSubPage;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Wrap>
      <PageHead>
        <SubTitle>{documentsSubPageLabel(subPage)}</SubTitle>
        {hint && <SubHint>{hint}</SubHint>}
      </PageHead>
      {children}
    </Wrap>
  );
}

const SubTitle = styled.h3`
  font-size: 15px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  margin: ${({ theme }) => `${theme.space.xs} 0 0 0`};
`;

const SubHint = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
  margin-top: 2px;
`;

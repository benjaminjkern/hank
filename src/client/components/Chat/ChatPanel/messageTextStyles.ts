import styled from "styled-components";

export const UserText = styled.div`
  white-space: pre-wrap;
`;

// Tight inside-bubble markdown spacing: paragraphs collapse the bubble's own
// vertical rhythm, code blocks stay inside the bubble, links use the accent.
export const MarkdownText = styled.div`
  p {
    margin: 0;
  }
  p + p {
    margin-top: ${({ theme }) => theme.space.sm};
  }
  ul,
  ol {
    margin: ${({ theme }) => theme.space.xs} 0;
    padding-left: ${({ theme }) => theme.space.xl};
  }
  li + li {
    margin-top: 2px;
  }
  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin: ${({ theme }) => theme.space.md} 0 ${({ theme }) => theme.space.xs};
    font-weight: 600;
    line-height: 1.3;
  }
  h1 {
    font-size: 17px;
  }
  h2 {
    font-size: 16px;
  }
  h3 {
    font-size: 15px;
  }
  h4,
  h5,
  h6 {
    font-size: 14px;
  }
  a {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
  code {
    font-family: ${({ theme }) => theme.font.mono};
    background: ${({ theme }) => theme.colors.bgMuted};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    padding: 0 4px;
    font-size: 12px;
  }
  pre {
    background: ${({ theme }) => theme.colors.bgMuted};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    padding: ${({ theme }) => theme.space.sm};
    overflow-x: auto;
    margin: ${({ theme }) => theme.space.sm} 0;
  }
  pre code {
    background: transparent;
    border: none;
    padding: 0;
  }
  blockquote {
    margin: ${({ theme }) => theme.space.sm} 0;
    padding-left: ${({ theme }) => theme.space.md};
    border-left: 3px solid ${({ theme }) => theme.colors.border};
    color: ${({ theme }) => theme.colors.textMuted};
  }
  table {
    border-collapse: collapse;
    margin: ${({ theme }) => theme.space.sm} 0;
  }
  th,
  td {
    border: 1px solid ${({ theme }) => theme.colors.border};
    padding: 4px 8px;
    text-align: left;
  }
`;

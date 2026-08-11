"use client";

// Whose words these are, as a mark rather than a sentence. It sits beside a
// piece of writing that has two possible authors and answers only that — it
// never says anything about state, which is the neighbouring question and gets
// the accent colour.
//
// Both marks are the app's existing identity: the H from the product icon, and
// the viewer's own avatar-or-initial, the same pair the top bar renders. A
// glyph set invented for this one page would be a third vocabulary to learn.

import styled from "styled-components";

import { useChatStore } from "@/lib/chatStore";

const Mark = styled.span<{ $hank: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  overflow: hidden;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1;
  color: ${({ theme }) => theme.colors.bg};
  background: ${({ theme, $hank }) =>
    $hank ? theme.colors.accent : theme.colors.textSubtle};

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

export function AuthorMark({ author }: { author: "hank" | "user" }) {
  const viewer = useChatStore((s) => s.viewer);
  const hank = author === "hank";
  const title = hank
    ? "Hank drafted this — change anything that doesn't sound like you"
    : "Your words";
  return (
    <Mark $hank={hank} title={title} aria-label={title}>
      {hank ? (
        "H"
      ) : viewer?.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={viewer.image} alt="" />
      ) : (
        (viewer?.initial ?? "•")
      )}
    </Mark>
  );
}

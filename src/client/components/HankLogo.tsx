"use client";

import styled from "styled-components";

import type { CSSProperties } from "react";

// Drop-shadow scales with logo size (offsets/blurs are CSS vars set from
// `size`), so a 20px corner icon gets a small soft glow and a 64px hero gets
// the full 3D pop. Dark mode swaps in a stronger dark shadow + brighter
// brand-purple glow so the depth still reads against the near-black bg.
const StyledSvg = styled.svg`
  display: block;
  filter: drop-shadow(
      0 var(--hank-sharp-y) var(--hank-sharp-blur) rgba(0, 0, 0, 0.22)
    )
    drop-shadow(
      0 var(--hank-glow-y) var(--hank-glow-blur) rgba(139, 83, 245, 0.38)
    );

  html[data-theme="dark"] & {
    filter: drop-shadow(
        0 var(--hank-sharp-y) var(--hank-sharp-blur) rgba(0, 0, 0, 0.55)
      )
      drop-shadow(
        0 var(--hank-glow-y) var(--hank-glow-blur) rgba(161, 109, 255, 0.55)
      );
  }
`;

export function HankLogo({ size = 20 }: { size?: number }) {
  const sharpY = Math.max(1, Math.round(size * 0.06));
  const sharpBlur = Math.max(2, Math.round(size * 0.12));
  const glowY = Math.max(2, Math.round(size * 0.18));
  const glowBlur = Math.max(4, Math.round(size * 0.42));

  const cssVars: CSSProperties = {
    "--hank-sharp-y": `${sharpY}px`,
    "--hank-sharp-blur": `${sharpBlur}px`,
    "--hank-glow-y": `${glowY}px`,
    "--hank-glow-blur": `${glowBlur}px`,
  } as CSSProperties;

  return (
    <StyledSvg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      style={cssVars}
      aria-hidden
    >
      <defs>
        <linearGradient id="hank-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c4a3ff" />
          <stop offset="100%" stopColor="#7c4dff" />
        </linearGradient>
        <linearGradient id="hank-border" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0e3ff" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#a16dff" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#2d0f6b" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="hank-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill="url(#hank-bg)"
        stroke="url(#hank-border)"
        strokeWidth="1"
      />
      <rect x="2" y="2" width="28" height="13" rx="5" fill="url(#hank-gloss)" />
      <path
        d="M9 8 V24 M9 16 H23 M23 8 V24"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
    </StyledSvg>
  );
}

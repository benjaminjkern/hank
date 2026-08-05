"use client";

import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";

import { HankLogo } from "@/components/HankLogo";
import { useChatStore } from "@/lib/chatStore";

const HOP_HANK_ANIMATIONS = [
  "hop",
  "spin",
  "wiggle",
  "squish",
  "moonwalk",
  "backflip",
  "pogo",
  "cartwheel",
  "shimmy",
  "tada",
] as const;
type HopHankAnim = (typeof HOP_HANK_ANIMATIONS)[number];

// Above TopBar (z-index 1001) and ApiKeyBlockerModal backdrop (1000) so the
// loading screen hides every other surface while the chat store hydrates.
// Width/height in vw/vh on top of `inset: 0` so we don't depend on a parent
// height chain — the overlay sits as a direct child of <body> and just owns
// the viewport.
const Overlay = styled.div`
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
`;

const Dancer = styled.div<{ $anim: HopHankAnim }>`
  transform-origin: 50% 100%;
  animation-name: ${({ $anim }) => `hank_big_${$anim}`};
  animation-duration: 1.1s;
  animation-timing-function: cubic-bezier(0.5, 0, 0.5, 1);
  animation-iteration-count: 1;
  animation-fill-mode: both;

  @keyframes hank_big_hop {
    0% {
      transform: translateY(0) rotate(0deg);
    }
    25% {
      transform: translateY(-22px) rotate(-14deg);
    }
    50% {
      transform: translateY(0) rotate(0deg);
    }
    65% {
      transform: translateY(4px) scaleY(0.85) scaleX(1.12);
    }
    80% {
      transform: translateY(-12px) rotate(12deg);
    }
    100% {
      transform: translateY(0) rotate(0deg);
    }
  }
  @keyframes hank_big_spin {
    0% {
      transform: translateY(0) rotate(0deg);
    }
    15% {
      transform: translateY(8px) scale(1.12, 0.82) rotate(0deg);
    }
    30% {
      transform: translateY(-28px) rotate(180deg);
    }
    50% {
      transform: translateY(-40px) rotate(360deg);
    }
    70% {
      transform: translateY(-28px) rotate(540deg);
    }
    85% {
      transform: translateY(8px) scale(1.12, 0.82) rotate(720deg);
    }
    100% {
      transform: translateY(0) rotate(720deg);
    }
  }
  @keyframes hank_big_wiggle {
    0%,
    100% {
      transform: translateX(0) rotate(0deg);
    }
    15% {
      transform: translateX(-10px) rotate(-12deg);
    }
    35% {
      transform: translateX(10px) rotate(12deg);
    }
    55% {
      transform: translateX(-8px) rotate(-10deg);
    }
    75% {
      transform: translateX(8px) rotate(10deg);
    }
  }
  @keyframes hank_big_squish {
    0%,
    100% {
      transform: scale(1, 1);
    }
    20% {
      transform: translateY(8px) scale(1.25, 0.7);
    }
    45% {
      transform: translateY(-16px) scale(0.9, 1.18);
    }
    70% {
      transform: translateY(8px) scale(1.2, 0.8);
    }
  }
  @keyframes hank_big_moonwalk {
    0% {
      transform: translateX(0) rotate(0deg);
    }
    30% {
      transform: translateX(-18px) rotate(-6deg);
    }
    50% {
      transform: translateY(-8px) translateX(-8px) rotate(0deg);
    }
    70% {
      transform: translateX(14px) rotate(6deg);
    }
    100% {
      transform: translateX(0) rotate(0deg);
    }
  }
  @keyframes hank_big_backflip {
    0% {
      transform: translateY(0) rotate(0deg);
    }
    15% {
      transform: translateY(10px) scale(1.1, 0.85) rotate(0deg);
    }
    35% {
      transform: translateY(-32px) rotate(-120deg);
    }
    55% {
      transform: translateY(-44px) rotate(-240deg);
    }
    80% {
      transform: translateY(10px) scale(1.1, 0.85) rotate(-360deg);
    }
    100% {
      transform: translateY(0) rotate(-360deg);
    }
  }
  @keyframes hank_big_pogo {
    0%,
    100% {
      transform: translateY(0) scale(1);
    }
    10% {
      transform: translateY(8px) scale(1.15, 0.8);
    }
    22% {
      transform: translateY(-20px) scale(0.92, 1.1);
    }
    36% {
      transform: translateY(8px) scale(1.15, 0.8);
    }
    48% {
      transform: translateY(-32px) scale(0.9, 1.15);
    }
    62% {
      transform: translateY(8px) scale(1.15, 0.8);
    }
    74% {
      transform: translateY(-16px) scale(0.95, 1.08);
    }
    88% {
      transform: translateY(8px) scale(1.1, 0.85);
    }
  }
  @keyframes hank_big_cartwheel {
    0% {
      transform: translateX(0) rotate(0deg);
    }
    25% {
      transform: translateY(-28px) translateX(-24px) rotate(-180deg);
    }
    50% {
      transform: translateX(0) rotate(-360deg);
    }
    75% {
      transform: translateY(-28px) translateX(24px) rotate(-540deg);
    }
    100% {
      transform: translateX(0) rotate(-720deg);
    }
  }
  @keyframes hank_big_shimmy {
    0%,
    100% {
      transform: translateX(0) rotate(0deg);
    }
    8% {
      transform: translateX(-6px) rotate(-5deg);
    }
    16% {
      transform: translateX(6px) rotate(5deg);
    }
    24% {
      transform: translateX(-6px) rotate(-5deg);
    }
    32% {
      transform: translateX(6px) rotate(5deg);
    }
    44% {
      transform: translateY(-4px) translateX(-4px) scale(1.06) rotate(0deg);
    }
    56% {
      transform: translateX(6px) rotate(-5deg);
    }
    64% {
      transform: translateX(-6px) rotate(5deg);
    }
    72% {
      transform: translateX(6px) rotate(-5deg);
    }
    84% {
      transform: translateX(-6px) rotate(5deg);
    }
    92% {
      transform: translateX(4px) rotate(-3deg);
    }
  }
  @keyframes hank_big_tada {
    0% {
      transform: scale(1) rotate(0deg);
    }
    12% {
      transform: translateY(16px) scale(1.2, 0.7) rotate(-10deg);
    }
    28% {
      transform: translateY(16px) scale(1.2, 0.7) rotate(-14deg);
    }
    44% {
      transform: translateY(-48px) scale(1.18) rotate(220deg);
    }
    62% {
      transform: translateY(-28px) scale(1.08) rotate(360deg);
    }
    82% {
      transform: translateY(8px) scale(1.06, 0.92) rotate(360deg);
    }
    100% {
      transform: scale(1) rotate(360deg);
    }
  }
`;

export function LoadingOverlay() {
  const hydrated = useChatStore((s) => s.hydrated);
  // Start with a fixed move so SSR + first client render agree, then
  // randomize on mount. Hydration mismatch on a `Math.random()` initial
  // pick would flash a React warning + a brief style swap.
  const [animIndex, setAnimIndex] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setAnimIndex(Math.floor(Math.random() * HOP_HANK_ANIMATIONS.length));
  }, []);

  const pickNext = useCallback(() => {
    setAnimIndex((prev) => {
      let next = prev;
      while (next === prev) {
        next = Math.floor(Math.random() * HOP_HANK_ANIMATIONS.length);
      }
      return next;
    });
    setTick((t) => t + 1);
  }, []);

  if (hydrated) return null;

  return (
    <Overlay>
      <Dancer
        key={tick}
        aria-hidden
        $anim={HOP_HANK_ANIMATIONS[animIndex]}
        onAnimationEnd={pickNext}
      >
        <HankLogo size={160} />
      </Dancer>
    </Overlay>
  );
}

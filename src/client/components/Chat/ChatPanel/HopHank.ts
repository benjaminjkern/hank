import styled from "styled-components";

// Dance card — five distinctive keyframe loops that the HopHank picks from
// randomly. `iteration-count: 1` so each move plays once and fires
// `animationend`, where the component picks a *different* move (never the
// same back-to-back) and a `repeat${n}` key forces a fresh animation cycle
// even if the random landed on the same name two picks apart.
export const HOP_HANK_ANIMATIONS = [
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
export type HopHankAnim = (typeof HOP_HANK_ANIMATIONS)[number];

export const HopHank = styled.div<{ $anim: HopHankAnim }>`
  position: absolute;
  left: 14px;
  top: 50%;
  pointer-events: none;
  transform-origin: 50% 100%;
  animation-name: ${({ $anim }) => `hank_${$anim}`};
  animation-duration: 1.1s;
  animation-timing-function: cubic-bezier(0.5, 0, 0.5, 1);
  animation-iteration-count: 1;
  animation-fill-mode: both;

  @keyframes hank_hop {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    25% {
      transform: translateY(calc(-50% - 10px)) rotate(-14deg);
    }
    50% {
      transform: translateY(-50%) rotate(0deg);
    }
    65% {
      transform: translateY(-46%) scaleY(0.85) scaleX(1.12);
    }
    80% {
      transform: translateY(calc(-50% - 6px)) rotate(12deg);
    }
    100% {
      transform: translateY(-50%) rotate(0deg);
    }
  }
  /* Anticipation crouch → big jump with two full spins mid-air → squash landing. */
  @keyframes hank_spin {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    15% {
      transform: translateY(-44%) scale(1.12, 0.82) rotate(0deg);
    }
    30% {
      transform: translateY(calc(-50% - 14px)) rotate(180deg);
    }
    50% {
      transform: translateY(calc(-50% - 20px)) rotate(360deg);
    }
    70% {
      transform: translateY(calc(-50% - 14px)) rotate(540deg);
    }
    85% {
      transform: translateY(-44%) scale(1.12, 0.82) rotate(720deg);
    }
    100% {
      transform: translateY(-50%) rotate(720deg);
    }
  }
  @keyframes hank_wiggle {
    0%,
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    15% {
      transform: translateY(-50%) translateX(-5px) rotate(-12deg);
    }
    35% {
      transform: translateY(-50%) translateX(5px) rotate(12deg);
    }
    55% {
      transform: translateY(-50%) translateX(-4px) rotate(-10deg);
    }
    75% {
      transform: translateY(-50%) translateX(4px) rotate(10deg);
    }
  }
  @keyframes hank_squish {
    0%,
    100% {
      transform: translateY(-50%) scale(1, 1);
    }
    20% {
      transform: translateY(-44%) scale(1.25, 0.7);
    }
    45% {
      transform: translateY(calc(-50% - 8px)) scale(0.9, 1.18);
    }
    70% {
      transform: translateY(-44%) scale(1.2, 0.8);
    }
  }
  @keyframes hank_moonwalk {
    0% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    30% {
      transform: translateY(-50%) translateX(-9px) rotate(-6deg);
    }
    50% {
      transform: translateY(calc(-50% - 4px)) translateX(-4px) rotate(0deg);
    }
    70% {
      transform: translateY(-50%) translateX(7px) rotate(6deg);
    }
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
  }
  /* Backward somersault — leans back into the jump, full negative rotation. */
  @keyframes hank_backflip {
    0% {
      transform: translateY(-50%) rotate(0deg);
    }
    15% {
      transform: translateY(-44%) scale(1.1, 0.85) rotate(0deg);
    }
    35% {
      transform: translateY(calc(-50% - 16px)) rotate(-120deg);
    }
    55% {
      transform: translateY(calc(-50% - 22px)) rotate(-240deg);
    }
    80% {
      transform: translateY(-44%) scale(1.1, 0.85) rotate(-360deg);
    }
    100% {
      transform: translateY(-50%) rotate(-360deg);
    }
  }
  /* Rapid double-bounce — playground pogo stick. */
  @keyframes hank_pogo {
    0%,
    100% {
      transform: translateY(-50%) scale(1);
    }
    10% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    22% {
      transform: translateY(calc(-50% - 10px)) scale(0.92, 1.1);
    }
    36% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    48% {
      transform: translateY(calc(-50% - 16px)) scale(0.9, 1.15);
    }
    62% {
      transform: translateY(-44%) scale(1.15, 0.8);
    }
    74% {
      transform: translateY(calc(-50% - 8px)) scale(0.95, 1.08);
    }
    88% {
      transform: translateY(-44%) scale(1.1, 0.85);
    }
  }
  /* Side-to-side wheel motion — arcs over the top going one way, back the other. */
  @keyframes hank_cartwheel {
    0% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    25% {
      transform: translateY(calc(-50% - 14px)) translateX(-12px) rotate(-180deg);
    }
    50% {
      transform: translateY(-50%) translateX(0) rotate(-360deg);
    }
    75% {
      transform: translateY(calc(-50% - 14px)) translateX(12px) rotate(-540deg);
    }
    100% {
      transform: translateY(-50%) translateX(0) rotate(-720deg);
    }
  }
  /* High-frequency micro-shake. Fast and jittery, no big displacement. */
  @keyframes hank_shimmy {
    0%,
    100% {
      transform: translateY(-50%) translateX(0) rotate(0deg);
    }
    8% {
      transform: translateY(-50%) translateX(-3px) rotate(-5deg);
    }
    16% {
      transform: translateY(-50%) translateX(3px) rotate(5deg);
    }
    24% {
      transform: translateY(-50%) translateX(-3px) rotate(-5deg);
    }
    32% {
      transform: translateY(-50%) translateX(3px) rotate(5deg);
    }
    44% {
      transform: translateY(-48%) translateX(-2px) scale(1.06) rotate(0deg);
    }
    56% {
      transform: translateY(-50%) translateX(3px) rotate(-5deg);
    }
    64% {
      transform: translateY(-50%) translateX(-3px) rotate(5deg);
    }
    72% {
      transform: translateY(-50%) translateX(3px) rotate(-5deg);
    }
    84% {
      transform: translateY(-50%) translateX(-3px) rotate(5deg);
    }
    92% {
      transform: translateY(-50%) translateX(2px) rotate(-3deg);
    }
  }
  /* Anticipation lean, then a huge tilted pop with a full rotation. */
  @keyframes hank_tada {
    0% {
      transform: translateY(-50%) scale(1) rotate(0deg);
    }
    12% {
      transform: translateY(-42%) scale(1.2, 0.7) rotate(-10deg);
    }
    28% {
      transform: translateY(-42%) scale(1.2, 0.7) rotate(-14deg);
    }
    44% {
      transform: translateY(calc(-50% - 24px)) scale(1.18) rotate(220deg);
    }
    62% {
      transform: translateY(calc(-50% - 14px)) scale(1.08) rotate(360deg);
    }
    82% {
      transform: translateY(-44%) scale(1.06, 0.92) rotate(360deg);
    }
    100% {
      transform: translateY(-50%) scale(1) rotate(360deg);
    }
  }
`;

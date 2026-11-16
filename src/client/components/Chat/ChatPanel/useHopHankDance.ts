import { useState } from "react";

import { HOP_HANK_ANIMATIONS } from "./HopHank";

export function useHopHankDance() {
  // Random dance-move state for the hopping HankLogo overlay. `animTick` is
  // bumped on each animationend to force a fresh DOM element (via React key)
  // so the next animation restarts cleanly even if Math.random picked the
  // same move two cycles apart. `animIndex` is the move itself, never equal
  // to the previous pick (see pickNextAnim).
  const [animIndex, setAnimIndex] = useState(0);
  const [animTick, setAnimTick] = useState(0);

  function pickNextAnim() {
    setAnimIndex((prev) => {
      let next = Math.floor(Math.random() * (HOP_HANK_ANIMATIONS.length - 1));
      if (next >= prev) next += 1;
      return next;
    });
    setAnimTick((t) => t + 1);
  }

  return { animIndex, animTick, pickNextAnim };
}

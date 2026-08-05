"use client";

import { World, Vec2, Box, Polygon, MouseJoint, AABB, type Body } from "planck";
import { useEffect, useRef, type RefObject } from "react";
import styled from "styled-components";

import { nowPerfMs } from "@/utils/now";
import { randRange } from "@/utils/random";

const Canvas = styled.canvas`
  position: fixed;
  inset: 0;
  z-index: 0;
  touch-action: none;
`;

// iPhones report devicePixelRatio = 3, which combined with a fullscreen canvas
// pushes mobile Safari toward silent backing-buffer downsampling. Capping at 2
// keeps the buffer small enough that the browser actually honors it.
const MAX_DPR = 2;

const SCALE = 30; // pixels per meter
const MIN_SIZE_PX = 28;
const MAX_SIZE_PX = MIN_SIZE_PX * 5;
const CORNER_RATIO = 6 / 28;
const GRAVITY_MPS2 = 60;
const MAX_BODIES = 1000;
const SPAWN_INTERVAL_MS = 1100;
const STUCK_STREAK_TRIGGER = 3;
const CARD_CORNER_RADIUS_PX = 12;
const NARROW_BREAKPOINT_PX = 900;
const FIXED_DT = 1 / 60;
const MAX_ACC_S = 0.25;
const VELOCITY_ITER = 8;
const POSITION_ITER = 3;
const BLOCK_DENSITY = 1.0;
const BLOCK_FRICTION = 0.55;
const BLOCK_RESTITUTION = 0.18;
const STATIC_FRICTION = 0.55;

type BlockMeta = { size: number; reachedScreen: boolean };

function toM(p: number): number {
  return p / SCALE;
}
function toPx(m: number): number {
  return m * SCALE;
}
function roundedRectVerts(
  widthPx: number,
  heightPx: number,
  radiusPx: number,
): Vec2[] {
  const halfW = widthPx / 2;
  const halfH = heightPx / 2;
  const r = Math.min(radiusPx, halfW, halfH);
  const corners = [
    { cx: halfW - r, cy: -halfH + r, start: -Math.PI / 2, end: 0 },
    { cx: halfW - r, cy: halfH - r, start: 0, end: Math.PI / 2 },
    { cx: -halfW + r, cy: halfH - r, start: Math.PI / 2, end: Math.PI },
    { cx: -halfW + r, cy: -halfH + r, start: Math.PI, end: Math.PI * 1.5 },
  ];
  const verts: Vec2[] = [];
  for (const c of corners) {
    for (let i = 0; i <= 2; i++) {
      const t = i / 2;
      const a = c.start + (c.end - c.start) * t;
      verts.push(
        Vec2(toM(c.cx + Math.cos(a) * r), toM(c.cy + Math.sin(a) * r)),
      );
    }
  }
  return verts;
}

function roundedSquareVerts(sizePx: number): Vec2[] {
  return roundedRectVerts(sizePx, sizePx, sizePx * CORNER_RATIO);
}

function traceRoundedSquare(
  ctx: CanvasRenderingContext2D,
  half: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(-half + r, -half);
  ctx.lineTo(half - r, -half);
  ctx.quadraticCurveTo(half, -half, half, -half + r);
  ctx.lineTo(half, half - r);
  ctx.quadraticCurveTo(half, half, half - r, half);
  ctx.lineTo(-half + r, half);
  ctx.quadraticCurveTo(-half, half, -half, half - r);
  ctx.lineTo(-half, -half + r);
  ctx.quadraticCurveTo(-half, -half, -half + r, -half);
  ctx.closePath();
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const half = size / 2;
  const r = size * CORNER_RATIO;

  // World-vertical direction expressed in this block's rotated local frame.
  // After ctx.rotate(angle), local (sin a, cos a) maps to world (0, 1) — so
  // gradients drawn between ±(gx, gy) stay aligned with screen-down regardless
  // of the block's rotation, simulating a fixed overhead light source.
  const gx = Math.sin(angle) * half;
  const gy = Math.cos(angle) * half;

  traceRoundedSquare(ctx, half, r);
  const bgGrad = ctx.createLinearGradient(-gx, -gy, gx, gy);
  bgGrad.addColorStop(0, "#c4a3ff");
  bgGrad.addColorStop(1, "#7c4dff");
  ctx.fillStyle = bgGrad;
  ctx.fill();

  ctx.save();
  traceRoundedSquare(ctx, half, r);
  ctx.clip();
  const glossGrad = ctx.createLinearGradient(-gx, -gy, gx, gy);
  glossGrad.addColorStop(0, "rgba(255, 255, 255, 0.32)");
  glossGrad.addColorStop(0.5, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glossGrad;
  ctx.fillRect(-size, -size, size * 2, size * 2);
  // Inset stroke: clip to the path, then stroke at 2x width so only the inner
  // half is visible. Keeps the border fully inside the physics-collision box.
  traceRoundedSquare(ctx, half, r);
  const borderGrad = ctx.createLinearGradient(-gx, -gy, gx, gy);
  borderGrad.addColorStop(0, "rgba(240, 227, 255, 0.95)");
  borderGrad.addColorStop(0.55, "rgba(161, 109, 255, 0.15)");
  borderGrad.addColorStop(1, "rgba(45, 15, 107, 0.9)");
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth = Math.max(2, size * 0.07);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1.6, size * 0.09);
  ctx.lineCap = "round";
  const armX = size * 0.28;
  const armY = size * 0.3;
  ctx.beginPath();
  ctx.moveTo(-armX, -armY);
  ctx.lineTo(-armX, armY);
  ctx.moveTo(-armX, 0);
  ctx.lineTo(armX, 0);
  ctx.moveTo(armX, -armY);
  ctx.lineTo(armX, armY);
  ctx.stroke();
  ctx.restore();
}

export function HankRain({
  cardRef,
  groundDisabled = false,
  onCapReached,
}: {
  cardRef: RefObject<HTMLElement | null>;
  groundDisabled?: boolean;
  onCapReached?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groundDisabledRef = useRef(groundDisabled);
  const onCapReachedRef = useRef(onCapReached);

  useEffect(() => {
    groundDisabledRef.current = groundDisabled;
  }, [groundDisabled]);
  useEffect(() => {
    onCapReachedRef.current = onCapReached;
  }, [onCapReached]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const world = new World({ gravity: Vec2(0, GRAVITY_MPS2) });

    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = window.devicePixelRatio || 1;

    const blocks: Body[] = [];

    const groundBody = world.createBody({
      type: "static",
      position: Vec2(toM(width / 2), toM(height + 500)),
    });
    groundBody.createFixture(new Box(toM(10000), toM(500)), {
      friction: STATIC_FRICTION,
    });

    // Dedicated, always-active anchor for the drag MouseJoint. The joint's
    // first body is just a fixed reference point — never moved, needs no
    // fixtures — but planck drops a joint from the solver if either of its
    // bodies is deactivated. Anchoring to groundBody (which the chute
    // deactivates) silently killed dragging while the chute was open; a
    // separate body keeps drag working regardless of chute state.
    const anchorBody = world.createBody({ type: "static" });

    const leftWall = world.createBody({
      type: "static",
      position: Vec2(toM(-500), toM(height / 2)),
    });
    leftWall.createFixture(new Box(toM(500), toM(10000)), {
      friction: STATIC_FRICTION,
    });

    const rightWall = world.createBody({
      type: "static",
      position: Vec2(toM(width + 500), toM(height / 2)),
    });
    rightWall.createFixture(new Box(toM(500), toM(10000)), {
      friction: STATIC_FRICTION,
    });

    const cardBody = world.createBody({
      type: "kinematic",
      position: Vec2(-1e6, -1e6),
    });
    let cardFixture = cardBody.createFixture(
      new Polygon(roundedRectVerts(2, 2, CARD_CORNER_RADIUS_PX)),
      { friction: STATIC_FRICTION },
    );
    let cardHx = 1;
    let cardHy = 1;

    let cardDisabled = false;
    const cardMql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX}px)`);
    const updateCardDisabled = () => {
      cardDisabled = cardMql.matches;
      if (cardDisabled) {
        cardBody.setTransform(Vec2(-1e6, -1e6), 0);
      }
    };
    updateCardDisabled();
    cardMql.addEventListener("change", updateCardDisabled);

    // Drag-grab: pointerdown picks a body and attaches a MouseJoint that
    // tracks the pointer; pointerup destroys the joint. Single active drag
    // — the joint follows whichever pointerId started it.
    let dragJoint: MouseJoint | null = null;
    let dragBody: Body | null = null;
    let dragPointerId: number | null = null;

    const findBodyAtPoint = (worldPt: Vec2): Body | null => {
      const eps = 0.001;
      const aabb = new AABB(
        Vec2(worldPt.x - eps, worldPt.y - eps),
        Vec2(worldPt.x + eps, worldPt.y + eps),
      );
      let found: Body | null = null;
      world.queryAABB(aabb, (fixture) => {
        const b = fixture.getBody();
        if (!b.isDynamic()) return true;
        if (!fixture.testPoint(worldPt)) return true;
        found = b;
        return false;
      });
      return found;
    };

    const updateCursor = (
      worldPt: Vec2 | null,
      pointerType: string,
      target: EventTarget | null,
    ) => {
      if (pointerType !== "mouse") return;
      if (dragJoint) {
        canvas.style.cursor = "grabbing";
        return;
      }
      // Only style the canvas cursor when the pointer is actually over the
      // canvas (not over the Card or chute button on top of it).
      if (target !== canvas) {
        canvas.style.cursor = "";
        return;
      }
      const over = worldPt ? findBodyAtPoint(worldPt) : null;
      canvas.style.cursor = over ? "grab" : "";
    };

    const releaseDrag = () => {
      if (!dragJoint) return;
      world.destroyJoint(dragJoint);
      dragJoint = null;
      dragBody = null;
      if (dragPointerId !== null) {
        try {
          canvas.releasePointerCapture(dragPointerId);
        } catch {
          // capture already released
        }
        dragPointerId = null;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (dragJoint) return;
      const worldPt = Vec2(toM(e.clientX), toM(e.clientY));
      const body = findBodyAtPoint(worldPt);
      if (!body) return;
      // Very large maxForce + stiff frequency so the dragged block can push
      // through any pile of other blocks to follow the cursor. Critical damping
      // keeps it from oscillating around the target.
      const joint = new MouseJoint(
        {
          maxForce: 1e9,
          frequencyHz: 30,
          dampingRatio: 1.0,
        },
        anchorBody,
        body,
        worldPt,
      );
      world.createJoint(joint);
      body.setAwake(true);
      dragJoint = joint;
      dragBody = body;
      dragPointerId = e.pointerId;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture not supported / already captured
      }
      updateCursor(worldPt, e.pointerType, e.target);
    };

    const isOutOfViewport = (clientX: number, clientY: number) =>
      clientX < 0 ||
      clientY < 0 ||
      clientX > window.innerWidth ||
      clientY > window.innerHeight;

    const onPointerMove = (e: PointerEvent) => {
      const worldPt = Vec2(toM(e.clientX), toM(e.clientY));
      if (dragJoint && e.pointerId === dragPointerId) {
        if (isOutOfViewport(e.clientX, e.clientY)) {
          releaseDrag();
        } else {
          dragJoint.setTarget(worldPt);
        }
      }
      updateCursor(worldPt, e.pointerType, e.target);
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId === dragPointerId) releaseDrag();
      const worldPt = Vec2(toM(e.clientX), toM(e.clientY));
      updateCursor(worldPt, e.pointerType, e.target);
    };

    const onWindowBlur = () => releaseDrag();

    canvas.addEventListener("pointerdown", onPointerDown);
    // Listen on window so a pointerup over the Card / form buttons still
    // releases the drag. setPointerCapture should redirect events to canvas,
    // but isn't reliable when the pointer is over an interactive sibling.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onWindowBlur);

    // Device orientation → gravity direction. Tilt the phone, blocks fall the
    // way the world actually pulls. iOS 13+ requires a user-gesture permission
    // prompt; non-iOS just opts in.
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      const betaRad = (e.beta * Math.PI) / 180;
      const gammaRad = (e.gamma * Math.PI) / 180;
      let gx = Math.sin(gammaRad);
      let gy = Math.sin(betaRad);
      const angle = window.screen?.orientation?.angle ?? 0;
      if (angle === 90) {
        const t = gx;
        gx = gy;
        gy = -t;
      } else if (angle === 270 || angle === -90) {
        const t = gx;
        gx = -gy;
        gy = t;
      } else if (angle === 180) {
        gx = -gx;
        gy = -gy;
      }
      const mag = Math.hypot(gx, gy);
      if (mag > 1) {
        gx /= mag;
        gy /= mag;
      }
      world.setGravity(Vec2(gx * GRAVITY_MPS2, gy * GRAVITY_MPS2));
    };

    let orientationAttached = false;
    const orientationApi = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const enableOrientation = async () => {
      if (orientationAttached) return;
      if (typeof orientationApi?.requestPermission === "function") {
        try {
          const result = await orientationApi.requestPermission();
          if (result !== "granted") return;
        } catch {
          return;
        }
      } else if (!("DeviceOrientationEvent" in window)) {
        return;
      }
      window.addEventListener("deviceorientation", onOrientation);
      orientationAttached = true;
    };

    // iOS 13+ requires requestPermission() to be called synchronously from a
    // trusted user-activation event. WebKit only counts `click` and `touchend`
    // as activation — `pointerdown` and `touchstart` fire BEFORE the gesture
    // commits and are silently rejected (the prompt never appears, the promise
    // resolves to "denied" without UI). Listen on document so any tap on the
    // page (canvas, Card, button) counts. As of iOS 17.4+ there's no global
    // "Motion & Orientation Access" toggle in Settings — the in-page prompt
    // is the only path to grant.
    let removeFirstGesture: (() => void) | null = null;
    if (typeof orientationApi?.requestPermission === "function") {
      const onFirstGesture = () => {
        void enableOrientation();
        removeFirstGesture?.();
      };
      document.addEventListener("click", onFirstGesture, { once: true });
      document.addEventListener("touchend", onFirstGesture, { once: true });
      removeFirstGesture = () => {
        document.removeEventListener("click", onFirstGesture);
        document.removeEventListener("touchend", onFirstGesture);
        removeFirstGesture = null;
      };
    } else {
      void enableOrientation();
    }

    // Pull the canvas's actual rendered size from the layout, not from
    // window.innerWidth/innerHeight. On iOS the viewport "settles" after the
    // URL-bar / safe-area animations and innerWidth/innerHeight read pre-settle
    // on mount — sizing the backing store from those gives a too-small buffer
    // that looks pixelated until a real resize event fires. ResizeObserver
    // fires after every layout pass including the settle, so the backing
    // store always matches the final rendered size.
    const resize = (cssW: number, cssH: number) => {
      width = cssW;
      height = cssH;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      groundBody.setTransform(Vec2(toM(width / 2), toM(height + 500)), 0);
      leftWall.setTransform(Vec2(toM(-500), toM(height / 2)), 0);
      rightWall.setTransform(Vec2(toM(width + 500), toM(height / 2)), 0);
    };
    resize(window.innerWidth, window.innerHeight);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      if (rect.width === 0 || rect.height === 0) return;
      resize(rect.width, rect.height);
    });
    ro.observe(canvas);
    const onVvResize = () => {
      const vv = window.visualViewport;
      if (vv) resize(vv.width, vv.height);
    };
    window.visualViewport?.addEventListener("resize", onVvResize);

    // iOS Safari allocates the initial canvas compositing layer at a lower
    // resolution than DPR implies and won't rebuild it from a programmatic
    // canvas.width / setTransform — only from a real orientation change. So
    // we fake one: briefly toggle display so the next layout pass tears down
    // the layer, then resize again into a freshly-allocated one.
    const compositorFixTimeout = setTimeout(() => {
      canvas.style.display = "none";
      void canvas.offsetHeight;
      canvas.style.display = "";
      resize(window.innerWidth, window.innerHeight);
    }, 250);

    let prevSpawnMeta: BlockMeta | null = null;
    let stuckStreak = 0;

    const spawn = () => {
      if (prevSpawnMeta) {
        if (!prevSpawnMeta.reachedScreen) {
          stuckStreak++;
          if (stuckStreak >= STUCK_STREAK_TRIGGER) {
            onCapReachedRef.current?.();
            stuckStreak = 0;
          }
        } else {
          stuckStreak = 0;
        }
      }

      const size = randRange(MIN_SIZE_PX, MAX_SIZE_PX);
      const halfSize = size / 2;
      const margin = halfSize + 4;
      const xPx = randRange(margin, Math.max(margin + 1, width - margin));
      const yPx = -halfSize - randRange(100, 200);
      const body = world.createBody({
        type: "dynamic",
        position: Vec2(toM(xPx), toM(yPx)),
        angle: randRange(0, Math.PI * 2),
        linearVelocity: Vec2(randRange(-2, 2), randRange(1.5, 3)),
        angularVelocity: randRange(-2, 2),
        linearDamping: 0.1,
        angularDamping: 0.15,
        allowSleep: true,
      });
      body.createFixture(new Polygon(roundedSquareVerts(size)), {
        density: BLOCK_DENSITY,
        friction: BLOCK_FRICTION,
        restitution: BLOCK_RESTITUTION,
      });
      const meta: BlockMeta = { size, reachedScreen: false };
      body.setUserData(meta);
      blocks.push(body);
      prevSpawnMeta = meta;
    };

    let groundActive = true;
    const setGroundActive = (active: boolean) => {
      if (active === groundActive) return;
      groundActive = active;
      groundBody.setActive(active);
    };

    let lastSpawn = nowPerfMs();
    let lastFrame = nowPerfMs();
    let accumulator = 0;
    let raf = 0;

    const tick = (now: number) => {
      const frameDt = Math.min((now - lastFrame) / 1000, MAX_ACC_S);
      lastFrame = now;

      setGroundActive(!groundDisabledRef.current);

      const cardEl = cardRef.current;
      if (cardEl && !cardDisabled) {
        const rect = cardEl.getBoundingClientRect();
        const newHx = rect.width / 2;
        const newHy = rect.height / 2;
        if (Math.abs(newHx - cardHx) > 0.5 || Math.abs(newHy - cardHy) > 0.5) {
          cardBody.destroyFixture(cardFixture);
          cardFixture = cardBody.createFixture(
            new Polygon(
              roundedRectVerts(rect.width, rect.height, CARD_CORNER_RADIUS_PX),
            ),
            { friction: STATIC_FRICTION },
          );
          cardHx = newHx;
          cardHy = newHy;
        }
        cardBody.setTransform(
          Vec2(toM(rect.left + newHx), toM(rect.top + newHy)),
          0,
        );
      }

      if (
        !groundDisabledRef.current &&
        now - lastSpawn > SPAWN_INTERVAL_MS &&
        blocks.length < MAX_BODIES
      ) {
        lastSpawn = now;
        spawn();
      }

      if (blocks.length >= MAX_BODIES && !groundDisabledRef.current) {
        onCapReachedRef.current?.();
      }

      accumulator += frameDt;
      while (accumulator >= FIXED_DT) {
        world.step(FIXED_DT, VELOCITY_ITER, POSITION_ITER);
        accumulator -= FIXED_DT;
      }

      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        const pos = b.getPosition();
        const xPx = toPx(pos.x);
        const yPx = toPx(pos.y);
        const meta = b.getUserData() as BlockMeta | null;
        const offScreen =
          yPx > height + 2000 ||
          xPx < -2000 ||
          xPx > width + 2000 ||
          (meta?.reachedScreen === true && yPx < -2000);
        if (offScreen) {
          if (dragBody === b) releaseDrag();
          world.destroyBody(b);
          blocks.splice(i, 1);
        }
      }

      ctx.clearRect(0, 0, width, height);
      for (const b of blocks) {
        const meta = b.getUserData() as BlockMeta | null;
        if (!meta) continue;
        const pos = b.getPosition();
        const xPx = toPx(pos.x);
        const yPx = toPx(pos.y);
        if (!meta.reachedScreen && yPx + meta.size / 2 > 0) {
          meta.reachedScreen = true;
        }
        drawBlock(ctx, xPx, yPx, b.getAngle(), meta.size);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(compositorFixTimeout);
      ro.disconnect();
      window.visualViewport?.removeEventListener("resize", onVvResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onWindowBlur);
      cardMql.removeEventListener("change", updateCardDisabled);
      removeFirstGesture?.();
      if (orientationAttached) {
        window.removeEventListener("deviceorientation", onOrientation);
      }
    };
  }, [cardRef]);

  return <Canvas ref={canvasRef} aria-hidden />;
}

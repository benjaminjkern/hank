import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const alt = "Hank — let's get you hired";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const iconSvg = await readFile(
    join(process.cwd(), "src/app/icon.svg"),
    "utf-8",
  );
  const iconSrc = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "96px",
        // Satori doesn't honor border-radius on big offscreen overlay divs,
        // so the glows live on the canvas background as stacked radial
        // gradients. Centers sit outside the frame; falloff dissolves to
        // zero alpha so there's no visible disk edge.
        backgroundImage: [
          "radial-gradient(circle at 110% -20%, rgba(161,109,255,0.7) 0%, rgba(161,109,255,0.3) 25%, rgba(161,109,255,0.08) 50%, rgba(161,109,255,0) 75%)",
          "radial-gradient(circle at -15% 115%, rgba(124,77,255,0.6) 0%, rgba(124,77,255,0.22) 28%, rgba(124,77,255,0.06) 55%, rgba(124,77,255,0) 80%)",
        ].join(", "),
        backgroundColor: "#0c0c0e",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#ededf0",
        position: "relative",
      }}
    >
      {/* Icon + wordmark row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "32px",
          zIndex: 1,
        }}
      >
        {}
        <img src={iconSrc} alt="" width={140} height={140} />
        <div
          style={{
            fontSize: 180,
            fontWeight: 700,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          Hank
        </div>
      </div>

      <div
        style={{
          marginTop: "40px",
          fontSize: 64,
          fontWeight: 500,
          color: "#c4a3ff",
          letterSpacing: "-0.01em",
          zIndex: 1,
        }}
      >
        Let&apos;s get you hired.
      </div>

      <div
        style={{
          marginTop: "28px",
          fontSize: 34,
          color: "#9a9aa3",
          maxWidth: "900px",
          lineHeight: 1.35,
          zIndex: 1,
        }}
      >
        Hank handles the job-hunt busywork. You call the shots.
      </div>
    </div>,
    { ...size },
  );
}

import { NextResponse } from "next/server";
import { auth } from "@/server/auth/config";

// Next.js 16 Proxy runs in the Node.js runtime by default, so the full
// Auth.js config (with the Prisma adapter) works here — no separate edge
// slice required. The session-cookie lookup hits the database via the
// adapter and `req.auth` reflects the real signed-in user.

const PUBLIC_PATHS = [
  "/signin",
  "/auth/error",
  // PWA assets — the SW re-fetches itself on update checks (no auth context),
  // and the manifest + icons it references are fetched by the browser without
  // credentials. Any PNG/icon referenced from the manifest must live here too,
  // or the browser sees a 302 to /signin and silently disables PWA install.
  "/sw.js",
  "/manifest.webmanifest",
  "/apple-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

export default auth((req) => {
  if (req.auth) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
  ) {
    return NextResponse.next();
  }

  // API routes get a 401 JSON response. Page routes get redirected to /signin
  // with the original path captured as callbackUrl.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const signInUrl = new URL("/signin", req.nextUrl);
  signInUrl.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(signInUrl);
});

// Exclude Next internals + the Auth.js endpoints (those handle their own auth)
// + static assets. Everything else flows through `auth` above.
export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

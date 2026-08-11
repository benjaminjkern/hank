import { randomUUID } from "node:crypto";

import { cookies, headers } from "next/headers";

import { nowMs } from "@/utils/now";

import { prisma } from "../db/prisma";
import { authMode } from "../platform/deployment";

// Sign-in for AUTH_MODE=local: type an email, become that account. No password,
// no verification — the deployment has decided it doesn't need one.
//
// This writes the Session row and cookie directly instead of going through an
// Auth.js provider, because the only provider that could express "no
// credential" is Credentials, and Auth.js forces `strategy: "jwt"` whenever one
// is registered. This app runs database sessions on purpose (requireAdmin
// depends on a role change landing on the next request), so a provider here
// would silently convert every session in the app to a JWT.
//
// The cost is that the row and cookie have to match what Auth.js expects to
// read back. Both halves are below; if a future Auth.js version renames the
// cookie, local sign-in stops working and OAuth keeps going.

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type LocalSignInResult = { ok: true } | { ok: false; error: string };

// Auth.js picks the `__Secure-` variant when it believes it's on https, from
// the configured URL if there is one and the forwarded proto otherwise. Mirror
// that: guess wrong and the cookie we set is not the cookie auth() reads.
async function sessionCookieName(): Promise<string> {
  const configuredUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const secure = configuredUrl
    ? configuredUrl.startsWith("https://")
    : (await headers()).get("x-forwarded-proto") === "https";
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

// Deliberately loose. This is not a security boundary — local mode has none —
// it only catches a typo before it becomes an account.
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function signInLocally(
  rawEmail: string,
): Promise<LocalSignInResult> {
  if (authMode !== "local") {
    return {
      ok: false,
      error: "This instance requires signing in with a provider.",
    };
  }

  const email = rawEmail.trim().toLowerCase();
  if (!looksLikeEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // emailVerified stays null: nothing verified it. The column is Auth.js's, and
  // leaving it honest keeps "this account proved its email" meaningful if this
  // instance later switches to oauth.
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
  });

  const sessionToken = randomUUID();
  const expires = new Date(nowMs() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires },
  });

  const cookieName = await sessionCookieName();
  const store = await cookies();
  store.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cookieName.startsWith("__Secure-"),
    expires,
  });

  return { ok: true };
}

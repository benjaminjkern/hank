"use server";

// App-wide server actions — the ones not owned by a single route (route-owned
// actions sit beside their page, e.g. settings/actions.ts). Client components
// import server actions from src/app, never from src/server.

import { signOut } from "@/server/platform/auth/config";

export async function signOutAction() {
  await signOut({ redirectTo: "/signin" });
}

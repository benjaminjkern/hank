"use server";

import { signOut } from "./config";

export async function signOutAction() {
  await signOut({ redirectTo: "/signin" });
}

"use server";

import { getCurrentUser } from "@/server/auth/currentUser";
import {
  requestServerKeyAccess,
  type AccessRequestResult,
} from "@/server/auth/requestServerKeyAccess";

// Thin action wrapper: resolve who's asking, then hand off. The blocker modal
// is the only caller.
export async function requestAccessAction(): Promise<AccessRequestResult> {
  const user = await getCurrentUser();
  return await requestServerKeyAccess(user.id);
}

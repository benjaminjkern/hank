"use server";

import { getCurrentUser } from "@/server/platform/auth/currentUser";
import {
  requestServerKeyAccess,
  type AccessRequestResult,
} from "@/server/platform/llm/requestServerKeyAccess";

// Thin action wrapper: resolve who's asking, then hand off. The blocker modal
// is the only caller.
export async function requestAccessAction(): Promise<AccessRequestResult> {
  const user = await getCurrentUser();
  return await requestServerKeyAccess(user.id);
}

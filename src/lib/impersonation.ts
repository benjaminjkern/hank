import { withQueryParam } from "@/utils/url";

// Append the impersonate query param to a read-path URL when the client is in
// admin view-session mode. Handles both query-less and query-bearing inputs.
// Write endpoints never call this — the server rejects any write that arrives
// with the param (rejectImpersonatedWrite), but keeping it off the request
// keeps the network trace honest about what the UI is asking for.
export function withImpersonate(
  path: string,
  sessionId: string | null,
): string {
  return withQueryParam(path, "impersonate", sessionId);
}

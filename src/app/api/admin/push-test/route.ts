import { NextResponse } from "next/server";

import { requireAdmin } from "@/server/auth/requireAdmin";
import { notifyAdmin } from "@/server/platform/notifications/pushAdmin";

export async function POST() {
  await requireAdmin();
  const result = await notifyAdmin(
    "Hank test",
    "If you see this, push is working.",
  );
  // Truncate endpoints so we don't leak full subscription URLs into the UI.
  const safe = {
    ...result,
    results: result.results.map((r) => ({
      ...r,
      endpoint: r.endpoint.slice(0, 60) + "…",
    })),
  };
  return NextResponse.json(safe);
}

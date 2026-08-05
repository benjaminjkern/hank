import { z } from "zod";

import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const postBody = z.object({ subscription: subscriptionSchema });
const deleteBody = z.object({ id: z.string().min(1) });

function serialize(row: {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: Date;
  lastNotifiedAt: Date | null;
}) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastNotifiedAt: row.lastNotifiedAt?.toISOString() ?? null,
  };
}

export async function GET() {
  const user = await requireAdmin();
  const rows = await prisma.pushSubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      endpoint: true,
      userAgent: true,
      createdAt: true,
      lastNotifiedAt: true,
    },
  });
  return Response.json({ subscriptions: rows.map(serialize) });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  const json = await req.json().catch(() => null);
  const parsed = postBody.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "Invalid subscription payload" },
      { status: 400 },
    );
  }
  const { subscription } = parsed.data;
  const userAgent = req.headers.get("user-agent");

  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: {
      userId: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
    },
    update: {
      // Re-subscribe from the same install: keys rotate, ownership transfers
      // to whichever admin is using this device now.
      userId: user.id,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: userAgent ?? null,
    },
    select: {
      id: true,
      endpoint: true,
      userAgent: true,
      createdAt: true,
      lastNotifiedAt: true,
    },
  });
  return Response.json({ ok: true, subscription: serialize(row) });
}

export async function DELETE(req: Request) {
  const user = await requireAdmin();
  const json = await req.json().catch(() => null);
  const parsed = deleteBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Missing id" }, { status: 400 });
  }
  // Scope by userId so one admin can't accidentally delete another admin's
  // device. deleteMany returns count=0 silently if the row isn't theirs.
  const result = await prisma.pushSubscription.deleteMany({
    where: { id: parsed.data.id, userId: user.id },
  });
  return Response.json({ ok: true, deleted: result.count });
}

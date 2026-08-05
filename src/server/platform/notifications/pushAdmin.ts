import webpush from "web-push";

import { prisma } from "@/server/db/prisma";

let configured = false;

function configure(): boolean {
  if (configured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

type PushResult =
  | { endpoint: string; ok: true; statusCode: number }
  | { endpoint: string; ok: false; statusCode?: number; message: string };

type NotifyResult = {
  configured: boolean;
  subscriptionsFound: number;
  results: PushResult[];
};

export async function notifyAdmin(
  title: string,
  body: string,
): Promise<NotifyResult> {
  if (!configure()) {
    return { configured: false, subscriptionsFound: 0, results: [] };
  }
  const subs = await prisma.pushSubscription.findMany({
    where: { user: { isAdmin: true } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) {
    return { configured: true, subscriptionsFound: 0, results: [] };
  }

  const payload = JSON.stringify({ title, body });
  const results = await Promise.all(
    subs.map(async (sub): Promise<PushResult> => {
      try {
        const res = await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
        );
        void prisma.pushSubscription
          .update({
            where: { id: sub.id },
            data: { lastNotifiedAt: new Date() },
          })
          .catch(() => {});
        return { endpoint: sub.endpoint, ok: true, statusCode: res.statusCode };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[pushAdmin] push failed (status ${statusCode ?? "unknown"}): ${message}`,
        );
        // 404 / 410 = the push service has dropped this subscription; the
        // row is dead and re-sending will never succeed. Auto-prune so the
        // admin doesn't have to babysit dead devices.
        if (statusCode === 404 || statusCode === 410) {
          void prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        }
        return { endpoint: sub.endpoint, ok: false, statusCode, message };
      }
    }),
  );
  return { configured: true, subscriptionsFound: subs.length, results };
}

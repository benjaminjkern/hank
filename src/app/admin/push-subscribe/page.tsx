import { requireAdmin } from "@/server/auth/requireAdmin";

import { PushSubscribeView } from "./PushSubscribeView";

export const dynamic = "force-dynamic";

export default async function PushSubscribePage() {
  await requireAdmin();
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  return <PushSubscribeView vapidPublicKey={vapidPublicKey} />;
}

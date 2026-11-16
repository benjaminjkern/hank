import { notFound } from "next/navigation";

import { ChatPanel } from "@/client/components/Chat/ChatPanel";
import { ChatHydrator } from "@/client/components/ChatHydrator";
import { ImpersonationBanner } from "@/client/components/Layout/ImpersonationBanner";
import { SplitLayout } from "@/client/components/Layout/SplitLayout";
import { TopBar } from "@/client/components/Layout/TopBar";
import { LoadingOverlay } from "@/client/components/LoadingOverlay";
import { RightPanel } from "@/client/components/RightPanel/RightPanel";
import { prisma } from "@/server/db/prisma";
import { requireAdmin } from "@/server/platform/auth/requireAdmin";

export const dynamic = "force-dynamic";

export default async function AdminSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const admin = await requireAdmin();
  const { sessionId } = await params;

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      user: { select: { email: true, id: true } },
    },
  });
  if (!session) notFound();

  const targetEmail = session.user.email ?? `user ${session.user.id.slice(-8)}`;

  // No ApiKeyBlockerModal — the admin's own Anthropic key state is
  // irrelevant here; we're loading the target user's data, not running the
  // agent. The composer is hidden in this mode anyway (see ChatPanel).
  return (
    <>
      <ChatHydrator
        initialApiKeyBlocker={null}
        impersonateSessionId={sessionId}
      />
      <SplitLayout
        banner={<ImpersonationBanner targetEmail={targetEmail} />}
        top={
          <TopBar
            user={{
              id: admin.id,
              email: admin.email,
              name: admin.name,
              image: admin.image,
              isAdmin: admin.isAdmin,
            }}
          />
        }
        left={<ChatPanel />}
        right={<RightPanel />}
      />
      <LoadingOverlay />
    </>
  );
}

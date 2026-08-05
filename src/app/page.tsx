import { redirect } from "next/navigation";

import { ApiKeyBlockerModal } from "@/components/ApiKeyBlockerModal";
import { ChatPanel } from "@/components/Chat/ChatPanel";
import { ChatHydrator } from "@/components/ChatHydrator";
import { SplitLayout } from "@/components/Layout/SplitLayout";
import { TopBar } from "@/components/Layout/TopBar";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { RightPanel } from "@/components/RightPanel/RightPanel";
import { auth } from "@/server/auth/config";

export default async function Home() {
  // Belt + suspenders with middleware: if we get here without a session
  // (e.g. middleware didn't reload after edits), redirect cleanly instead
  // of throwing.
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const user = {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    isAdmin: session.user.isAdmin,
  };
  // Chat runs on DeepSeek, so the first-load gate keys on the DeepSeek key (own
  // key, or the server key when permitted — canUseServerKey gates BOTH
  // server keys). Best-effort only: it can't see whether DEEPSEEK_API_KEY is
  // actually set in the server env, so the authoritative gate is the runtime one
  // in runUserMessage (which yields NO_DEEPSEEK_KEY → missing_deepseek). Worst
  // case here is a brief modal the first turn corrects.
  const canChat = session.user.hasDeepseekKey || session.user.canUseServerKey;
  return (
    <>
      <ChatHydrator
        initialApiKeyBlocker={canChat ? null : "missing_deepseek"}
      />
      <SplitLayout
        top={<TopBar user={user} />}
        left={<ChatPanel />}
        right={<RightPanel />}
      />
      <ApiKeyBlockerModal />
      <LoadingOverlay />
    </>
  );
}

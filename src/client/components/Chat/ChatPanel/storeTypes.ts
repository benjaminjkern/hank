import type { useChatStore } from "@/client/chatStore";

// chatStore doesn't export its State type, so the store slices this folder
// passes as props are derived from it here rather than re-declared.
type ChatStoreState = ReturnType<typeof useChatStore.getState>;

export type PendingAttachment = ChatStoreState["pendingAttachments"][number];
export type ActivePanel = ChatStoreState["activePanel"];

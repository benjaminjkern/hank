import type { UserDocuments } from "@/server/views/documents";

export type DocumentsPayload = UserDocuments & { readOnly: boolean };

export type SaveTone = "idle" | "saving" | "saved" | "error";

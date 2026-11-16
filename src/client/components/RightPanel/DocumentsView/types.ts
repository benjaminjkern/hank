import type { UserDocuments } from "@/shared/views/documents";

export type DocumentsPayload = UserDocuments & { readOnly: boolean };

export type SaveTone = "idle" | "saving" | "saved" | "error";

// The user-global documents the Documents page lets a user edit directly, each a
// plain markdown memory note. This map is the allowlist: the memory write route
// refuses any `doc` not in this set, so the page can never be used to scribble
// into arbitrary memory paths (companies/{slug}.md etc).

import { writeMemory } from "@/server/entities/memory/store";
import { RESUME_PATH } from "@/server/entities/profile/resume";
import type { EditableDocKind } from "@/shared/editableDocs";

export const EDITABLE_DOC_PATHS = {
  profile: "profile.md",
  frequent_questions: "frequent_questions.md",
  resume: RESUME_PATH,
} as const satisfies Record<EditableDocKind, string>;

export function isEditableDocKind(v: unknown): v is EditableDocKind {
  return typeof v === "string" && v in EDITABLE_DOC_PATHS;
}

// Persist an edit to one of the editable documents.
export async function saveEditableDoc(
  userId: string,
  doc: EditableDocKind,
  content: string,
): Promise<void> {
  await writeMemory(userId, EDITABLE_DOC_PATHS[doc], content);
}

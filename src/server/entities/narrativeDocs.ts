// The user-global documents the Documents page lets a user edit directly, each a
// plain markdown memory note. This map is the allowlist: the memory write route
// refuses any `doc` not in this set, so the page can never be used to scribble
// into arbitrary memory paths (companies/{slug}.md etc).

import { RESUME_PATH } from "@/server/entities/resume/store";
import { writeMemory } from "@/server/memory/store";

export const NARRATIVE_DOC_PATHS = {
  profile: "profile.md",
  frequent_questions: "frequent_questions.md",
  resume: RESUME_PATH,
} as const;

export type EditableDocKind = keyof typeof NARRATIVE_DOC_PATHS;

export function isEditableDocKind(v: unknown): v is EditableDocKind {
  return typeof v === "string" && v in NARRATIVE_DOC_PATHS;
}

// Persist an edit to one of the editable documents.
export async function saveUserDoc(
  userId: string,
  doc: EditableDocKind,
  content: string,
): Promise<void> {
  await writeMemory(userId, NARRATIVE_DOC_PATHS[doc], content);
}

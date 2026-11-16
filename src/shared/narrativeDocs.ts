// The user-global documents the Documents page lets a user edit directly. The
// memory path each one maps to — and the allowlist the write route enforces —
// is NARRATIVE_DOC_PATHS in server/entities/narrativeDocs.ts, which is typed
// against this union so the two can't disagree about which docs exist.
export type EditableDocKind = "profile" | "frequent_questions" | "resume";

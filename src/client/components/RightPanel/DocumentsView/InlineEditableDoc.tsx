"use client";

import { useState } from "react";
import styled from "styled-components";

import type { EditableDocKind } from "@/server/entities/narrativeDocs";

import { CardHint, EmptyHint, Prose } from "./styles";

import type { SaveTone } from "./types";

function saveToneLabel(t: SaveTone): string {
  if (t === "saving") return "Saving…";
  if (t === "saved") return "Saved";
  if (t === "error") return "Save failed";
  return "";
}

// One editable markdown doc. No view/edit mode switch — the textarea is always
// live and saves when you click away (matching the cover-letter / short-answer
// editors). `label` is rendered only for inline use (e.g. resume framing
// notes); on its own sub-page the SubTitle carries the name and no label is
// passed.
export function InlineEditableDoc({
  label,
  hint,
  doc,
  value,
  readOnly,
  placeholder,
  onSaved,
}: {
  label?: string;
  hint?: string;
  doc: EditableDocKind;
  value: string;
  readOnly: boolean;
  placeholder: string;
  onSaved: (content: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  const [lastSynced, setLastSynced] = useState(value);
  const [focused, setFocused] = useState(false);
  const [tone, setTone] = useState<SaveTone>("idle");

  // Re-sync from the canonical value when it changes externally (another save,
  // an impersonation reload) and we're not mid-edit. Mirrors the artifact
  // editors' adjust-state-during-render sync.
  if (value !== lastSynced) {
    setLastSynced(value);
    if (!focused) {
      setDraft(value);
      setSavedValue(value);
    }
  }

  async function save() {
    if (draft === savedValue) return;
    setTone("saving");
    try {
      const res = await fetch("/api/documents/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, content: draft }),
      });
      if (!res.ok) throw new Error();
      setSavedValue(draft);
      onSaved(draft);
      setTone("saved");
      setTimeout(() => setTone("idle"), 1500);
    } catch {
      setTone("error");
    }
  }

  if (readOnly) {
    return (
      <div>
        {label && <FieldLabel style={{ marginBottom: 4 }}>{label}</FieldLabel>}
        {hint && <CardHint>{hint}</CardHint>}
        {value.trim() ? (
          <Prose>{value}</Prose>
        ) : (
          <EmptyHint>{placeholder}</EmptyHint>
        )}
      </div>
    );
  }

  return (
    <div>
      <FieldHead>
        {label ? <FieldLabel>{label}</FieldLabel> : <span />}
        <SaveNote $tone={tone}>{saveToneLabel(tone)}</SaveNote>
      </FieldHead>
      {hint && <CardHint>{hint}</CardHint>}
      <TextArea
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void save();
        }}
      />
    </div>
  );
}

const FieldHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  margin-bottom: 4px;
  min-height: 14px;
`;

const FieldLabel = styled.div`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
  text-transform: uppercase;
  letter-spacing: 0.4px;
`;

const TextArea = styled.textarea`
  width: 100%;
  min-height: 200px;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};
  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const SaveNote = styled.span<{ $tone: SaveTone }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $tone }) =>
    $tone === "error"
      ? theme.colors.danger
      : $tone === "saved"
        ? theme.colors.success
        : theme.colors.textSubtle};
  opacity: ${({ $tone }) => ($tone === "idle" ? 0 : 1)};
  transition: opacity 0.2s;
`;

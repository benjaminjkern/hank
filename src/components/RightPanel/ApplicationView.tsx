"use client";

// The application page: everything the form asks for, in form order, each with
// room to actually write in.
//
// Every item is listed whether or not anything is written for it — a question
// Hank passed over is one the user can still answer, and one they can't see is
// one they can't fill in. But the two kinds don't get the same treatment: the
// form's stock fields (`verdict === "skip"`, nothing written) are named in a
// collapsed tail with no editor, because handing someone a textarea for their
// own LinkedIn URL buries the two questions that need real writing. Editing
// persists on blur and never wakes Hank; the change rides their next message
// (or the Send-my-changes button), which is also what re-baselines the
// "edited" marker.

import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { buildWidgetSubmissionMessage } from "@/components/Chat/widgets/types";
import { isStockItem } from "@/lib/applicationItem";
import { useChatStore } from "@/lib/chatStore";
import type {
  ApplicationItem,
  ApplicationItemStatus,
  ApplicationView as ApplicationViewPayload,
} from "@/server/views/application";

import { AuthorMark } from "./shared/AuthorMark";
import {
  ConfirmRemoveButton,
  ReuseSwitch,
} from "./shared/applicationArtifacts";

const Root = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xl};
  max-width: 780px;
`;

const Header = styled.header`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const TitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  min-width: 0;
`;

const H2 = styled.h2`
  font-size: 16px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  min-width: 0;
`;

const Note = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
`;

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.sm};
`;

const PillButton = styled.button<{ $primary?: boolean }>`
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme, $primary }) =>
    $primary ? theme.colors.bg : theme.colors.accent};
  background: ${({ theme, $primary }) =>
    $primary ? theme.colors.accent : "transparent"};

  &:hover:not(:disabled) {
    opacity: 0.85;
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const LinkOut = styled.a`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.accent};
  align-self: center;
`;

// The outline is the page's one piece of live state: this box holds a change
// Hank hasn't been told about. Nothing else on the card is allowed to use the
// accent colour, so "outlined" reads as one thing.
const Item = styled.section<{ $pending: boolean }>`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => theme.space.lg};
  border: 1px solid
    ${({ theme, $pending }) =>
      $pending ? theme.colors.accent : theme.colors.border};
  box-shadow: ${({ theme, $pending }) =>
    $pending ? `0 0 0 3px ${theme.colors.accent}22` : "none"};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
`;

const HeadMarks = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  flex-shrink: 0;
`;

const ItemHead = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
`;

const ItemLabel = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.45;
  min-width: 0;
`;

const Tag = styled.span<{ $tone: "accent" | "danger" }>`
  flex-shrink: 0;
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  text-transform: uppercase;
  letter-spacing: 0.4px;
  white-space: nowrap;
  color: ${({ theme, $tone }) =>
    $tone === "accent" ? theme.colors.accent : theme.colors.danger};
`;

const SubLabel = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
  line-height: 1.5;
`;

// Tall enough to write a real cover letter in, and it grows with the text —
// the small fixed boxes were the reason drafts felt like form fields rather
// than something you'd actually work on.
const Editor = styled.textarea<{ $tall: boolean }>`
  width: 100%;
  min-height: ${({ $tall }) => ($tall ? "320px" : "120px")};
  resize: vertical;
  font: inherit;
  font-size: 14px;
  line-height: 1.65;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }
`;

const ItemFoot = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.sm};
  min-height: 18px;
`;

const FootControls = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  min-width: 0;
`;

const SaveState = styled.span<{ $tone: "idle" | "saving" | "saved" | "error" }>`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme, $tone }) =>
    $tone === "error" ? theme.colors.danger : theme.colors.textSubtle};
  opacity: ${({ $tone }) => ($tone === "idle" ? 0 : 1)};
  transition: opacity 0.2s;
`;

const StockSection = styled.section`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.xs};
`;

const StockHeader = styled.button`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  background: transparent;
  cursor: pointer;
  padding: ${({ theme }) => theme.space.xs} 0;
  text-align: left;
`;

const StockCaret = styled.span<{ $open: boolean }>`
  display: inline-block;
  transition: transform 120ms ease;
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  color: ${({ theme }) => theme.colors.textSubtle};
  font-size: 10px;
`;

const StockTitle = styled.h3`
  font-size: 13px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const StockCount = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  font-family: ${({ theme }) => theme.font.mono};
`;

const StockRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
  border-left: 2px solid ${({ theme }) => theme.colors.border};
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  overflow-wrap: anywhere;
`;

// A question someone described by hand is edited where it sits — clicking the
// words is the affordance, so there's no second control competing with the
// question itself. Only ever offered on a hand-added one: a scraped question is
// what the form actually says.
const EditableLabel = styled.span`
  cursor: text;
  border-bottom: 1px dashed transparent;
  &:hover {
    border-bottom-color: ${({ theme }) => theme.colors.border};
  }
`;

const RenameRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  flex-wrap: wrap;
`;

const AddRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  flex-wrap: wrap;
`;

const AddInput = styled.input`
  flex: 1;
  min-width: 200px;
  font: inherit;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: 6px 10px;

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const AddButton = styled.button`
  font-size: 11px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.accent};
  background: transparent;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
  &:disabled {
    color: ${({ theme }) => theme.colors.textSubtle};
    cursor: not-allowed;
  }
`;

const Empty = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.6;
`;

// One unresolved finding, sitting against the text it's about. Two rewrites
// couldn't settle it, because settling it means knowing something about the
// user that isn't on the page.
const Finding = styled.div<{ $register: "question" | "note" }>`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-left: 2px solid
    ${({ theme, $register }) =>
      $register === "question" ? theme.colors.border : theme.colors.danger};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 12px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const FindingMark = styled.span<{ $register: "question" | "note" }>`
  color: ${({ theme, $register }) =>
    $register === "question" ? theme.colors.textSubtle : theme.colors.danger};
  flex-shrink: 0;
`;

function countThings(n: number): string {
  return n === 1 ? "one thing" : `${n} things`;
}

const PLACEHOLDER: Record<ApplicationItemStatus, string> = {
  written_by_you: "",
  drafted: "",
  needs_you:
    "Tell Hank about this in chat and he'll shape it with you — or write it here.",
  empty: "Nothing written yet. Write it here, or ask Hank to draft it.",
};

export function ApplicationView({
  application,
}: {
  application: ApplicationViewPayload;
}) {
  const send = useChatStore((s) => s.send);
  const streaming = useChatStore((s) => s.streaming);
  const readOnly = !!useChatStore((s) => s.impersonateSessionId);
  const pending = application.pendingEditCount;
  const open = application.openFindingCount;
  // Submit asks once when the review has something open, then defers. It's the
  // last honest moment to catch a contradiction — after this the application is
  // sent and the page is a record — but it's the user's call, not a gate.
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  // Editing the flagged item clears its finding, so the ask can evaporate
  // between the two taps — in which case there's nothing left to confirm and
  // the button goes back to plain submit.
  const asking = confirmingSubmit && open > 0;
  const needsConfirm = open > 0 && !confirmingSubmit;

  // A stock field with an answer saved against it keeps its editor in the main
  // list — the verdict says nobody needs to DRAFT it, not that the text it
  // already holds should be tucked away.
  const toWrite: ApplicationItem[] = [];
  const fillInYourself: ApplicationItem[] = [];
  for (const item of application.items) {
    (isStockItem(item) ? fillInYourself : toWrite).push(item);
  }

  return (
    <Root>
      <Header>
        <TitleRow>
          <H2>
            {application.jobTitle} — {application.companyName}
          </H2>
        </TitleRow>
        {application.submitted && (
          <Note>
            You&apos;ve submitted this one. It stays here to read or reuse —
            edits from now on are just for you, and Hank won&apos;t be asked to
            look again.
          </Note>
        )}
        {asking && !application.submitted && (
          <Note>
            {countThings(open)} below {open === 1 ? "is" : "are"} still flagged.
            Sending is your call — tap again and I&apos;ll mark it submitted.
          </Note>
        )}
        {!readOnly && (
          <ActionRow>
            {!application.submitted && (
              <>
                <PillButton
                  disabled={streaming}
                  onClick={() =>
                    void send(
                      pending > 0
                        ? "I've made some changes to the application — take a look and tell me what you think."
                        : "The application reads right to me as it stands.",
                    )
                  }
                >
                  {pending > 0 ? "Send my changes" : "Looks good to me"}
                </PillButton>
                <PillButton
                  $primary
                  disabled={streaming}
                  onClick={() => {
                    if (needsConfirm) {
                      setConfirmingSubmit(true);
                      return;
                    }
                    void send(
                      buildWidgetSubmissionMessage(
                        {
                          kind: "confirm_application_submit",
                          jobId: application.jobId,
                        },
                        "[I submitted ✓]",
                        {
                          jobTitle: application.jobTitle,
                          companyName: application.companyName,
                        },
                      ),
                    );
                  }}
                >
                  {asking ? "Yes, mark it submitted" : "I submitted ✓"}
                </PillButton>
              </>
            )}
            {application.postingUrl && (
              <LinkOut
                href={application.postingUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the posting ↗
              </LinkOut>
            )}
          </ActionRow>
        )}
      </Header>

      {application.formUnreadable && application.items.length === 0 && (
        <Empty>
          Hank couldn&apos;t read this application form — its page is
          login-gated, on an ATS he can&apos;t parse, or there&apos;s no
          application link on file. Add what it asks below, or tell him in chat.
        </Empty>
      )}
      {!application.formUnreadable && application.items.length === 0 && (
        <Empty>
          This form has no written questions — just the standard fields you fill
          in directly on the posting.
        </Empty>
      )}

      {toWrite.map((item) => (
        <ApplicationItemCard
          key={item.id}
          jobId={application.jobId}
          item={item}
          readOnly={readOnly}
        />
      ))}
      {/* Always offered, and most needed in the empty branches above — an
          unreadable form is exactly the case where every question has to be
          described by hand. */}
      {!readOnly && <AddQuestion jobId={application.jobId} />}
      {fillInYourself.length > 0 && <StockFields items={fillInYourself} />}
    </Root>
  );
}

// The form's stock fields — name, work authorization, LinkedIn URL. The decider
// ruled these are faster to type than to read a draft of, so they get no editor
// here: listing them is the whole job, so the page can say "this is everything
// the form asks" without burying the two questions that need real writing.
// One with an answer already saved stays in the main list — there's text to
// read, and hiding it would hide the text.
function StockFields({ items }: { items: ApplicationItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <StockSection>
      <StockHeader onClick={() => setOpen((o) => !o)}>
        <StockCaret $open={open}>▶</StockCaret>
        <StockTitle>Easy ones — you fill these in yourself</StockTitle>
        <StockCount>{items.length}</StockCount>
      </StockHeader>
      {open && (
        <>
          <SubLabel>
            The form asks for these too. They&apos;re quick to answer straight
            on the posting, so Hank leaves them to you.
          </SubLabel>
          {items.map((item) => (
            <StockRow key={item.id}>
              {item.label}
              {item.required && <SubLabel>Required</SubLabel>}
            </StockRow>
          ))}
        </>
      )}
    </StockSection>
  );
}

// Describe a question the scrape missed. It's recorded against the job as
// added-by-hand, so it shows up for anyone working this posting and survives
// the next re-scrape of the form.
function AddQuestion({ jobId }: { jobId: string }) {
  const replaceViewedApplication = useChatStore(
    (s) => s.replaceViewedApplication,
  );
  const [adding, setAdding] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      replaceViewedApplication((await res.json()) as ApplicationViewPayload);
      setQuestion("");
      setAdding(false);
    } catch {
      setError("Couldn't add that one.");
    } finally {
      setBusy(false);
    }
  }

  if (!adding) {
    return (
      <AddRow>
        <AddButton onClick={() => setAdding(true)}>+ Add a question</AddButton>
      </AddRow>
    );
  }

  return (
    <AddRow>
      <AddInput
        autoFocus
        value={question}
        disabled={busy}
        placeholder="What does the form ask? Write it the way they word it…"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setAdding(false);
        }}
      />
      <AddButton
        onClick={() => void submit()}
        disabled={busy || !question.trim()}
      >
        {busy ? "Adding…" : "Add"}
      </AddButton>
      <AddButton
        onClick={() => {
          setAdding(false);
          setQuestion("");
          setError(null);
        }}
        disabled={busy}
      >
        Cancel
      </AddButton>
      {error && <Tag $tone="danger">{error}</Tag>}
    </AddRow>
  );
}

function ApplicationItemCard({
  jobId,
  item,
  readOnly,
}: {
  jobId: string;
  item: ApplicationItem;
  readOnly: boolean;
}) {
  const replaceViewedApplication = useChatStore(
    (s) => s.replaceViewedApplication,
  );
  const [text, setText] = useState(item.text ?? "");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const savedRef = useRef(item.text ?? "");
  const [copied, setCopied] = useState(false);
  const [renamingLabel, setRenamingLabel] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [renaming, setRenaming] = useState(false);

  function cancelRename() {
    setRenamingLabel(false);
    setLabel(item.label);
  }

  // Only for a question this person described by hand: the form isn't asking it
  // after all, so it leaves with whatever was written under it.
  async function remove() {
    if (renaming) return;
    setRenaming(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      if (!res.ok) throw new Error(String(res.status));
      replaceViewedApplication((await res.json()) as ApplicationViewPayload);
    } catch {
      setSaveState("error");
    } finally {
      setRenaming(false);
    }
  }

  // The question text is the key its answer is stored under, so this goes
  // through its own endpoint — the server moves the answer with it.
  async function renameLabel() {
    const next = label.trim();
    if (!next || renaming) return;
    if (next === item.label) {
      setRenamingLabel(false);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, question: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      replaceViewedApplication((await res.json()) as ApplicationViewPayload);
      setRenamingLabel(false);
    } catch {
      setSaveState("error");
    } finally {
      setRenaming(false);
    }
  }

  // Follow the server when it changes underneath us (Hank drafted, or a
  // revision landed) — but never clobber what's being typed right now.
  useEffect(() => {
    const incoming = item.text ?? "";
    if (incoming !== savedRef.current) {
      savedRef.current = incoming;
      setText(incoming);
    }
  }, [item.text]);

  useEffect(() => {
    setLabel(item.label);
  }, [item.label]);

  // Copying is the other way a person claims a piece of writing: they took it
  // to paste into the real form, which says "reuse this later" as clearly as
  // editing does. A dirty box saves first — that write flips the flag on its
  // own, so there's nothing left to ask for.
  async function copy() {
    const text_ = text;
    try {
      await navigator.clipboard.writeText(text_);
    } catch {
      setSaveState("error");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    if (readOnly) return;
    if (text_ !== savedRef.current) await persist({ text: text_ });
    else if (text_.trim() && item.reuse !== true)
      await persist({ reuse: true });
  }

  async function persist(patch: { text?: string; reuse?: boolean }) {
    if (readOnly) return;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, ...patch }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const fresh = (await res.json()) as ApplicationViewPayload;
      if (patch.text !== undefined) savedRef.current = patch.text;
      replaceViewedApplication(fresh);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch {
      setSaveState("error");
    }
  }

  // One thing the outline says: there's a change here Hank hasn't seen, and it
  // rides the next message. A question described by hand counts even with
  // nothing written under it — the form asks something he can't see.
  const pending = item.edited || item.addedNotRelayed;
  return (
    <Item $pending={pending}>
      <ItemHead>
        <ItemLabel>
          {renamingLabel ? (
            <RenameRow>
              <AddInput
                autoFocus
                value={label}
                disabled={renaming}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void renameLabel();
                  if (e.key === "Escape") cancelRename();
                }}
              />
              <AddButton
                onClick={() => void renameLabel()}
                disabled={renaming || !label.trim()}
              >
                {renaming ? "Saving…" : "Save"}
              </AddButton>
              <AddButton onClick={cancelRename} disabled={renaming}>
                Cancel
              </AddButton>
            </RenameRow>
          ) : item.addedByYou && !readOnly ? (
            <EditableLabel
              onClick={() => setRenamingLabel(true)}
              title="Edit this question"
            >
              {item.label}
            </EditableLabel>
          ) : (
            item.label
          )}
          {item.required && <SubLabel>Required</SubLabel>}
        </ItemLabel>
        <HeadMarks>
          {item.addedByYou && !readOnly && !renamingLabel && (
            <ConfirmRemoveButton
              hasText={!!item.text?.trim()}
              onRemove={() => void remove()}
              label="✕"
              title="Remove this question"
              prompt="Remove it and its answer?"
            />
          )}
          {pending && (
            <Tag $tone="accent">
              {item.edited ? "edited" : "added"} · not sent yet
            </Tag>
          )}
          {item.author && <AuthorMark author={item.author} />}
        </HeadMarks>
      </ItemHead>

      {item.source === "user" && (
        <SubLabel>
          Added by hand — Hank couldn&apos;t read this one off the form.
        </SubLabel>
      )}
      {item.note && <SubLabel>{item.note}</SubLabel>}

      {/* Above the editor: the point is to be read before the text is. A
          `question` is Hank asking about his own draft — it must not look like
          a fault, because the user didn't write the words it's about. */}
      {item.findings.map((finding) => (
        <Finding key={finding.note} $register={finding.register}>
          <FindingMark $register={finding.register}>
            {finding.register === "question" ? "?" : "!"}
          </FindingMark>
          <span>{finding.note}</span>
        </Finding>
      ))}

      <Editor
        $tall={item.kind === "cover_letter"}
        value={text}
        readOnly={readOnly}
        placeholder={PLACEHOLDER[item.status]}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== savedRef.current) void persist({ text });
        }}
      />

      <ItemFoot>
        {item.text ? (
          <FootControls>
            <ReuseSwitch
              on={item.reuse === true}
              disabled={readOnly}
              onChange={(next) => void persist({ reuse: next })}
            />
            {!readOnly && (
              <AddButton onClick={() => void copy()} disabled={!text.trim()}>
                {copied ? "Copied" : "Copy"}
              </AddButton>
            )}
          </FootControls>
        ) : (
          <span />
        )}
        <SaveState $tone={saveState}>
          {saveState === "saving"
            ? "saving…"
            : saveState === "saved"
              ? "saved"
              : saveState === "error"
                ? "couldn't save"
                : ""}
        </SaveState>
      </ItemFoot>
    </Item>
  );
}

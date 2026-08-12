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

import { wasStockItem } from "@/lib/applicationItem";
import { useChatStore } from "@/lib/chatStore";
import type {
  ApplicationItem,
  ApplicationItemStatus,
  ApplicationView as ApplicationViewPayload,
  FindingTone,
} from "@/server/views/application";

import {
  ConfirmRemoveButton,
  ReuseSwitch,
} from "./shared/applicationArtifacts";
import { AuthorMark } from "./shared/AuthorMark";

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

const LinkOut = styled.a`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.accent};
  align-self: center;
`;

// The outline is the page's one piece of live state: this box holds a change
// Hank hasn't been told about. Nothing else on the card may use the accent
// colour, and the border is the whole treatment — the same one the board and
// the discovery list draw, so it reads identically wherever it's met.
const Item = styled.section<{ $pending: boolean }>`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => theme.space.lg};
  border: 1px solid
    ${({ theme, $pending }) =>
      $pending ? theme.colors.accent : theme.colors.border};
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

const StockHeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

// The one control on this page whose whole job is "explain yourself" — a plain
// round glyph, quiet until you want it.
const InfoDot = styled.button`
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
  padding: 4px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: transparent;
  border-radius: 999px;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
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

// One finding, sitting against the text it's about. The rewrite loop couldn't
// settle it, because settling it means knowing something about the user that
// isn't on the page.
//
// An `answered` one goes quiet rather than disappearing: the user is editing
// the very words it objects to, and having the reason for the edit vanish
// mid-keystroke is worse than reading a note that's already been dealt with. It
// clears when their next message carries it to Hank.
const Finding = styled.div<{ $tone: FindingTone }>`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-left: 2px solid
    ${({ theme, $tone }) =>
      $tone === "note" ? theme.colors.danger : theme.colors.border};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 12px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.textMuted};
  opacity: ${({ $tone }) => ($tone === "answered" ? 0.55 : 1)};
`;

const FindingMark = styled.span<{ $tone: FindingTone }>`
  color: ${({ theme, $tone }) =>
    $tone === "note" ? theme.colors.danger : theme.colors.textSubtle};
  flex-shrink: 0;
`;

// What the muted state says out loud, so "faded" isn't the only signal.
const FindingState = styled.span`
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const FINDING_MARK: Record<FindingTone, string> = {
  question: "?",
  note: "!",
  answered: "✓",
};

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
  const readOnly = !!useChatStore((s) => s.impersonateSessionId);

  // A stock field with an answer saved against it keeps its editor in the main
  // list — the verdict says nobody needs to DRAFT it, not that the text it
  // already holds should be tucked away. Filed by what Hank last saw, so an
  // unsent change never moves a row out from under the cursor.
  const toWrite: ApplicationItem[] = [];
  const fillInYourself: ApplicationItem[] = [];
  for (const item of application.items) {
    (wasStockItem(item) ? fillInYourself : toWrite).push(item);
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
        {!readOnly && (
          <ActionRow>
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
//
// The header names the group and stops. WHY they're here is a sentence about a
// judgement someone made, which is worth reading once and not on every visit —
// so it sits behind the ⓘ rather than under the title.
function StockFields({ items }: { items: ApplicationItem[] }) {
  const [open, setOpen] = useState(false);
  const [explaining, setExplaining] = useState(false);
  return (
    <StockSection>
      <StockHeaderRow>
        <StockHeader onClick={() => setOpen((o) => !o)}>
          <StockCaret $open={open}>▶</StockCaret>
          <StockTitle>The rest of the form</StockTitle>
          <StockCount>{items.length}</StockCount>
        </StockHeader>
        {/* Tap, not hover: a hover tooltip is 1.5s away on a desktop and
            unreachable on a phone. */}
        <InfoDot
          onClick={() => setExplaining((e) => !e)}
          aria-expanded={explaining}
          aria-label="Why are these here?"
        >
          ⓘ
        </InfoDot>
      </StockHeaderRow>
      {explaining && (
        <SubLabel>
          These came off the application form. Hank read them as quick factual
          fields — your name, links, work authorization — so he left them for
          you to fill in on the posting rather than drafting them.
        </SubLabel>
      )}
      {open &&
        items.map((item) => (
          <StockRow key={item.id}>
            {item.label}
            {item.required && <SubLabel>Required</SubLabel>}
          </StockRow>
        ))}
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

// The rename endpoint names the reason it refused; say it in the user's terms.
// Anything else is a genuine failure and reads as one.
async function renameProblem(res: Response): Promise<string> {
  const reason = await res
    .json()
    .then((body: unknown) =>
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : "",
    )
    .catch(() => "");
  if (reason === "duplicate") return "The form already asks that one.";
  if (reason === "not_yours") {
    return "Someone else described this one, so its wording isn't yours to change.";
  }
  return "Couldn't save that just now.";
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
  const [renameError, setRenameError] = useState<string | null>(null);
  // Escape has to reach the commit that the blur it causes would otherwise run.
  // A ref, not state: blur fires before a setState lands.
  const abandonRename = useRef(false);

  function cancelRename() {
    abandonRename.current = true;
    setRenamingLabel(false);
    setRenameError(null);
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
  //
  // Committed by leaving the field, the way editing in place works everywhere:
  // whatever is in the box when you look away is what it says. There is nothing
  // to confirm, so there is no Save — and nothing is refused, so there is no
  // error for a no-op. Blanking it isn't a rename (a question needs words), so
  // that puts the old wording back rather than rejecting the edit.
  async function commitRename() {
    if (abandonRename.current) {
      abandonRename.current = false;
      return;
    }
    if (renaming) return;
    const next = label.trim();
    if (!next || next === item.label) {
      setLabel(item.label);
      setRenamingLabel(false);
      setRenameError(null);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/application`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, question: next }),
      });
      if (!res.ok) {
        // Stay in the editor holding their words: the wording they typed is the
        // only copy of it, and closing the box would throw it away to show an
        // error about it.
        setRenameError(await renameProblem(res));
        return;
      }
      // A rename changes the item's id, so this card is about to be replaced
      // by one keyed to the new question. Disarm first: the blur that unmount
      // may fire would otherwise re-PUT the new wording at the old id.
      abandonRename.current = true;
      replaceViewedApplication((await res.json()) as ApplicationViewPayload);
      setRenamingLabel(false);
    } catch {
      setRenameError("Couldn't save that just now.");
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
  return (
    <Item $pending={item.pending}>
      <ItemHead>
        <ItemLabel>
          {renamingLabel ? (
            <RenameRow>
              <AddInput
                autoFocus
                value={label}
                disabled={renaming}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  // Enter and clicking away are the same gesture — blur, and
                  // let the one commit path run.
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") cancelRename();
                }}
              />
              {renaming && <SubLabel>saving…</SubLabel>}
              {renameError && <Tag $tone="danger">{renameError}</Tag>}
            </RenameRow>
          ) : item.addedByYou && !readOnly ? (
            <EditableLabel
              onClick={() => {
                // Opening always re-arms, so a flag left set by an Escape whose
                // blur never fired can't swallow the next edit.
                abandonRename.current = false;
                setRenamingLabel(true);
              }}
              title="Click to reword this question"
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
              title="Remove this question — it isn't one the form asks"
              prompt="Remove it and its answer?"
            />
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
        <Finding key={finding.note} $tone={finding.tone}>
          <FindingMark $tone={finding.tone}>
            {FINDING_MARK[finding.tone]}
          </FindingMark>
          <span>{finding.note}</span>
          {finding.tone === "answered" && (
            <FindingState title="Your change answers this. It clears when your next message reaches Hank.">
              answered
            </FindingState>
          )}
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

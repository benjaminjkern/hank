"use client";

import Link from "next/link";
import { createContext, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styled from "styled-components";

import { money } from "@/utils/format";
import { isRecord, isScalar } from "@/utils/guards";
import { prettyJson, tryParseJson } from "@/utils/json";

import type {
  LlmCallInfo,
  RunItem,
  RunTree,
  SubAgentNode,
  ToolCallNode,
} from "../types";

// ---- view mode ----------------------------------------------------------

type ViewMode = "cleaned" | "raw";
const ModeCtx = createContext<ViewMode>("cleaned");
const useMode = () => useContext(ModeCtx);

// ---- layout primitives --------------------------------------------------

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xl};
  font-family: ${({ theme }) => theme.font.body};
`;
const Container = styled.div`
  max-width: 1000px;
  margin: 0 auto;
`;
const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space.md};
  margin-bottom: ${({ theme }) => theme.space.md};
`;
const H1 = styled.h1`
  font-size: 18px;
  font-weight: 600;
  margin: 0;
`;
const HeaderRight = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`;
const BackLink = styled(Link)`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  white-space: nowrap;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;
const Toggle = styled.div`
  display: inline-flex;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  overflow: hidden;
`;
const ToggleBtn = styled.button<{ $active: boolean }>`
  font-size: 12px;
  padding: 3px 12px;
  border: none;
  cursor: pointer;
  background: ${({ theme, $active }) =>
    $active ? theme.colors.accent : "transparent"};
  color: ${({ theme, $active }) => ($active ? "#fff" : theme.colors.textMuted)};
  &:hover {
    color: ${({ theme, $active }) => ($active ? "#fff" : theme.colors.text)};
  }
`;
const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space.md};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: ${({ theme }) => theme.space.lg};
`;
const Mono = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
`;
const LegacyBanner = styled.div`
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: ${({ theme }) => theme.space.md};
`;

// ---- raw + copy ---------------------------------------------------------

const Pre = styled.pre`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: ${({ theme }) => theme.space.sm};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  max-height: 460px;
  overflow: auto;
`;
const CopyBtn = styled.button`
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.textMuted};
  background: transparent;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: 1px 6px;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <CopyBtn
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
    >
      {done ? "copied" : "copy"}
    </CopyBtn>
  );
}

const FieldLabel = styled.span`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${({ theme }) => theme.colors.textMuted};
`;
const FieldHead = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 6px 0 3px;
`;

// ---- markdown -----------------------------------------------------------

const Md = styled.div`
  font-size: 13px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.text};
  max-height: 620px;
  overflow: auto;
  padding: ${({ theme }) => theme.space.sm};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};

  & > *:first-child {
    margin-top: 0;
  }
  & > *:last-child {
    margin-bottom: 0;
  }
  p,
  ul,
  ol,
  blockquote,
  table {
    margin: 0 0 0.6em;
  }
  h1,
  h2,
  h3,
  h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0.9em 0 0.35em;
    color: ${({ theme }) => theme.colors.text};
  }
  h1 {
    font-size: 15px;
  }
  h2 {
    font-size: 14px;
  }
  ul,
  ol {
    padding-left: 1.3em;
  }
  li {
    margin: 0.15em 0;
  }
  code {
    font-family: ${({ theme }) => theme.font.mono};
    font-size: 11.5px;
    background: ${({ theme }) => theme.colors.bgPanel};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: 3px;
    padding: 0 4px;
  }
  pre {
    background: ${({ theme }) => theme.colors.bgPanel};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    padding: ${({ theme }) => theme.space.sm};
    overflow: auto;
  }
  pre code {
    border: none;
    background: none;
    padding: 0;
  }
  blockquote {
    border-left: 3px solid ${({ theme }) => theme.colors.border};
    padding-left: ${({ theme }) => theme.space.md};
    color: ${({ theme }) => theme.colors.textMuted};
  }
  a {
    color: ${({ theme }) => theme.colors.accent};
  }
  table {
    border-collapse: collapse;
  }
  th,
  td {
    border: 1px solid ${({ theme }) => theme.colors.border};
    padding: 3px 8px;
    text-align: left;
  }
  hr {
    border: none;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
    margin: 0.8em 0;
  }
`;

function Markdown({ children }: { children: string }) {
  return (
    <Md>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </Md>
  );
}

// ---- cleaned value (key-value tables, lists, chips, markdown) -----------

const KVTable = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  overflow: hidden;
`;
const KVRow = styled.div`
  display: grid;
  grid-template-columns: minmax(90px, 22%) 1fr;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  &:first-child {
    border-top: none;
  }
`;
const KVKey = styled.div`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textMuted};
  padding: 6px 8px;
  background: ${({ theme }) => theme.colors.bg};
  border-right: 1px solid ${({ theme }) => theme.colors.border};
  word-break: break-word;
`;
const KVVal = styled.div`
  padding: 6px 8px;
  min-width: 0;
  font-size: 12.5px;
`;
const ScalarVal = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  word-break: break-word;
`;
const MutedVal = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-style: italic;
  font-size: 12px;
`;
const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;
const ValChip = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11px;
  padding: 1px 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
`;
const List = styled.ol`
  margin: 0;
  padding-left: 1.2em;
  & > li {
    margin: 4px 0;
  }
`;

function CleanedValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}): React.ReactElement {
  if (value == null) return <MutedVal>—</MutedVal>;
  if (typeof value === "string") {
    if (value.trim() === "") return <MutedVal>(empty)</MutedVal>;
    const parsed = tryParseJson(value);
    if (parsed !== undefined)
      return <CleanedValue value={parsed} depth={depth} />;
    return <Markdown>{value}</Markdown>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <ScalarVal>{String(value)}</ScalarVal>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <MutedVal>[]</MutedVal>;
    if (value.every(isScalar)) {
      return (
        <ChipRow>
          {value.map((v, i) => (
            <ValChip key={i}>{v == null ? "null" : String(v)}</ValChip>
          ))}
        </ChipRow>
      );
    }
    if (depth > 5) return <Pre>{prettyJson(value)}</Pre>;
    return (
      <List>
        {value.map((v, i) => (
          <li key={i}>
            <CleanedValue value={v} depth={depth + 1} />
          </li>
        ))}
      </List>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <MutedVal>{"{}"}</MutedVal>;
    if (depth > 5) return <Pre>{prettyJson(value)}</Pre>;
    return (
      <KVTable>
        {entries.map(([k, v]) => (
          <KVRow key={k}>
            <KVKey>{k}</KVKey>
            <KVVal>
              <CleanedValue value={v} depth={depth + 1} />
            </KVVal>
          </KVRow>
        ))}
      </KVTable>
    );
  }
  return <ScalarVal>{String(value)}</ScalarVal>;
}

// A labeled field: copy always yields the raw bytes; the body is mode-aware
// (raw → JSON in a <Pre>; cleaned → visual CleanedValue).
function Field({ label, value }: { label?: string; value: unknown }) {
  const mode = useMode();
  const text = prettyJson(value);
  return (
    <div>
      <FieldHead>
        <FieldLabel>{label}</FieldLabel>
        <Copy text={text} />
      </FieldHead>
      {mode === "raw" ? <Pre>{text}</Pre> : <CleanedValue value={value} />}
    </div>
  );
}

// ---- collapsible node ---------------------------------------------------

const NodeBox = styled.div<{ $tone?: "turn" | "tool" | "sub" | "plain" }>`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 3px solid
    ${({ theme, $tone }) =>
      $tone === "turn"
        ? theme.colors.accent
        : $tone === "tool"
          ? theme.colors.success
          : $tone === "sub"
            ? theme.colors.accentHover
            : theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgPanel};
  margin: ${({ theme }) => theme.space.sm} 0;
`;
const NodeHead = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  text-align: left;
  font-size: 13px;
`;
const Caret = styled.span<{ $open: boolean }>`
  color: ${({ theme }) => theme.colors.textMuted};
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s;
  font-size: 10px;
`;
const NodeTitle = styled.span`
  font-weight: 600;
`;
const NodeSub = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 11px;
`;
const NodeBody = styled.div`
  padding: 0 ${({ theme }) => theme.space.md} ${({ theme }) => theme.space.md};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;
const Badge = styled.span<{ $err?: boolean }>`
  font-size: 10px;
  padding: 1px 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme, $err }) =>
    $err ? theme.colors.danger : theme.colors.textMuted};
`;

function Node({
  title,
  sub,
  tone = "plain",
  defaultOpen = false,
  right,
  children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "turn" | "tool" | "sub" | "plain";
  defaultOpen?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <NodeBox $tone={tone}>
      <NodeHead onClick={() => setOpen((v) => !v)}>
        <Caret $open={open}>▶</Caret>
        <NodeTitle>{title}</NodeTitle>
        {sub && <NodeSub>{sub}</NodeSub>}
        <span style={{ marginLeft: "auto" }}>{right}</span>
      </NodeHead>
      {open && <NodeBody>{children}</NodeBody>}
    </NodeBox>
  );
}

// ---- assistant content (cleaned = per-block; raw = the JSON array) -------

const Thinking = styled.div`
  border-left: 2px solid ${({ theme }) => theme.colors.border};
  padding-left: ${({ theme }) => theme.space.sm};
`;
const ThinkingLabel = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: 2px;
`;
const ToolUseChip = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-family: ${({ theme }) => theme.font.mono};
`;

function AssistantContent({ blocks }: { blocks: unknown[] }) {
  const mode = useMode();
  if (mode === "raw") {
    return (
      <Field
        label="assistant content (thinking / text / tool_use)"
        value={blocks}
      />
    );
  }
  return (
    <div>
      <FieldHead>
        <FieldLabel>assistant content</FieldLabel>
        <Copy text={prettyJson(blocks)} />
      </FieldHead>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((b, i) => {
          if (!isRecord(b)) return <CleanedValue key={i} value={b} />;
          if (b.type === "text" && typeof b.text === "string") {
            return <Markdown key={i}>{b.text}</Markdown>;
          }
          if (b.type === "thinking" && typeof b.thinking === "string") {
            return (
              <Thinking key={i}>
                <ThinkingLabel>thinking</ThinkingLabel>
                <Markdown>{b.thinking}</Markdown>
              </Thinking>
            );
          }
          if (b.type === "redacted_thinking") {
            return (
              <Thinking key={i}>
                <ThinkingLabel>thinking (redacted)</ThinkingLabel>
              </Thinking>
            );
          }
          if (b.type === "tool_use") {
            return (
              <ToolUseChip key={i}>
                → called <code>{String(b.name)}</code> (details below)
              </ToolUseChip>
            );
          }
          return <CleanedValue key={i} value={b} />;
        })}
      </div>
    </div>
  );
}

// ---- domain nodes -------------------------------------------------------

function SystemPromptNode({ llm }: { llm: LlmCallInfo }) {
  const sp = llm.systemPrompt;
  if (!sp) return null;
  const full = [
    sp.skeleton ?? "(skeleton unavailable)",
    ...sp.volatile.map((v) => v.text),
  ].join("\n\n");
  return (
    <Node
      title="System prompt"
      sub={sp.hash ? `#${sp.hash.slice(0, 8)}` : ""}
      right={<Copy text={full} />}
    >
      {sp.skeleton != null && (
        <Field label="skeleton (deduped)" value={sp.skeleton} />
      )}
      {sp.volatile.map((v) => (
        <Field key={v.key} label={`volatile · ${v.key}`} value={v.text} />
      ))}
      {sp.skeleton == null && sp.volatile.length === 0 && (
        <NodeSub>No system-prompt capture for this turn.</NodeSub>
      )}
    </Node>
  );
}

function SubAgentNodeView({ s }: { s: SubAgentNode }) {
  return (
    <Node
      tone="sub"
      title={`sub-agent · ${s.operation}`}
      sub={`${s.klass} · ${s.model}${s.turns != null ? ` · ${s.turns} turns` : ""}`}
      right={<Badge $err={!s.ok}>{s.ok ? "ok" : "failed"}</Badge>}
    >
      {s.outputSchemaName && (
        <NodeSub>output schema: {s.outputSchemaName}</NodeSub>
      )}
      <Field label="input (system + initial content)" value={s.input} />
      {s.output != null && (
        <Field label="output (structured)" value={s.output} />
      )}
      {s.error && <Field label="error" value={s.error} />}
    </Node>
  );
}

function ToolCallNodeView({ t }: { t: ToolCallNode }) {
  const traceObj = t.trace && typeof t.trace === "object" ? t.trace : null;
  const hasTrace =
    !!traceObj &&
    Array.isArray((traceObj as { steps?: unknown }).steps) &&
    (traceObj as { steps: unknown[] }).steps.length > 0;
  return (
    <Node
      tone="tool"
      title={<Mono>{t.name}</Mono>}
      sub={t.toolUseId ? `#${t.toolUseId.slice(0, 8)}` : ""}
      right={
        <>
          {t.subAgents.length > 0 && (
            <Badge>
              {t.subAgents.length} sub-agent
              {t.subAgents.length === 1 ? "" : "s"}
            </Badge>
          )}
          {t.isError && <Badge $err>error</Badge>}
        </>
      }
    >
      <Field label="input" value={t.input} />
      <Field label="output" value={t.result ?? "(no result — interrupted?)"} />
      {hasTrace && <Field label="sub-agent interior (trace)" value={t.trace} />}
      {t.subAgents.map((s) => (
        <SubAgentNodeView key={s.id} s={s} />
      ))}
    </Node>
  );
}

// Request params minus the system prompt (shown in its own node).
function paramsForDisplay(llm: LlmCallInfo): unknown {
  const rp =
    llm.requestParams && typeof llm.requestParams === "object"
      ? { ...(llm.requestParams as Record<string, unknown>) }
      : {};
  delete (rp as Record<string, unknown>).systemPrompt;
  return { model: llm.model, ...rp };
}

function TurnNode({
  item,
  index,
}: {
  item: Extract<RunItem, { kind: "turn" }>;
  index: number;
}) {
  const llm = item.llm;
  return (
    <Node
      tone="turn"
      defaultOpen
      title={`Turn ${item.turnIndex ?? index}`}
      sub={llm ? `${llm.model}` : "(no usage captured)"}
      right={
        <>
          {item.stoppedByUser && <Badge $err>interrupted</Badge>}
          {llm && <Badge>{money(llm.usage.cost)}</Badge>}
        </>
      }
    >
      {llm && (
        <>
          <Field label="request params" value={paramsForDisplay(llm)} />
          <SystemPromptNode llm={llm} />
          <Field
            label="usage"
            value={{
              input: llm.usage.input,
              output: llm.usage.output,
              cacheCreate: llm.usage.cacheCreate,
              cacheRead: llm.usage.cacheRead,
              cost: money(llm.usage.cost),
              notes: llm.notes,
            }}
          />
        </>
      )}
      <AssistantContent blocks={item.content} />
      {item.toolCalls.map((t) => (
        <ToolCallNodeView key={t.toolUseId || t.name} t={t} />
      ))}
    </Node>
  );
}

// ---- run-level rendering ------------------------------------------------

const UserBubble = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.bgFocused};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  margin: ${({ theme }) => theme.space.sm} 0;
  font-size: 13px;
  word-break: break-word;
`;
const StatusLine = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-style: italic;
  padding: ${({ theme }) => theme.space.xs} ${({ theme }) => theme.space.md};
`;
const SectionLabel = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${({ theme }) => theme.colors.textMuted};
  margin: ${({ theme }) => theme.space.lg} 0 ${({ theme }) => theme.space.xs};
`;

function UserItem({ item }: { item: Extract<RunItem, { kind: "user" }> }) {
  const mode = useMode();
  if (!item.text)
    return (
      <UserBubble>
        <em>(no text — attachment-only)</em>
      </UserBubble>
    );
  return (
    <UserBubble>
      {mode === "cleaned" ? <Markdown>{item.text}</Markdown> : item.text}
    </UserBubble>
  );
}

export function RunTreeView({ tree }: { tree: RunTree }) {
  const [mode, setMode] = useState<ViewMode>("cleaned");
  let turnCounter = 0;
  return (
    <ModeCtx.Provider value={mode}>
      <Page>
        <Container>
          <Header>
            <H1>Run tree</H1>
            <HeaderRight>
              <Toggle>
                <ToggleBtn
                  $active={mode === "cleaned"}
                  onClick={() => setMode("cleaned")}
                >
                  Cleaned
                </ToggleBtn>
                <ToggleBtn
                  $active={mode === "raw"}
                  onClick={() => setMode("raw")}
                >
                  Raw
                </ToggleBtn>
              </Toggle>
              <BackLink href="/admin/runs">← Runs</BackLink>
            </HeaderRight>
          </Header>
          <Meta>
            <span>
              run <Mono>{tree.runId.slice(0, 16)}…</Mono>
            </span>
            <span>
              <Link href={`/admin/session/${tree.sessionId}`}>
                session <Mono>{tree.sessionId.slice(0, 8)}…</Mono>
              </Link>
            </span>
            <span>{tree.userEmail ?? tree.userId ?? "—"}</span>
            <span>{new Date(tree.createdAt).toLocaleString()}</span>
            <span>{tree.turnCount} turns</span>
            <span>{money(tree.cost)}</span>
          </Meta>

          {tree.legacy && (
            <LegacyBanner>
              Pre-capture run — reconstructed from ChatMessage rows without
              run-tree instrumentation. Model params, system prompt, and
              per-tool sub-agent linkage were not captured; sub-agent runs below
              are correlated by session + time and may be approximate.
            </LegacyBanner>
          )}

          {tree.items.map((item) => {
            if (item.kind === "user")
              return <UserItem key={item.id} item={item} />;
            if (item.kind === "status")
              return <StatusLine key={item.id}>{item.text}</StatusLine>;
            if (item.kind === "error") {
              return (
                <Node
                  key={item.id}
                  title="run failed"
                  sub="threw — nothing after this ran"
                >
                  <Field label="error" value={item.detail} />
                </Node>
              );
            }
            if (item.kind === "widget") {
              return (
                <Node
                  key={item.id}
                  title={`widget · ${item.widgetKind}`}
                  sub="deterministic UI"
                >
                  <Field label="payload" value={item.payload} />
                </Node>
              );
            }
            const idx = turnCounter++;
            return <TurnNode key={item.id} item={item} index={idx} />;
          })}

          {tree.orphanSubAgents.length > 0 && (
            <>
              <SectionLabel>
                Sub-agents not linked to a tool call
                {tree.legacy ? "" : " (deterministic flow paths)"}
              </SectionLabel>
              {tree.orphanSubAgents.map((s) => (
                <SubAgentNodeView key={s.id} s={s} />
              ))}
            </>
          )}
        </Container>
      </Page>
    </ModeCtx.Provider>
  );
}

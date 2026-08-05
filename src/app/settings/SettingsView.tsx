"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import styled from "styled-components";

import { relativeTime } from "@/utils/date";
import { initial } from "@/utils/text";

import {
  saveApiKey,
  clearApiKey,
  saveDeepseekKey,
  clearDeepseekKey,
  type SaveApiKeyResult,
} from "./actions";

type KeyInfo = {
  hint: string | null;
  updatedAt: string | null;
  canUseServerKey: boolean;
};

type Props = {
  identity: {
    name: string | null;
    email: string | null;
    image: string | null;
  };
  anthropicKey: KeyInfo;
  deepseekKey: KeyInfo;
};

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;

const Container = styled.div`
  max-width: 640px;
  margin: 0 auto;
`;

const Header = styled.header`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: ${({ theme }) => theme.space.xl};
`;

const H1 = styled.h1`
  font-size: 22px;
  font-weight: 600;
  margin: 0;
`;

const BackLink = styled(Link)`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

const Section = styled.section`
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const SectionTitle = styled.h2`
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 ${({ theme }) => theme.space.md};
`;

const Identity = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
`;

const Avatar = styled.div`
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.bgMuted};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

const IdentityText = styled.div`
  display: flex;
  flex-direction: column;
`;

const IdentityName = styled.div`
  font-size: 14px;
  font-weight: 600;
`;

const IdentityEmail = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const KeyStatus = styled.div`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  margin-bottom: ${({ theme }) => theme.space.sm};
`;

const KeyHint = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  background: ${({ theme }) => theme.colors.bgMuted};
  padding: 1px 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
`;

const Updated = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-bottom: ${({ theme }) => theme.space.md};
`;

const ServerKeyNote = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  margin-top: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => theme.space.sm};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
  line-height: 1.5;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const Label = styled.label`
  font-size: 12px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Input = styled.input`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 13px;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.text};
  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
`;

const Hint = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.colors.textSubtle};
`;

const Actions = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  margin-top: ${({ theme }) => theme.space.sm};
`;

const Button = styled.button<{ $variant?: "primary" | "danger" | "ghost" }>`
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-radius: ${({ theme }) => theme.radius.sm};
  cursor: pointer;
  border: 1px solid
    ${({ theme, $variant }) =>
      $variant === "danger"
        ? theme.colors.danger
        : $variant === "ghost"
          ? theme.colors.border
          : "transparent"};
  background: ${({ theme, $variant }) =>
    $variant === "danger"
      ? "transparent"
      : $variant === "ghost"
        ? theme.colors.bgMuted
        : theme.colors.accent};
  color: ${({ theme, $variant }) =>
    $variant === "danger"
      ? theme.colors.danger
      : $variant === "ghost"
        ? theme.colors.text
        : theme.colors.onAccent};
  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
`;

const ErrorText = styled.div`
  color: ${({ theme }) => theme.colors.danger};
  font-size: 12px;
  margin-top: ${({ theme }) => theme.space.xs};
`;

const SuccessText = styled.div`
  color: ${({ theme }) => theme.colors.success};
  font-size: 12px;
  margin-top: ${({ theme }) => theme.space.xs};
`;

function ApiKeySection({
  title,
  idBase,
  keyInfo,
  inputLabel,
  placeholder,
  hint,
  serverKeyNote,
  onSave,
  onClear,
}: {
  title: string;
  idBase: string;
  keyInfo: KeyInfo;
  inputLabel: string;
  placeholder: string;
  hint: React.ReactNode;
  serverKeyNote: React.ReactNode | null;
  onSave: (fd: FormData) => Promise<SaveApiKeyResult>;
  onClear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(!keyInfo.hint);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  async function onSubmit(formData: FormData) {
    setError(null);
    setSaved(false);
    const result = await onSave(formData);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(true);
    setEditing(false);
    setPasted("");
  }

  async function handleClear() {
    setError(null);
    setSaved(false);
    await onClear();
    setEditing(true);
  }

  return (
    <Section>
      <SectionTitle>{title}</SectionTitle>

      {keyInfo.hint && !editing ? (
        <>
          <KeyStatus>
            Key set: <KeyHint>sk-…{keyInfo.hint}</KeyHint>
          </KeyStatus>
          {keyInfo.updatedAt ? (
            <Updated>Updated {relativeTime(keyInfo.updatedAt)}</Updated>
          ) : null}
          <Actions>
            <Button
              type="button"
              $variant="ghost"
              onClick={() => {
                setEditing(true);
                setSaved(false);
              }}
            >
              Replace
            </Button>
            <Button
              type="button"
              $variant="danger"
              onClick={() => startTransition(() => void handleClear())}
              disabled={pending}
            >
              Remove
            </Button>
          </Actions>
          {saved && <SuccessText>Key saved.</SuccessText>}
        </>
      ) : (
        <Form action={(fd) => startTransition(() => void onSubmit(fd))}>
          <Label htmlFor={`apiKey-${idBase}`}>{inputLabel}</Label>
          <Input
            id={`apiKey-${idBase}`}
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            disabled={pending}
          />
          <Hint>{hint}</Hint>
          <Actions>
            <Button type="submit" disabled={pending || !pasted.trim()}>
              {pending ? "Validating…" : "Save"}
            </Button>
            {keyInfo.hint ? (
              <Button
                type="button"
                $variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setPasted("");
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            ) : null}
          </Actions>
          {error && <ErrorText>{error}</ErrorText>}
        </Form>
      )}

      {serverKeyNote}
    </Section>
  );
}

export function SettingsView({ identity, anthropicKey, deepseekKey }: Props) {
  return (
    <Page>
      <Container>
        <Header>
          <H1>Settings</H1>
          <BackLink href="/">← Back to Hank</BackLink>
        </Header>

        <Section>
          <SectionTitle>Account</SectionTitle>
          <Identity>
            <Avatar>
              {identity.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={identity.image} alt="" />
              ) : (
                initial(identity.name || identity.email || "?")
              )}
            </Avatar>
            <IdentityText>
              {identity.name ? (
                <IdentityName>{identity.name}</IdentityName>
              ) : null}
              {identity.email ? (
                <IdentityEmail>{identity.email}</IdentityEmail>
              ) : null}
            </IdentityText>
          </Identity>
        </Section>

        <ApiKeySection
          title="DeepSeek API key"
          idBase="deepseek"
          keyInfo={deepseekKey}
          inputLabel="Paste a DeepSeek API key"
          placeholder="sk-..."
          hint={
            <>
              Powers chat and every background task — Hank needs this to run.
              Get one at platform.deepseek.com → API Keys. Encrypted at rest,
              never logged.
            </>
          }
          serverKeyNote={
            deepseekKey.canUseServerKey ? (
              <ServerKeyNote>
                Your account may fall back to the server&apos;s DeepSeek key
                when you haven&apos;t set your own. Your own key always wins.
              </ServerKeyNote>
            ) : null
          }
          onSave={saveDeepseekKey}
          onClear={clearDeepseekKey}
        />

        <ApiKeySection
          title="Anthropic API key"
          idBase="anthropic"
          keyInfo={anthropicKey}
          inputLabel="Paste an Anthropic API key"
          placeholder="sk-ant-..."
          hint={
            <>
              Powers résumé parsing and logo vision — PDFs and images DeepSeek
              can&apos;t read. Optional: those features fall back without it.
              Get one at console.anthropic.com → API Keys. Encrypted at rest,
              never logged.
            </>
          }
          serverKeyNote={
            anthropicKey.canUseServerKey ? (
              <ServerKeyNote>
                Your account may fall back to the server&apos;s Anthropic key
                when you haven&apos;t set your own. Your own key always wins.
              </ServerKeyNote>
            ) : null
          }
          onSave={saveApiKey}
          onClear={clearApiKey}
        />
      </Container>
    </Page>
  );
}

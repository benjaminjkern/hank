"use client";

import { useState, useTransition } from "react";
import styled from "styled-components";

import { saveApiKey, saveDeepseekKey } from "@/app/settings/actions";
import { requestAccessAction } from "@/app/settings/requestAccess";
import { useChatStore, type ApiKeyBlockerReason } from "@/lib/chatStore";

// Full-viewport hard-blocking modal. Six trigger reasons across two providers
// map to their own headline + body copy; the inline paste form saves to the
// matching provider (DeepSeek for the three deepseek reasons — the primary chat
// key — Anthropic for the three vision reasons that arrive via the résumé
// route). On a successful save the chat session is refetched (so the server-side
// hasKey flags flip too) and the blocker is cleared, which unmounts this overlay.
//
// When the instance disallows own keys (`allowUserApiKeys=false`), pasting is
// not a way out of this modal, so the form is replaced by a request-access
// button. That is the ONLY route in on an invite-gated deployment — a modal
// that just says "add a key" there is a dead end the user can't act on.
const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.space.xl};
  z-index: 1000;
  backdrop-filter: blur(2px);
`;

const Card = styled.div`
  width: 100%;
  max-width: 480px;
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.xl};
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.md};
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
`;

const Title = styled.h2`
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text};
`;

const Body = styled.p`
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: ${({ theme }) => theme.colors.textMuted};
  a {
    color: ${({ theme }) => theme.colors.accent};
    text-decoration: underline;
  }
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
  margin-top: ${({ theme }) => theme.space.xs};
`;

const Submit = styled.button`
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.md}`};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.onAccent};
  border: 1px solid transparent;
  cursor: pointer;
  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
`;

const ErrorText = styled.div`
  color: ${({ theme }) => theme.colors.danger};
  font-size: 12px;
`;

const SecondaryLink = styled.a`
  font-size: 12px;
  font-weight: 500;
  align-self: flex-start;
  margin-top: ${({ theme }) => theme.space.xs};
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: underline;
  &:hover {
    color: ${({ theme }) => theme.colors.text};
  }
`;

type Copy = { title: string; body: React.ReactNode };

function copyFor(reason: ApiKeyBlockerReason): Copy {
  switch (reason) {
    case "missing":
      return {
        title: "Add your Anthropic API key",
        body: (
          <>
            Hank needs an Anthropic API key to run. Paste yours below — get one
            at{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com
            </a>
            . The key is encrypted at rest and never logged.
          </>
        ),
      };
    case "invalid":
      return {
        title: "Anthropic rejected your API key",
        body: (
          <>
            The saved key didn&apos;t authenticate — it may have been revoked or
            rotated. Paste a current one to keep chatting.
          </>
        ),
      };
    case "no_credit":
      return {
        title: "Anthropic credit balance is too low",
        body: (
          <>
            Anthropic rejected the request because the account tied to this key
            is out of credit. Top up at{" "}
            <a
              href="https://console.anthropic.com/settings/billing"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com → Billing
            </a>{" "}
            and retry, or paste a key from a funded account below.
          </>
        ),
      };
    case "missing_deepseek":
      return {
        title: "Add your DeepSeek API key",
        body: (
          <>
            Hank runs on DeepSeek. Paste your DeepSeek key below — get one at{" "}
            <a
              href="https://platform.deepseek.com/api_keys"
              target="_blank"
              rel="noreferrer"
            >
              platform.deepseek.com
            </a>
            . The key is encrypted at rest and never logged.
          </>
        ),
      };
    case "invalid_deepseek":
      return {
        title: "DeepSeek rejected your API key",
        body: (
          <>
            The saved key didn&apos;t authenticate — it may have been revoked or
            rotated. Paste a current one to keep chatting.
          </>
        ),
      };
    case "deepseek_no_credit":
      return {
        title: "DeepSeek balance is too low",
        body: (
          <>
            DeepSeek rejected the request because the account tied to this key
            is out of balance. Top up at{" "}
            <a
              href="https://platform.deepseek.com/top_up"
              target="_blank"
              rel="noreferrer"
            >
              platform.deepseek.com
            </a>{" "}
            and retry, or paste a key from a funded account below.
          </>
        ),
      };
  }
}

export function ApiKeyBlockerModal({
  allowUserApiKeys,
}: {
  allowUserApiKeys: boolean;
}) {
  const reason = useChatStore((s) => s.apiKeyBlocker);
  const setApiKeyBlocker = useChatStore((s) => s.setApiKeyBlocker);
  const refetchSession = useChatStore((s) => s.refetchSession);

  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requestState, setRequestState] = useState<"idle" | "sent" | "pending">(
    "idle",
  );
  const [pending, startTransition] = useTransition();

  if (!reason) return null;
  const { title, body } = copyFor(reason);
  // Which provider this block belongs to. The three deepseek reasons save the
  // DeepSeek key (the primary chat credential); the three Anthropic reasons
  // (vision, surfaced via the résumé route) save the Anthropic key. Both are
  // paste-fixable in-modal.
  const isDeepseek =
    reason === "missing_deepseek" ||
    reason === "invalid_deepseek" ||
    reason === "deepseek_no_credit";
  const providerLabel = isDeepseek ? "DeepSeek" : "Anthropic";

  // With own keys disallowed there is no key to paste, so the modal splits by
  // WHOSE key is at fault. "Missing" means this account was never granted the
  // server key — the user can ask for it. Invalid / no-credit means the
  // server's own key is broken, which no user action fixes.
  const notGranted =
    !allowUserApiKeys &&
    (reason === "missing" || reason === "missing_deepseek");
  const serverKeyFaulty = !allowUserApiKeys && !notGranted;

  async function onRequestAccess() {
    setError(null);
    const result = await requestAccessAction();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRequestState(result.alreadyPending ? "pending" : "sent");
  }

  async function onSubmit(formData: FormData) {
    setError(null);
    const result = isDeepseek
      ? await saveDeepseekKey(formData)
      : await saveApiKey(formData);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Pull the fresh session (so the hasKey flags flip server-side too) before
    // dismissing — avoids a one-render flash where the modal closes but the
    // composer is still flagged !canChat.
    await refetchSession();
    setPasted("");
    setApiKeyBlocker(null);
  }

  return (
    <Backdrop
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-key-modal-title"
    >
      <Card>
        <Title id="api-key-modal-title">
          {notGranted
            ? "Your account needs access"
            : serverKeyFaulty
              ? "Hank is temporarily unavailable"
              : title}
        </Title>
        <Body>
          {notGranted ? (
            <>
              This instance runs on its own API key, and your account
              hasn&apos;t been given access to it yet. Send a request and
              you&apos;ll be able to start once it&apos;s approved.
            </>
          ) : serverKeyFaulty ? (
            <>
              The API key this instance runs on isn&apos;t working right now —
              it may have been revoked or run out of credit. Nothing to do on
              your end; the person running this instance needs to sort it out.
            </>
          ) : (
            body
          )}
        </Body>
        {notGranted ? (
          <>
            {requestState === "idle" ? (
              <Actions>
                <Submit
                  type="button"
                  disabled={pending}
                  onClick={() => startTransition(() => void onRequestAccess())}
                >
                  {pending ? "Sending…" : "Request access"}
                </Submit>
              </Actions>
            ) : (
              <Hint>
                {requestState === "sent"
                  ? "Request sent. You'll be able to chat once it's approved — no need to ask again."
                  : "Your earlier request is still waiting. You'll be able to chat once it's approved."}
              </Hint>
            )}
            {error && <ErrorText>{error}</ErrorText>}
          </>
        ) : serverKeyFaulty ? null : (
          <Form action={(fd) => startTransition(() => void onSubmit(fd))}>
            <Label htmlFor="api-key-modal-input">{providerLabel} API key</Label>
            <Input
              id="api-key-modal-input"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={isDeepseek ? "sk-..." : "sk-ant-..."}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              disabled={pending}
              autoFocus
            />
            <Hint>Validated against {providerLabel} before saving.</Hint>
            <Actions>
              <Submit type="submit" disabled={pending || !pasted.trim()}>
                {pending ? "Validating…" : "Save and continue"}
              </Submit>
            </Actions>
            {error && <ErrorText>{error}</ErrorText>}
            <SecondaryLink href="/settings">
              Manage keys in Settings
            </SecondaryLink>
          </Form>
        )}
      </Card>
    </Backdrop>
  );
}

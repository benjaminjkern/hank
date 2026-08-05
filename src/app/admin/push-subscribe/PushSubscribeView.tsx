"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import styled from "styled-components";

import { isStandalonePwa } from "@/utils/browser";
import { relativeTime } from "@/utils/date";
import { base64UrlToBytes } from "@/utils/encoding";
import { truncateStart } from "@/utils/text";

type Props = { vapidPublicKey: string };

type Device = {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  lastNotifiedAt: string | null;
};

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "error"; message: string };

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export function PushSubscribeView({ vapidPublicKey }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [mounted, setMounted] = useState(false);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [swSupport, setSwSupport] = useState(false);
  const [pushSupport, setPushSupport] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unknown"
  >("unknown");
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/push-subscribe");
      if (!res.ok) return;
      const body = (await res.json()) as { subscriptions: Device[] };
      setDevices(body.subscriptions);
    } catch {
      // Non-fatal — list just doesn't refresh.
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    setIos(isIos());
    setStandalone(isStandalonePwa());
    setSwSupport("serviceWorker" in navigator);
    setPushSupport("PushManager" in window);
    if (typeof Notification !== "undefined")
      setPermission(Notification.permission);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistration().then(async (reg) => {
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        if (sub) setThisEndpoint(sub.endpoint);
      });
    }
    void refreshDevices();
  }, [refreshDevices]);

  const canSubscribe =
    mounted &&
    swSupport &&
    pushSupport &&
    vapidPublicKey.length > 0 &&
    (!ios || standalone);

  async function subscribe() {
    if (!vapidPublicKey) {
      setStatus({
        kind: "error",
        message: "VAPID_PUBLIC_KEY is not set on the server",
      });
      return;
    }
    try {
      setStatus({ kind: "working", message: "Registering service worker…" });
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      setStatus({
        kind: "working",
        message: "Requesting notification permission…",
      });
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setStatus({ kind: "error", message: `Permission was ${perm}` });
        return;
      }

      setStatus({ kind: "working", message: "Subscribing to push service…" });
      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(vapidPublicKey) as BufferSource,
      });

      setStatus({ kind: "working", message: "Saving subscription…" });
      const res = await fetch("/api/admin/push-subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Save failed (${res.status})`,
        );
      }
      setThisEndpoint(sub.endpoint);
      setStatus({ kind: "idle" });
      await refreshDevices();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function deleteDevice(id: string) {
    try {
      const res = await fetch("/api/admin/push-subscribe", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return;
      await refreshDevices();
    } catch {
      // Non-fatal.
    }
  }

  const [testResult, setTestResult] = useState<string | null>(null);

  async function testPush() {
    setTestResult("sending…");
    try {
      const res = await fetch("/api/admin/push-test", { method: "POST" });
      const body = await res.json();
      setTestResult(JSON.stringify(body, null, 2));
      await refreshDevices();
    } catch (err) {
      setTestResult(
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <Page>
      <Container>
        <Header>
          <H1>Push subscribe</H1>
          <BackLink href="/admin">← Admin</BackLink>
        </Header>

        {!vapidPublicKey && (
          <Warning>
            <strong>Server is missing VAPID_PUBLIC_KEY.</strong> Set the three
            VAPID env vars and restart the dev server before subscribing.
          </Warning>
        )}

        {mounted && ios && !standalone && (
          <Warning>
            <strong>iOS: install as PWA first.</strong> Web Push only works
            inside an installed home-screen app on iOS. In Safari, tap Share →{" "}
            <em>Add to Home Screen</em>, then open the installed Hank icon and
            visit this page again.
          </Warning>
        )}

        <Section>
          <SectionTitle>Status</SectionTitle>
          <Row>
            <Label>Service worker support:</Label>
            <Value>{mounted ? (swSupport ? "yes" : "no") : "…"}</Value>
          </Row>
          <Row>
            <Label>Push API support:</Label>
            <Value>{mounted ? (pushSupport ? "yes" : "no") : "…"}</Value>
          </Row>
          <Row>
            <Label>Notification permission:</Label>
            <Value>{mounted ? permission : "…"}</Value>
          </Row>
          <Row>
            <Label>Display mode:</Label>
            <Value>
              {mounted
                ? standalone
                  ? "standalone (installed)"
                  : "browser tab"
                : "…"}
            </Value>
          </Row>
        </Section>

        <Section>
          <SectionTitle>Subscribe this device</SectionTitle>
          <Hint>
            Generates a push subscription bound to the server&apos;s VAPID key
            and saves it to the database. No env editing or server restart
            required.
          </Hint>
          <Button
            onClick={subscribe}
            disabled={!canSubscribe || status.kind === "working"}
          >
            {status.kind === "working" ? status.message : "Subscribe"}
          </Button>
          {status.kind === "error" && <ErrorBox>{status.message}</ErrorBox>}
        </Section>

        <Section>
          <SectionTitle>Your devices</SectionTitle>
          {devices.length === 0 ? (
            <Hint>
              No subscriptions saved yet. Tap Subscribe above on each device you
              want to receive admin notifications on.
            </Hint>
          ) : (
            <DeviceList>
              {devices.map((d) => {
                const isThis = thisEndpoint === d.endpoint;
                return (
                  <DeviceRow key={d.id}>
                    <DeviceCol>
                      <DeviceLine>
                        <Mono>{truncateStart(d.endpoint, 13)}</Mono>
                        {isThis && <ThisDeviceTag>this device</ThisDeviceTag>}
                      </DeviceLine>
                      <DeviceMeta>
                        {d.userAgent ?? "unknown user-agent"}
                      </DeviceMeta>
                      <DeviceMeta>
                        added {relativeTime(d.createdAt)} · last push{" "}
                        {d.lastNotifiedAt
                          ? relativeTime(d.lastNotifiedAt)
                          : "never"}
                      </DeviceMeta>
                    </DeviceCol>
                    <DeleteButton onClick={() => deleteDevice(d.id)}>
                      Delete
                    </DeleteButton>
                  </DeviceRow>
                );
              })}
            </DeviceList>
          )}
        </Section>

        <Section>
          <SectionTitle>Test push</SectionTitle>
          <Hint>
            Fires a notification at every saved subscription. Dead endpoints
            (404/410) are auto-pruned from the list above.
          </Hint>
          <Button onClick={testPush}>Send test notification</Button>
          {testResult && <Pre>{testResult}</Pre>}
        </Section>
      </Container>
    </Page>
  );
}

const Page = styled.div`
  min-height: 100vh;
  background: ${({ theme }) => theme.colors.bg};
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => theme.space.xxl};
  font-family: ${({ theme }) => theme.font.body};
`;

const Container = styled.div`
  max-width: 720px;
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
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.lg};
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const SectionTitle = styled.h2`
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 ${({ theme }) => theme.space.md} 0;
`;

const Row = styled.div`
  display: flex;
  justify-content: space-between;
  padding: ${({ theme }) => theme.space.xs} 0;
  font-size: 13px;
`;

const Label = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
`;

const Value = styled.span`
  color: ${({ theme }) => theme.colors.text};
  font-family: ${({ theme }) => theme.font.mono};
`;

const Hint = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};
  line-height: 1.5;
  margin: 0 0 ${({ theme }) => theme.space.md} 0;
  code {
    font-family: ${({ theme }) => theme.font.mono};
    background: ${({ theme }) => theme.colors.bg};
    padding: 1px 4px;
    border-radius: 3px;
  }
`;

const Warning = styled.div`
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.md};
  padding: ${({ theme }) => theme.space.md};
  margin-bottom: ${({ theme }) => theme.space.lg};
  font-size: 13px;
  line-height: 1.5;
`;

const Button = styled.button`
  background: ${({ theme }) => theme.colors.accent};
  color: white;
  border: none;
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

const ErrorBox = styled.div`
  margin-top: ${({ theme }) => theme.space.md};
  padding: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.danger};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 13px;
  font-family: ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.colors.danger};
`;

const Pre = styled.pre`
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: ${({ theme }) => theme.space.md};
  font-size: 12px;
  font-family: ${({ theme }) => theme.font.mono};
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: all;
`;

const DeviceList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space.sm};
`;

const DeviceRow = styled.li`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: ${({ theme }) => theme.space.md};
  background: ${({ theme }) => theme.colors.bg};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: ${({ theme }) => theme.space.md};
`;

const DeviceCol = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
`;

const DeviceLine = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.sm};
`;

const Mono = styled.span`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  color: ${({ theme }) => theme.colors.text};
`;

const ThisDeviceTag = styled.span`
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.accent};
  color: white;
`;

const DeviceMeta = styled.span`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const DeleteButton = styled.button`
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  &:hover {
    color: ${({ theme }) => theme.colors.danger};
    border-color: ${({ theme }) => theme.colors.danger};
  }
`;

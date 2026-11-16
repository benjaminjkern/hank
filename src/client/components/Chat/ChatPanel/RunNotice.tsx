import styled from "styled-components";

// Soft notice shown above the composer when a turn's stream dropped (tab
// backgrounded / PWA suspended / connection lost) and we're pulling the real
// state from the server. Deliberately low-key — not an error — because the
// turn's progress is safe in the DB and the reconcile repairs the view in a
// beat. Cleared by the store the moment the reconcile lands.
const ReconnectNotice = styled.div`
  align-self: center;
  margin: ${({ theme }) => theme.space.xs} auto;
  padding: 4px 12px;
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textSubtle};
  background: ${({ theme }) => theme.colors.bgMuted};
  border-radius: ${({ theme }) => theme.radius.sm};
`;

export function RunNotice({
  serverRunActive,
  streamInterrupted,
  streaming,
}: {
  serverRunActive: boolean;
  streamInterrupted: boolean;
  streaming: boolean;
}) {
  if (serverRunActive && !streaming) {
    // The server is still finishing this session's run without a live
    // stream attached (dropped connection / refresh / busy-session
    // bounce). The store polls and repaints progress as it persists —
    // say so instead of showing a dead chat that looks like Hank bailed.
    return (
      <ReconnectNotice role="status">
        Hank is still working — updates will appear as they finish…
      </ReconnectNotice>
    );
  }
  if (streamInterrupted && !streaming) {
    return (
      <ReconnectNotice role="status">
        Connection dropped — catching up…
      </ReconnectNotice>
    );
  }
  return null;
}

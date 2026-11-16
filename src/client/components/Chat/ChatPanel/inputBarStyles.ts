import styled from "styled-components";

// Outer row — just provides breathing room around the pod. The pod itself
// owns the visual chrome (bg, border, radius, focus ring).
export const InputBar = styled.div`
  display: flex;
  align-items: center;
  padding: ${({ theme }) => theme.space.lg};
`;

// The single rounded "pod" that holds attach + textarea + send/stop. One
// shared bg + border + focus-within glow makes the whole input feel like one
// elegant control rather than three loose circles on a flat strip. The
// `$thinking` shimmer rides on the pod (was on the textarea before, where it
// only covered the middle slot) so the working-cue sweep covers the whole
// rounded surface.
export const InputPod = styled.div<{ $thinking: boolean }>`
  flex: 1;
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  background: ${({ theme }) => theme.colors.bgMuted};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: 24px;
  padding: ${({ theme }) => theme.space.xs};
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:focus-within {
    border-color: ${({ theme }) => theme.colors.accent};
    box-shadow:
      0 0 0 3px ${({ theme }) => `${theme.colors.accent}22`},
      0 1px 2px rgba(0, 0, 0, 0.04);
  }

  ${({ $thinking, theme }) =>
    $thinking
      ? `
    background: linear-gradient(
      90deg,
      ${theme.colors.bgMuted} 0%,
      ${theme.colors.bgHover} 50%,
      ${theme.colors.bgMuted} 100%
    );
    background-size: 200% 100%;
    animation: thinkingPodShimmer 1.8s ease-in-out infinite;
    @keyframes thinkingPodShimmer {
      0%   { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
  `
      : ""}
`;

// Flat icon button (attach) inside the pod — no border or solid bg of its
// own; the pod already supplies that. Hover gives just a soft hint.
export const IconButton = styled.button<{ $disabled?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colors.textSubtle : theme.colors.textMuted};
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: ${({ $disabled }) => ($disabled ? "not-allowed" : "pointer")};
  font-size: 16px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    color: ${({ theme, $disabled }) =>
      $disabled ? theme.colors.textSubtle : theme.colors.text};
    background: ${({ theme, $disabled }) =>
      $disabled ? "transparent" : theme.colors.bgHover};
  }
`;

// Wraps the textarea + the absolutely-positioned hopping HankLogo overlay that
// appears while the agent is streaming. The wrap takes the flex slot so the
// textarea can stay 100%-width inside it without fighting the icon for space.
export const InputWrap = styled.div`
  position: relative;
  flex: 1;
  display: flex;
`;

// Lives inside InputPod, so it has no chrome of its own (no bg, no border, no
// radius). Padding controls the click-target height instead of the visual
// bounds. `$thinking` shimmer now rides on the pod via a CSS variable so the
// effect covers the whole rounded surface rather than just the textarea slot.
export const Input = styled.textarea<{ $thinking: boolean }>`
  flex: 1;
  background: transparent;
  border: none;
  color: ${({ theme }) => theme.colors.text};
  padding: ${({ theme }) => `${theme.space.xs} ${theme.space.sm}`};
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.5;
  overflow-y: auto;

  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }

  ${({ $thinking }) =>
    $thinking
      ? `
    &::placeholder {
      animation: thinkingPlaceholder 1.8s ease-in-out infinite;
    }
    @keyframes thinkingPlaceholder {
      0%, 100% { opacity: 0.55; }
      50%      { opacity: 1; }
    }
  `
      : ""}
`;

export const Send = styled.button<{ $disabled: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: ${({ theme, $disabled }) =>
    $disabled ? "transparent" : theme.colors.accent};
  color: ${({ theme, $disabled }) =>
    $disabled ? theme.colors.textSubtle : theme.colors.onAccent};
  border: none;
  border-radius: 50%;
  cursor: ${({ $disabled }) => ($disabled ? "not-allowed" : "pointer")};
  transition:
    background-color 0.15s ease,
    transform 0.1s ease;

  &:hover {
    background: ${({ theme, $disabled }) =>
      $disabled ? "transparent" : theme.colors.accentHover};
  }
  &:active:not(:disabled) {
    transform: scale(0.95);
  }
`;

export const SendIcon = styled.svg`
  width: 16px;
  height: 16px;
  display: block;
`;

// Round button that replaces Send while the agent is streaming. Filled accent
// square icon — "Stop". Clicking it routes through chatStore.stop(), a single
// press that stops the whole run and keeps whatever streamed.
export const StopButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: ${({ theme }) => theme.colors.bgHover};
  color: ${({ theme }) => theme.colors.text};
  border: none;
  border-radius: 50%;
  cursor: pointer;
  position: relative;

  &:hover {
    background: ${({ theme }) => theme.colors.bgMuted};
  }
`;

export const StopIcon = styled.svg`
  width: 14px;
  height: 14px;
  display: block;
`;

// Input grows from 1 line up to MAX_LINES; beyond that it scrolls internally.
// Inside the InputPod the textarea has no border (the pod owns the chrome)
// and tighter vertical padding so it sits comfortably alongside the 32px
// icon buttons.
const MAX_INPUT_LINES = 5;
const INPUT_LINE_HEIGHT = 21; // 14px * 1.5
const INPUT_VPAD = 8; // 2 * theme.space.xs (4px each)
export const INPUT_MIN_HEIGHT = INPUT_LINE_HEIGHT + INPUT_VPAD;
export const INPUT_MAX_HEIGHT =
  INPUT_LINE_HEIGHT * MAX_INPUT_LINES + INPUT_VPAD;

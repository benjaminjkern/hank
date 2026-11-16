import styled from "styled-components";

// The panel's on/off control: a pill holding a sliding track plus its label.
// The label names what the switch controls and stays the same in both states;
// the track position and accent-vs-muted color are what show whether it's on.

const SwitchButton = styled.button<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
  font-size: 10px;
  font-family: ${({ theme }) => theme.font.mono};
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  background: ${({ theme, $on }) => ($on ? theme.colors.bgMuted : "transparent")};
  color: ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.textSubtle)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  &:hover {
    border-color: ${({ theme }) => theme.colors.borderStrong};
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

const SwitchTrack = styled.span<{ $on: boolean }>`
  position: relative;
  display: inline-block;
  width: 18px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 999px;
  background: ${({ theme, $on }) => ($on ? theme.colors.accent : theme.colors.textSubtle)};
  transition: background 0.15s ease;
`;

const SwitchKnob = styled.span<{ $on: boolean }>`
  position: absolute;
  top: 1px;
  left: ${({ $on }) => ($on ? "9px" : "1px")};
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.bgPanel};
  transition: left 0.15s ease;
`;

export function Switch({
  on,
  label,
  title,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SwitchButton
      type="button"
      $on={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={title}
      aria-pressed={on}
    >
      <SwitchTrack $on={on}>
        <SwitchKnob $on={on} />
      </SwitchTrack>
      {label}
    </SwitchButton>
  );
}

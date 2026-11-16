"use client";

// The three shortlist marks, wherever a role can be decided — one row on the
// board, and the same role opened on its own page.
//
// It is a RADIO GROUP, not three toggles, and that is the whole design: every
// markable role carries exactly one of the three, so there is no state to clear
// to and re-clicking the set mark is meaningless. Selected reads as a filled
// pill with no hover and no pointer, because a control that looks pressable and
// does nothing is worse than one that plainly says "this is where you are".
//
// The radio roles carry a roving tabindex (only the set mark is tabbable) and an
// arrow-key handler, both hand-written: `role="radio"` buys the announcement,
// not the keyboard behaviour, so without them Tab would reach the one mark you
// can't press and stop there.

import { useRef } from "react";
import styled from "styled-components";

const Group = styled.div`
  display: inline-flex;
  align-items: center;
  gap: ${({ theme }) => theme.space.xs};
`;

const Mark = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Square rather than a text pill's 2px/10px — an icon has no width of its own
     to shape the target, and 28px keeps it tappable. */
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid
    ${({ theme, $active }) =>
      $active ? theme.colors.accent : theme.colors.border};
  color: ${({ theme, $active }) =>
    $active ? theme.colors.onAccent : theme.colors.textMuted};
  background: ${({ theme, $active }) =>
    $active ? theme.colors.accent : "transparent"};
  /* The set mark is a statement, not an action. */
  cursor: ${({ $active }) => ($active ? "default" : "pointer")};
  transition:
    border-color 0.12s ease,
    background 0.12s ease,
    color 0.12s ease;

  &:hover:not(:disabled):not([aria-checked="true"]) {
    border-color: ${({ theme }) => theme.colors.accent};
    color: ${({ theme }) => theme.colors.accent};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.accent};
    outline-offset: 2px;
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

// 16px, stroke-only, inheriting the button's color so the selected fill's
// contrast colour applies for free — same convention as ThemeToggle's icons.
// `aria-hidden` because the accessible name comes from the button's aria-label.
function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function ShortlistIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function DeferIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M2.5 9.5c1.4-2.8 2.8-2.8 4.2 0s2.8 2.8 4.2 0" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// `value` is the wire vocabulary (pick / borderline / pass, what the board and
// the agent speak); `label` is the LIFECYCLE word the mark lands the role on,
// which is what the rest of the app shows on the status pill. They differ on
// purpose — naming the button "Pick" left no way to tell which status it sets.
export const STANCES = [
  { value: "pick", label: "Shortlist", Icon: ShortlistIcon },
  { value: "borderline", label: "Defer", Icon: DeferIcon },
  { value: "pass", label: "Close", Icon: CloseIcon },
] as const;

export type StanceValue = (typeof STANCES)[number]["value"];

export const STANCE_OF_VERDICT: Record<string, StanceValue> = {
  PICK: "pick",
  BORDERLINE: "borderline",
  PASS: "pass",
};

// What the mark does from here, said in the role's own terms. A role the
// automatic filtering already closed gets the extra clause, because there the
// other two marks are what put it back on the table.
function markTitle(label: string, active: boolean, filtered: boolean): string {
  if (active)
    return filtered ? "Ruled out before the shortlist" : `${label} — current`;
  return filtered ? `${label} — this puts it back on the table` : label;
}

export function StanceMarks({
  stance,
  onMark,
  disabled,
  filtered,
  label,
}: {
  stance: StanceValue | null;
  onMark: (next: StanceValue) => void;
  disabled?: boolean;
  // The role was closed by the automatic filtering rather than by anyone's
  // judgement, which changes what the two unset marks mean.
  filtered?: boolean;
  // Accessible name for the group itself. Defaults to something generic; a
  // surface showing one role among many should name it.
  label?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = STANCES.findIndex((s) => s.value === stance);

  // Arrows wrap through the group and MOVE the selection, per the radio pattern
  // — the focused mark and the set mark are the same thing here.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || disabled) return;
    e.preventDefault();
    const from = selectedIndex === -1 ? 0 : selectedIndex;
    const next = (from + step + STANCES.length) % STANCES.length;
    onMark(STANCES[next].value);
    // The selected mark is the only tabbable one, so focus has to follow the
    // selection or the next arrow press lands nowhere.
    groupRef.current?.querySelectorAll("button")[next]?.focus();
  }

  return (
    <Group
      ref={groupRef}
      role="radiogroup"
      aria-label={label ?? "Your call on this role"}
      onKeyDown={onKeyDown}
    >
      {STANCES.map((s, i) => {
        const active = stance === s.value;
        return (
          <Mark
            key={s.value}
            type="button"
            role="radio"
            $active={active}
            disabled={disabled}
            aria-checked={active}
            // The icon carries no text, so the button needs its own accessible
            // name — and the tooltip has to say what the mark does now that the
            // label isn't on screen.
            aria-label={s.label}
            title={markTitle(s.label, active, filtered ?? false)}
            // Roving: the group is ONE tab stop. With nothing set yet the first
            // mark takes it, so the group is never unreachable.
            tabIndex={active || (selectedIndex === -1 && i === 0) ? 0 : -1}
            onClick={() => {
              if (!active) onMark(s.value);
            }}
          >
            <s.Icon />
          </Mark>
        );
      })}
    </Group>
  );
}

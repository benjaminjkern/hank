"use client";

import styled from "styled-components";

import { useThemeMode, type ThemeMode } from "@/lib/themeMode";

import { iconAction } from "./iconAction";

const NEXT: Record<ThemeMode, ThemeMode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemeMode, string> = {
  system: "Theme: auto (follows system)",
  light: "Theme: light",
  dark: "Theme: dark",
};

const Button = styled.button`
  ${iconAction}
`;

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1.05 1.05M4.45 11.55L3.4 12.6M12.6 12.6l-1.05-1.05M4.45 4.45L3.4 3.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ThemeToggle() {
  const { mode, setMode } = useThemeMode();
  const Icon =
    mode === "system" ? AutoIcon : mode === "light" ? SunIcon : MoonIcon;
  return (
    <Button
      onClick={() => setMode(NEXT[mode])}
      title={LABEL[mode]}
      aria-label={LABEL[mode]}
      type="button"
    >
      <Icon />
    </Button>
  );
}

"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useState } from "react";
import {
  ServerStyleSheet,
  StyleSheetManager,
  ThemeProvider,
} from "styled-components";

import { darkTheme, lightTheme } from "./theme";
import { useThemeMode } from "./themeMode";

export default function StyledComponentsRegistry({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sheet] = useState(() => new ServerStyleSheet());
  const { resolved } = useThemeMode();
  const activeTheme = resolved === "light" ? lightTheme : darkTheme;

  useServerInsertedHTML(() => {
    const styles = sheet.getStyleElement();
    sheet.instance.clearTag();
    return <>{styles}</>;
  });

  if (typeof window !== "undefined") {
    return <ThemeProvider theme={activeTheme}>{children}</ThemeProvider>;
  }

  return (
    <StyleSheetManager sheet={sheet.instance}>
      <ThemeProvider theme={activeTheme}>{children}</ThemeProvider>
    </StyleSheetManager>
  );
}

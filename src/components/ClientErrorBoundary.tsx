"use client";

// React error boundary that reports render crashes to /api/client-events
// and shows a fallback instead of taking down the whole page. React
// error boundaries must be class components — there's no hook equivalent.
//
// Wrap surfaces that can independently fail (the right panel, the chat widget
// slot). `component` labels the surface so the server-derived dedupKey
// (`client:render_error:<component>`) groups crashes per-surface.

import { Component, type ReactNode } from "react";

import { reportClientEvent } from "@/lib/clientEvents";

type Props = {
  component: string;
  children: ReactNode;
  // Rendered after a catch. Defaults to null (render nothing).
  fallback?: ReactNode;
};

type State = { hasError: boolean };

export class ClientErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    reportClientEvent({
      source: "render_error",
      severity: "error",
      summary:
        "Part of the app hit a display error and showed a fallback instead of the normal view.",
      context: {
        component: this.props.component,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
  }

  render() {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}

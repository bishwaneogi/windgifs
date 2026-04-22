import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { appendDebugLog } from "./lib/native";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("WindGifs renderer crashed", error, errorInfo);
    void appendDebugLog(
      [
        "renderer crash",
        error.name,
        error.message,
        error.stack ?? "",
        errorInfo.componentStack,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main
        style={{
          width: "min(900px, calc(100vw - 32px))",
          margin: "0 auto",
          padding: "32px 0 48px",
          color: "#1f2430",
          fontFamily: "\"Segoe UI Variable Text\", \"Bahnschrift\", sans-serif",
        }}
      >
        <section
          style={{
            padding: 24,
            borderRadius: 6,
            border: "1px solid rgba(157, 45, 39, 0.24)",
            background: "rgba(255, 252, 246, 0.96)",
            boxShadow: "0 28px 60px rgba(68, 46, 28, 0.12)",
          }}
        >
          <p
            style={{
              margin: 0,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              fontSize: "0.75rem",
              color: "#9d2d27",
              fontWeight: 700,
            }}
          >
            Renderer Error
          </p>
          <h1 style={{ margin: "10px 0 12px" }}>WindGifs hit an unexpected app error</h1>
          <p style={{ margin: 0, lineHeight: 1.6, color: "#667081" }}>
            The UI crashed while rendering the current project state. The message below is
            here so we can fix the real issue instead of leaving you with a blank window.
          </p>
          <pre
            style={{
              margin: "18px 0 0",
              padding: 16,
              borderRadius: 4,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "rgba(31, 36, 48, 0.06)",
              color: "#1f2430",
            }}
          >
            {this.state.error.stack ?? this.state.error.message}
          </pre>
        </section>
      </main>
    );
  }
}

window.addEventListener("error", (event) => {
  void appendDebugLog(
    [
      "window error",
      event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "",
      event.error instanceof Error ? event.error.stack ?? event.error.message : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? event.reason.stack ?? event.reason.message
      : String(event.reason);

  void appendDebugLog(["unhandled rejection", reason].filter(Boolean).join("\n"));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

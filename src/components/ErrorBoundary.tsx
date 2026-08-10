import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last thing between a thrown render and a white window.
 *
 * A file browser meets whatever is on the disk — a malformed PDF, a document
 * claiming a page count it doesn't have, a name in an encoding nothing expects
 * — and any of those reaching a render is a bug worth fixing, not a reason for
 * the whole app to disappear. So this keeps the failure on screen, names it,
 * and offers the one recovery that always works.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The stack is the useful half and it is not on the error's message, so it
    // goes to the console where a report can be copied out of it.
    console.error("Fiddler stopped drawing:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <strong>Fiddler stopped drawing this window</strong>
        <p>Your files are untouched — this is a display fault, and nothing was being written.</p>
        <code>{error.message || String(error)}</code>
        <button onClick={() => window.location.reload()}>Reload Fiddler</button>
      </div>
    );
  }
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Keeps a render error in one route from blanking the whole application. Resetting is
 * keyed on `resetKey` so navigating away from the broken screen clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[ui] render failed', error, info.componentStack); }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
      <h2 className="text-sm font-semibold text-slate-700">This screen ran into a problem</h2>
      <p className="max-w-md text-xs text-slate-500">{this.state.error.message || 'An unexpected error occurred while rendering.'}</p>
      <button className="btn" onClick={() => this.setState({ error: null })}><RefreshCw size={14} />Try again</button>
    </div>;
  }
}

import React from 'react';
import { Button, Notice } from './kit';

interface Props {
  /** The region this boundary contains, as the start of a sentence: "The Parts lens". */
  label: string;
  /** Runs before the retry, to clear whatever led to the failure. */
  onRetry?: () => void;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contains a render failure to one region. The rest of the workspace keeps working, the
 * recorded error is shown as it was thrown, and "Try again" renders the region afresh.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`${this.props.label} failed to render.`, error, info.componentStack);
  }

  retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary">
        <Notice
          tone="err"
          role="alert"
          action={
            <Button size="sm" onClick={this.retry}>
              Try again
            </Button>
          }
        >
          <strong>{this.props.label} could not be displayed.</strong>{' '}
          {error.message || 'No error message was recorded.'}
        </Notice>
      </div>
    );
  }
}

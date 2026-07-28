import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI error', error, info); }
  render() {
    if (this.state.failed) return <main className="p-8 text-center"><h1 className="text-xl font-semibold">The page could not be displayed</h1><p className="mt-2 text-gray-600">Your job is safe. Reload to continue checking its status.</p><button className="mt-4 px-4 py-2 rounded bg-blue-600 text-white" onClick={() => location.reload()}>Reload</button></main>;
    return this.props.children;
  }
}

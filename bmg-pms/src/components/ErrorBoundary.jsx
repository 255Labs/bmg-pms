import { Component } from 'react';

// One broken screen must never take the whole app down: show a friendly card and let people carry on
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Screen crashed:', error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    const chunk = /Loading chunk|dynamically imported module|Failed to fetch/i.test(String(this.state.error?.message));
    return (
      <div className="card narrow" role="alert" style={{ margin: '40px auto' }}>
        <h2 className="first">{chunk ? 'A new version is available' : 'This screen hit a problem'}</h2>
        <p className="muted">{chunk
          ? 'The app was updated while you had it open. Reload to continue.'
          : 'Nothing was lost: every posting is saved as soon as it is made. Reload the screen, or go back to Today.'}</p>
        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
          {!chunk && <a className="btn" href="#/today" onClick={() => this.setState({ error: null })}>Go to Today</a>}
        </div>
        {!chunk && <details className="small muted" style={{ marginTop: 12 }}><summary>Details for IT</summary><code className="wrap">{String(this.state.error?.message ?? this.state.error)}</code></details>}
      </div>
    );
  }
}

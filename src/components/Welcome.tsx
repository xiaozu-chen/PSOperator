import type { SessionInfo } from "../types";

export function Welcome({ session }: { session: SessionInfo }) {
  const shell = session.version ? `${session.shell} ${session.version}` : session.shell;

  return (
    <section className="welcome">
      <div className="welcome-box">
        <img className="welcome-image" src="/icon.webp" alt="PSOperator app icon" />
        <div className="welcome-copy">
          <div className="welcome-title">
            <span className="glyph">✻</span> PSOPERATOR
          </div>
          <div className="welcome-body">
            <div className="dim">
              <i>/help</i> for help, <i>/status</i> for your current setup
            </div>
            <div className="dim welcome-meta">
              <span>shell: {shell}</span>
              <span>cwd: {session.cwd || "…"}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="tips">
        <div className="tips-title">Tips for getting started:</div>
        <ol>
          <li>Type any PowerShell command. Variables, functions and <code>cd</code> persist.</li>
          <li>Press <kbd>Tab</kbd> to complete commands, parameters and paths.</li>
          <li>Press <kbd>Ctrl+T</kbd> for a new tab, <kbd>Esc</kbd> to interrupt, <kbd>?</kbd> for shortcuts.</li>
        </ol>
      </div>
    </section>
  );
}

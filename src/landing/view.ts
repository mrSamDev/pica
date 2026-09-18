export const landingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pica — a self-learning code review agent</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; max-width: 60rem; }
      h1 { font-size: 1.5rem; color: #e8edf2; }
      h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 0 0 0.5rem; }
      .lead { color: #d7dde3; font-size: 1rem; max-width: 42rem; }
      .loop { color: #7fb3ff; }
      pre { background: #161b20; border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-top: 2rem; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; }
      .panel p { font-size: 0.9rem; color: #d7dde3; margin: 0.3rem 0; }
      .links { margin-top: 2rem; font-size: 0.9rem; }
      a { color: #7fb3ff; }
      .muted { color: #5b6672; }
    </style>
  </head>
  <body>
    <h1>pica — a self-learning code review agent</h1>
    <p class="lead">
      pica reviews pull requests with an LLM and learns from how humans respond:
      a finding humans keep dismissing stops being flagged; one they keep
      confirming gets emphasized. Learning is explicit, auditable, testable,
      and rebuildable from an immutable event log.
    </p>
    <pre class="loop">webhook → review job → LLM → findings → post comments → human feedback
                                                       ↓
                                     learning events → rule learner
                                                       ↓
                                          active rules → future reviews</pre>
    <div class="grid">
      <div class="panel">
        <h2>How it works</h2>
        <p>Every pull request webhook triggers a review job. The LLM proposes findings; the post-filter drops duplicates and noise; what survives gets posted as review comments.</p>
      </div>
      <div class="panel">
        <h2>The learning loop</h2>
        <p>Findings produce outcomes. Outcomes produce signals. Signals produce rules — with Beta confidence, decay, and ε-probing. Rules change future reviews. A falling dismissal rate is the north star.</p>
      </div>
      <div class="panel">
        <h2>Explicit and auditable</h2>
        <p>Every learned rule is inspectable: which finding it suppressed, which evidence activated it, which probe last re-checked it. Nothing is a black box.</p>
      </div>
    </div>
    <p class="links">
      <a href="/dashboard">Control room</a> · <a href="/why">Why was a finding suppressed?</a>
      <span class="muted">(both behind basic auth)</span>
    </p>
  </body>
</html>`;

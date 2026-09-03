export const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — control room</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.25rem; color: #e8edf2; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; }
      .panel h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 0 0 0.5rem; }
      .row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: 0.9rem; }
      .row .k { color: #8b98a5; }
      .row .v { color: #e8edf2; }
      .empty { color: #5b6672; font-size: 0.9rem; }
      .rule { padding: 0.3rem 0; border-bottom: 1px solid #1c2228; font-size: 0.86rem; }
      ul.activity { list-style: none; margin: 0; padding: 0; }
      ul.activity li { padding: 0.3rem 0; border-bottom: 1px solid #1c2228; font-size: 0.85rem; }
      .tag { color: #7fb3ff; }
      .muted { color: #5b6672; }
      a { color: #7fb3ff; }
    </style>
  </head>
  <body>
    <h1>Pica — control room</h1>
    <div class="grid">
      <div class="panel"><h2>System health</h2><div id="system"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Review behavior</h2><div id="behavior"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Outcomes</h2><div id="outcomes"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Learning</h2><div id="learning"><p class="empty">Loading…</p></div><div id="rules"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Recent activity</h2><div id="activity"><p class="empty">Loading…</p></div></div>
    </div>
    <script>
      function row(k, v) { return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
      function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      function render(state) {
        document.getElementById('system').innerHTML =
          row('Running', state.system.reviewsRunning) +
          row('Completed', state.system.reviewsCompleted) +
          row('Failed', state.system.reviewsFailed) +
          row('Queue depth', state.system.queueDepth) +
          row('Failed jobs (DLQ)', state.system.failedJobs) +
          '<p class="empty">Failed jobs are retained as the DLQ; re-drive via redis-cli.</p>';
        document.getElementById('behavior').innerHTML =
          row('Findings / PR', state.reviewBehavior.findingsPerPr) +
          row('Posted', state.reviewBehavior.posted) +
          row('Suppressed', state.reviewBehavior.suppressed) +
          row('Duplicate', state.reviewBehavior.duplicate);
        document.getElementById('outcomes').innerHTML =
          row('Posted', state.outcomes.posted) +
          row('Replied', state.outcomes.replied) +
          row('Resolved', state.outcomes.resolved) +
          row('Dismissed', state.outcomes.dismissed);
        document.getElementById('learning').innerHTML =
          row('Active rules', state.learning.activeRules) +
          row('Candidate rules', state.learning.candidateRules) +
          row('Retired rules', state.learning.retiredRules) +
          (state.learning.learningLagMs !== null
            ? row('Learning lag (s)', Math.round(state.learning.learningLagMs))
            : '<p class="empty">Learning lag: no rule has activated yet.</p>');
        var activity = document.getElementById('activity');
        if (state.recentActivity.length === 0) {
          activity.innerHTML = '<p class="empty">No activity yet.</p>';
        } else {
          activity.innerHTML = '<ul class="activity">' + state.recentActivity.map(function (a) {
            return '<li><span class="tag">' + esc(a.eventType) + '</span> <span class="muted">' + esc(a.repo) + '</span></li>';
          }).join('') + '</ul>';
        }
      }
      async function renderRules() {
        try {
          var res = await fetch('/api/rules');
          var rules = await res.json();
          var el = document.getElementById('rules');
          if (!rules || rules.length === 0) {
            el.innerHTML = '<p class="empty">No rules yet. Dismissed findings accumulate here as candidate and active rules.</p>';
            return;
          }
          el.innerHTML = rules.map(function (r) {
            var conf = r.confidence !== null ? (r.confidence * 100).toFixed(0) + '%' : '—';
            var when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '';
            return '<div class="rule"><span class="tag">' + esc(r.ruleType) + ':' + esc(r.status) + '</span> ' +
              '<span class="k">' + esc(r.pattern || r.id) + '</span>' +
              ' <span class="muted">conf ' + esc(conf) + ' · ev ' + esc(r.evidenceCount) + ' (neg ' + esc(r.negativeCount) + ', pos ' + esc(r.positiveCount) + ') · ' + esc(when) + '</span></div>';
          }).join('');
        } catch (e) { /* keep last state */ }
      }
      async function poll() {
        try {
          var res = await fetch('/api/dashboard');
          render(await res.json());
        } catch (e) { /* keep last state on transient errors */ }
      }
      poll();
      renderRules();
      setInterval(poll, 3000);
    </script>
  </body>
</html>`;

// Phase-5 ε-probing adds the `lastProbe` field later; until then it stays null.
export const whyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — why did this finding disappear?</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.1rem; color: #e8edf2; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; margin-top: 1rem; max-width: 760px; }
      .row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: 0.9rem; }
      .row .k { color: #8b98a5; } .row .v { color: #e8edf2; }
      .tag { color: #7fb3ff; } .muted { color: #5b6672; }
      code { background: #161b20; padding: 0.1rem 0.3rem; border-radius: 3px; }
      .empty { color: #5b6672; }
      a { color: #7fb3ff; }
    </style>
  </head>
  <body>
    <h1><a href="/dashboard">Pica</a> · Why did this finding disappear?</h1>
    <div class="panel"><div id="why"><p class="empty">Loading…</p></div></div>
    <script>
      function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      function row(k, v) { return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
      function pct(n) { return n !== null ? (n * 100).toFixed(0) + '%' : '—'; }
      async function render() {
        var id = new URLSearchParams(location.search).get('findingId');
        try {
          var res = await fetch('/api/why?findingId=' + encodeURIComponent(id));
          var d = await res.json();
          if (!d || res.status !== 200) { document.getElementById('why').innerHTML = '<p class="empty">No suppressed finding for id ' + esc(id) + '</p>'; return; }
          var html =
            row('Finding', esc(d.finding.message)) +
            row('File', '<code>' + esc(d.finding.filePath) + '</code>') +
            row('Severity', esc(d.finding.severity)) +
            row('Status', esc(d.finding.status)) +
            row('Pattern', '<span class="tag">' + esc(d.pattern.category) + ':' + esc(d.pattern.canonicalMessage) + '</span>') +
            (d.rule
              ? row('Suppressing rule', '<span class="tag">' + esc(d.rule.status) + ' ignore</span>') +
                row('Confidence', pct(d.rule.confidence)) +
                row('Evidence', 'neg ' + esc(d.rule.negativeCount) + ' / pos ' + esc(d.rule.positiveCount) + ' (gen ' + esc(d.rule.evidenceCount) + ')')
              : row('Suppressing rule', '<span class="muted">none — dropped by post-filter, not a learned rule</span>')) +
            '<div class="row"><span class="k">Learned from PRs</span><span class="v">' + (d.evidence.map(function (e) { return '#<code>' + esc(e.prId) + '</code> (' + esc(e.outcome) + ')'; }).join(' ') || '—') + '</span></div>' +
            row('Last probe', d.lastProbe === null ? 'none yet' : esc(d.lastProbe));
          document.getElementById('why').innerHTML = html;
        } catch (e) { document.getElementById('why').innerHTML = '<p class="empty">No suppressed finding found</p>'; }
      }
      render();
    </script>
  </body>
</html>`;

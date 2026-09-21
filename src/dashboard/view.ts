export const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — control room</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.25rem; color: #e8edf2; margin: 0 0 1rem; }
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
      .err { color: #ff8b7d; font-size: 0.8rem; padding: 0.15rem 0; word-break: break-word; }
      .tag { color: #7fb3ff; }
      .muted { color: #5b6672; }
      a { color: #7fb3ff; }
      .verdict { margin-bottom: 1rem; border-left: 3px solid #5b6672; }
      .verdict.improving { border-left-color: #7ddc9a; }
      .verdict.uncertain { border-left-color: #e8c46b; }
      .verdict.attention { border-left-color: #ff8b7d; }
      .verdict .headline { font-size: 1rem; color: #e8edf2; margin: 0 0 0.5rem; }
      .verdict .reasons { margin: 0 0 0.5rem; padding-left: 1.2rem; font-size: 0.9rem; }
      .verdict .next { font-size: 0.85rem; margin: 0; color: #b8c2cc; }
      .verdict .next .k { color: #8b98a5; margin-right: 0.4rem; }
      .explain { font-size: 0.78rem; color: #6d7a86; margin: 0 0 0.6rem; line-height: 1.45; }
      .insight { font-size: 0.82rem; color: #b8c2cc; margin: 0.5rem 0 0; }
      .spark { display: block; width: 100%; height: 34px; margin-top: 0.6rem; }
      .spark polyline { fill: none; stroke: #7fb3ff; stroke-width: 2; }
    </style>
  </head>
  <body>
    <h1>Pica — control room</h1>
    <div id="app"></div>
    <script type="module" src="/dashboard/app.js"></script>
  </body>
</html>`;

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

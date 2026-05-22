export function mountBenchmarks(el) {
  const { folder } = window.__pg.agent;
  const apiBase = `/api/drafts/${folder}/knowledge`;

  el.innerHTML = `
    <div class="tab-section" style="padding:16px;max-width:960px">
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
        <h2 style="margin:0">Benchmarks</h2>
        <button id="bm-new-btn" class="btn btn-primary">+ New Benchmark</button>
      </div>

      <div id="bm-new-form" style="display:none;border:1px solid var(--border,#ddd);border-radius:6px;padding:1rem;margin-bottom:1rem">
        <label style="display:block;margin-bottom:0.5rem">Benchmark name
          <input id="bm-name" type="text" style="display:block;width:100%;margin-top:0.25rem;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit" placeholder="e.g. Lecture 3 eval">
        </label>
        <label style="display:block;margin-bottom:0.75rem">Corpus
          <select id="bm-corpus-select" style="display:block;width:100%;margin-top:0.25rem;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit">
            <option value="">— loading —</option>
          </select>
        </label>
        <div style="display:flex;gap:0.5rem">
          <button id="bm-create-btn" class="btn btn-primary">Create</button>
          <button id="bm-cancel-btn" class="btn">Cancel</button>
        </div>
      </div>

      <div id="bm-list"></div>

      <div id="bm-detail" style="display:none;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border,#ddd)">
        <div style="display:flex;align-items:baseline;gap:1rem;margin-bottom:0.75rem;flex-wrap:wrap">
          <h3 id="bm-detail-name" style="margin:0"></h3>
          <span id="bm-detail-corpus" style="font-size:13px;color:var(--text-muted,#666)"></span>
        </div>

        <div id="bm-query-editor" style="margin-bottom:1rem">
          <h4 style="margin:0 0 0.5rem">Test queries</h4>
          <div id="bm-query-list"></div>
          <div style="margin-top:0.5rem;display:flex;gap:0.5rem;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <input id="bm-q-text" type="text" placeholder="Query text" style="width:100%;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit;margin-bottom:4px">
              <input id="bm-q-gold" type="text" placeholder="Gold snippets (comma-separated, optional)" style="width:100%;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit;font-size:12px">
            </div>
            <button id="bm-q-add-btn" class="btn">Add query</button>
          </div>
        </div>

        <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:0.5rem;font-size:14px">
            Top-k
            <select id="bm-k-select" style="padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit">
              <option value="3">3</option>
              <option value="5" selected>5</option>
              <option value="10">10</option>
            </select>
          </label>
          <button id="bm-run-btn" class="btn btn-primary">Run benchmark</button>
          <span id="bm-run-status" style="font-size:13px;color:var(--text-muted,#888)"></span>
        </div>

        <div id="bm-results"></div>
      </div>
    </div>
  `;

  document.title = `Benchmarks — ${window.__pg.agent.name} · Agent Playground`;

  let benchmarks = [];
  let selectedId = null;
  let selectedMeta = null;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadCorpora() {
    try {
      const res = await fetch(`${apiBase}/corpora`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const ready = (data.corpora ?? []).filter((c) => c.status === 'ready');
      const sel = el.querySelector('#bm-corpus-select');
      sel.innerHTML = ready.length
        ? ready.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} [${esc(c.storeStrategy ?? 'bm25')}]</option>`).join('')
        : '<option value="">— no ready corpora —</option>';
    } catch {
      const sel = el.querySelector('#bm-corpus-select');
      if (sel) sel.innerHTML = '<option value="">— error loading corpora —</option>';
    }
  }

  async function loadList() {
    try {
      const res = await fetch(`${apiBase}/benchmarks`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      benchmarks = data.benchmarks ?? [];
    } catch {
      benchmarks = [];
    }
    renderList();
  }

  function renderList() {
    const listEl = el.querySelector('#bm-list');
    if (!benchmarks.length) {
      listEl.innerHTML = '<p style="color:var(--text-muted,#888)">No benchmarks yet. Create one above.</p>';
      return;
    }
    listEl.innerHTML = benchmarks.map((b) => `
      <div class="corpus-card" data-id="${esc(b.id)}" style="cursor:pointer">
        <span class="corpus-name">${esc(b.name)}</span>
        <span class="corpus-meta">${esc(String(b.queries.length))} queries</span>
        <button class="btn btn-danger" data-del="${esc(b.id)}" style="padding:2px 8px;font-size:12px">&#10005;</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.corpus-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        selectBenchmark(card.dataset.id);
      });
    });
    listEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this benchmark?')) return;
        await fetch(`${apiBase}/benchmarks/${encodeURIComponent(btn.dataset.del)}`, {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (selectedId === btn.dataset.del) {
          selectedId = null;
          selectedMeta = null;
          el.querySelector('#bm-detail').style.display = 'none';
        }
        await loadList();
      });
    });
  }

  async function selectBenchmark(id) {
    const res = await fetch(`${apiBase}/benchmarks/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    selectedId = id;
    selectedMeta = await res.json();
    el.querySelector('#bm-detail').style.display = 'block';
    el.querySelector('#bm-detail-name').textContent = selectedMeta.name;
    el.querySelector('#bm-detail-corpus').textContent = `corpus: ${selectedMeta.corpusId}`;
    el.querySelector('#bm-results').innerHTML = '';
    renderQueryList();
  }

  function renderQueryList() {
    const listEl = el.querySelector('#bm-query-list');
    if (!selectedMeta.queries.length) {
      listEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted,#888)">No queries yet. Add one below.</p>';
      return;
    }
    listEl.innerHTML = selectedMeta.queries.map((q, i) => `
      <div style="display:flex;align-items:flex-start;gap:0.5rem;padding:6px 0;border-bottom:1px solid var(--border,#eee)">
        <div style="flex:1;font-size:13px">
          <div><strong>${esc(q.query)}</strong></div>
          ${q.relevant.length ? `<div style="font-size:11px;color:var(--text-muted,#666)">gold: ${esc(q.relevant.join(', '))}</div>` : '<div style="font-size:11px;opacity:0.5">unscored</div>'}
        </div>
        <button class="btn btn-danger" data-rm="${i}" style="padding:2px 6px;font-size:11px">&#10005;</button>
      </div>
    `).join('');
    listEl.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.rm, 10);
        const removed = selectedMeta.queries.splice(idx, 1)[0];
        try {
          await saveQueries();
          renderQueryList();
        } catch {
          selectedMeta.queries.splice(idx, 0, removed);
          el.querySelector('#bm-run-status').textContent = 'Failed to remove query. Try again.';
        }
      });
    });
  }

  async function saveQueries() {
    const res = await fetch(`${apiBase}/benchmarks/${encodeURIComponent(selectedId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ queries: selectedMeta.queries }),
    });
    if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`);
  }

  el.querySelector('#bm-new-btn').addEventListener('click', async () => {
    await loadCorpora();
    el.querySelector('#bm-new-form').style.display = 'block';
    el.querySelector('#bm-name').focus();
  });

  el.querySelector('#bm-cancel-btn').addEventListener('click', () => {
    el.querySelector('#bm-new-form').style.display = 'none';
    el.querySelector('#bm-name').value = '';
  });

  el.querySelector('#bm-create-btn').addEventListener('click', async () => {
    const name = el.querySelector('#bm-name').value.trim();
    const corpusId = el.querySelector('#bm-corpus-select').value;
    if (!name || !corpusId) return;
    await fetch(`${apiBase}/benchmarks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, corpusId }),
    });
    el.querySelector('#bm-name').value = '';
    el.querySelector('#bm-new-form').style.display = 'none';
    await loadList();
  });

  el.querySelector('#bm-q-add-btn').addEventListener('click', async () => {
    const queryText = el.querySelector('#bm-q-text').value.trim();
    if (!queryText || !selectedMeta) return;
    const goldRaw = el.querySelector('#bm-q-gold').value.trim();
    const relevant = goldRaw ? goldRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    selectedMeta.queries.push({
      id: Math.random().toString(36).slice(2),
      query: queryText,
      relevant,
    });
    try {
      await saveQueries();
      el.querySelector('#bm-q-text').value = '';
      el.querySelector('#bm-q-gold').value = '';
      renderQueryList();
    } catch {
      selectedMeta.queries.pop(); // undo push on failure
      el.querySelector('#bm-run-status').textContent = 'Failed to save query. Try again.';
    }
  });

  el.querySelector('#bm-run-btn').addEventListener('click', async () => {
    if (!selectedId) return;
    const k = parseInt(el.querySelector('#bm-k-select').value, 10);
    const statusEl = el.querySelector('#bm-run-status');
    const resultsEl = el.querySelector('#bm-results');
    statusEl.textContent = 'Running…';
    el.querySelector('#bm-run-btn').disabled = true;

    try {
      const res = await fetch(`${apiBase}/benchmarks/${encodeURIComponent(selectedId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ k }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      statusEl.textContent = '';
      renderResults(data, k);
    } catch (err) {
      statusEl.textContent = `Run failed: ${esc(String(err.message ?? err))}`;
    } finally {
      el.querySelector('#bm-run-btn').disabled = false;
    }
  });

  function renderResults(run, k) {
    const resultsEl = el.querySelector('#bm-results');
    const strategies = Object.keys(run.summary.strategies);

    if (!run.queriesRun.length) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No queries to run.</p>';
      return;
    }

    const fmt = (n) => (typeof n === 'number' ? (n * 100).toFixed(1) + '%' : '—');

    let summaryHtml = `
      <h4 style="margin:0 0 0.5rem">Summary (${esc(String(run.summary.scored))} scored / ${esc(String(run.summary.total))} total queries, k=${esc(String(k))})</h4>
      <table style="border-collapse:collapse;font-size:13px;margin-bottom:1rem">
        <thead>
          <tr style="border-bottom:2px solid var(--border,#ddd)">
            <th style="padding:4px 12px 4px 0;text-align:left">Strategy</th>
            <th style="padding:4px 12px;text-align:right">MRR</th>
            <th style="padding:4px 12px;text-align:right">Hit@1</th>
            <th style="padding:4px 12px;text-align:right">Hit@3</th>
            <th style="padding:4px 12px;text-align:right">Hit@${esc(String(k))}</th>
          </tr>
        </thead>
        <tbody>
    `;
    for (const s of strategies) {
      const m = run.summary.strategies[s];
      summaryHtml += `<tr>
        <td style="padding:4px 12px 4px 0;font-weight:600">${esc(s)}</td>
        <td style="padding:4px 12px;text-align:right">${esc(fmt(m.mrr))}</td>
        <td style="padding:4px 12px;text-align:right">${esc(fmt(m.hitAt1))}</td>
        <td style="padding:4px 12px;text-align:right">${esc(fmt(m.hitAt3))}</td>
        <td style="padding:4px 12px;text-align:right">${esc(fmt(m.hitAtK))}</td>
      </tr>`;
    }
    summaryHtml += '</tbody></table>';

    const stratHeaders = strategies.map((s) => `<th style="padding:6px 8px;text-align:left">${esc(s)}</th>`).join('');

    const queryRows = run.queriesRun.map((q) => {
      const stratCols = strategies.map((s) => {
        const sr = q.strategies[s];
        if (!sr) return `<td style="padding:6px 8px;color:var(--text-muted,#888);font-size:12px">—</td>`;
        const rankLabel = sr.hitRank
          ? `<span style="color:green">✓ rank ${esc(String(sr.hitRank))}</span>`
          : (q.relevant.length ? `<span style="color:red">✗</span>` : `<span style="opacity:0.5">—</span>`);
        const topChunk = sr.chunks[0];
        const preview = topChunk
          ? esc(String(topChunk.text).slice(0, 120)) + (topChunk.text.length > 120 ? '…' : '')
          : '(no results)';
        return `<td style="padding:6px 8px;font-size:12px;vertical-align:top">${rankLabel}<br><span style="opacity:0.75">${preview}</span></td>`;
      }).join('');

      const goldDisplay = q.relevant.length
        ? `<div style="font-size:11px;color:var(--text-muted,#555);margin-top:2px">gold: ${esc(q.relevant.join(', '))}</div>`
        : '<div style="font-size:11px;opacity:0.4">unscored</div>';

      return `<tr style="border-bottom:1px solid var(--border,#eee);vertical-align:top">
        <td style="padding:6px 8px;min-width:160px">
          <div style="font-weight:600;font-size:13px">${esc(q.query)}</div>
          ${goldDisplay}
        </td>
        ${stratCols}
      </tr>`;
    }).join('');

    resultsEl.innerHTML = summaryHtml + `
      <h4 style="margin:0 0 0.5rem">Per-query results</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:2px solid var(--border,#ddd)">
            <th style="padding:6px 8px;text-align:left;min-width:160px">Query</th>
            ${stratHeaders}
          </tr>
        </thead>
        <tbody>${queryRows}</tbody>
      </table>
    `;
  }

  loadList();
}

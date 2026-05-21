/**
 * Retrieval tab — RAG corpus query interface.
 *
 * Lets the user pick a ready corpus, enter a query, and see ranked BM25 results.
 */

export function mountRetrieval(el) {
  const { folder } = window.__pg.agent;

  el.innerHTML = `
    <div class="tab-section" style="padding:16px;max-width:860px">
      <h2 style="margin:0 0 1rem">Retrieval</h2>

      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:14px">
          Corpus
          <select id="ret-corpus-select" style="padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit;min-width:180px">
            <option value="">— loading —</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:14px">
          Top-k
          <select id="ret-k-select" style="padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit">
            <option value="3">3</option>
            <option value="5" selected>5</option>
            <option value="10">10</option>
          </select>
        </label>
        <span id="ret-strategy-badge" style="font-size:12px;padding:2px 8px;border-radius:10px;background:var(--bg-subtle,#eee);color:var(--text-muted,#555)"></span>
      </div>

      <div style="display:flex;gap:0.5rem;margin-bottom:1.25rem">
        <input id="ret-query-input" type="text" placeholder="Enter a search query&hellip;"
          style="flex:1;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font:inherit;font-size:14px">
        <button id="ret-search-btn" class="btn btn-primary">Search</button>
      </div>

      <div id="ret-results"></div>
    </div>
  `;

  document.title = `Retrieval — ${window.__pg.agent.name} · Agent Playground`;

  const apiBase = `/api/drafts/${folder}/knowledge/corpora`;
  const headers = { 'Content-Type': 'application/json' };

  const corpusSelect = el.querySelector('#ret-corpus-select');
  const kSelect = el.querySelector('#ret-k-select');
  const queryInput = el.querySelector('#ret-query-input');
  const searchBtn = el.querySelector('#ret-search-btn');
  const resultsEl = el.querySelector('#ret-results');

  function updateStrategyBadge() {
    const opt = corpusSelect.options[corpusSelect.selectedIndex];
    const strategy = opt?.dataset?.strategy ?? '';
    const badge = el.querySelector('#ret-strategy-badge');
    if (badge) badge.textContent = strategy ? `strategy: ${strategy}` : '';
  }
  corpusSelect.addEventListener('change', updateStrategyBadge);

  async function loadCorpora() {
    try {
      const res = await fetch(apiBase, { headers, credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const ready = (data.corpora ?? []).filter((c) => c.status === 'ready');
      if (!ready.length) {
        corpusSelect.innerHTML = '<option value="">— no ready corpora —</option>';
        resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No ready corpora available. Build one in the Sources tab first.</p>';
        return;
      }
      corpusSelect.innerHTML = ready.map((c) =>
        `<option value="${esc(c.id)}" data-strategy="${esc(c.storeStrategy ?? 'bm25')}">${esc(c.name)} [${esc(c.storeStrategy ?? 'bm25')}]</option>`
      ).join('');
      updateStrategyBadge();
    } catch {
      corpusSelect.innerHTML = '<option value="">— error loading —</option>';
    }
  }

  async function search() {
    const corpusId = corpusSelect.value;
    const query = queryInput.value.trim();
    const k = parseInt(kSelect.value, 10);

    if (!corpusId) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Select a ready corpus first.</p>';
      return;
    }
    if (!query) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Enter a query to search.</p>';
      queryInput.focus();
      return;
    }

    resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Searching…</p>';
    searchBtn.disabled = true;

    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(corpusId)}/query`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ query, k }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = data.results ?? [];
      const selectedOpt = corpusSelect.options[corpusSelect.selectedIndex];
      const strategy = selectedOpt?.dataset?.strategy ?? 'bm25';

      if (!results.length) {
        resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No results found.</p>';
        return;
      }

      if (strategy === 'hybrid') {
        resultsEl.innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="text-align:left;border-bottom:2px solid var(--border,#ddd)">
                <th style="padding:6px 8px;width:55%">Chunk</th>
                <th style="padding:6px 8px;width:15%;text-align:right">BM25</th>
                <th style="padding:6px 8px;width:15%;text-align:right">Dense</th>
                <th style="padding:6px 8px;width:15%;text-align:right">Fused</th>
              </tr>
            </thead>
            <tbody>
              ${results.map((r) => {
                const text = String(r.chunk?.text ?? '');
                const truncated = text.length > 300 ? text.slice(0, 300) + '…' : text;
                const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '—');
                return `<tr style="border-bottom:1px solid var(--border,#eee);vertical-align:top">
                  <td style="padding:6px 8px;white-space:pre-wrap">${esc(truncated)}<br>
                    <span style="font-size:11px;opacity:0.6">${esc(r.chunk?.source ?? '')} &middot; chunk ${esc(String(r.chunk?.index ?? ''))}</span>
                  </td>
                  <td style="padding:6px 8px;text-align:right">${esc(fmt(r.bm25Score))}</td>
                  <td style="padding:6px 8px;text-align:right">${esc(fmt(r.denseScore))}</td>
                  <td style="padding:6px 8px;text-align:right;font-weight:600">${esc(fmt(r.score))}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        `;
      } else {
        resultsEl.innerHTML = results.map((r) => {
          const text = String(r.chunk?.text ?? '');
          const truncated = text.length > 400 ? text.slice(0, 400) + '…' : text;
          const score = typeof r.score === 'number' ? r.score.toFixed(3) : String(r.score ?? '');
          return `
            <div class="result-card">
              <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem">
                <span class="result-score">score: ${esc(score)}</span>
                <span class="result-source">${esc(r.chunk?.source ?? '')} &middot; chunk ${esc(String(r.chunk?.index ?? ''))}</span>
              </div>
              <div style="font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(truncated)}</div>
            </div>
          `;
        }).join('');
      }
    } catch (err) {
      resultsEl.innerHTML = `<p style="color:var(--text-muted,#888)">Search failed: ${esc(String(err.message ?? err))}</p>`;
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', search);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search();
  });

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  loadCorpora();
}

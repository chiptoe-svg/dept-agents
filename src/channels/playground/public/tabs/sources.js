/**
 * Sources tab — RAG corpus management.
 *
 * Lets the user create corpora, upload files, trigger ingestion,
 * and inspect chunks.
 */

export function mountSources(el) {
  const folder = window.__pg.agent.folder;
  let corpora = [];
  let selectedId = null;

  el.innerHTML = `
    <div class="tab-section" style="padding:16px;max-width:860px">
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
        <h2 style="margin:0">Sources</h2>
        <button id="src-new-btn" class="btn btn-primary">+ New Corpus</button>
      </div>

      <div id="src-new-form" style="display:none;border:1px solid var(--border,#ddd);border-radius:6px;padding:1rem;margin-bottom:1rem">
        <label style="display:block;margin-bottom:0.75rem">Corpus name
          <input id="src-corpus-name" type="text" style="display:block;width:100%;margin-top:0.25rem;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit" placeholder="e.g. Lecture 3 notes">
        </label>

        <div style="margin-bottom:0.75rem">
          <div style="font-size:13px;font-weight:600;margin-bottom:0.4rem;color:var(--text-muted,#555)">Retrieval strategy</div>
          <div id="src-strategy-cards" style="display:flex;gap:0.5rem;flex-wrap:wrap">
            <div class="strategy-card strategy-selected" data-strategy="bm25" style="flex:1;min-width:140px;border:2px solid var(--accent,#5b6ee1);border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer">
              <div style="font-weight:600;font-size:13px">BM25 / Quick</div>
              <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">Keyword search. Fast, no API cost.</div>
            </div>
            <div class="strategy-card" data-strategy="dense" style="flex:1;min-width:140px;border:2px solid transparent;border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer;background:var(--bg-subtle,#f5f5f5)">
              <div style="font-weight:600;font-size:13px">Dense</div>
              <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">Semantic embeddings. Requires OpenAI key.</div>
            </div>
            <div class="strategy-card" data-strategy="hybrid" style="flex:1;min-width:140px;border:2px solid transparent;border-radius:6px;padding:0.6rem 0.75rem;cursor:pointer;background:var(--bg-subtle,#f5f5f5)">
              <div style="font-weight:600;font-size:13px">Hybrid</div>
              <div style="font-size:11px;color:var(--text-muted,#666);margin-top:2px">BM25 + dense. Side-by-side scores.</div>
            </div>
          </div>
          <input id="src-store-strategy" type="hidden" value="bm25">
        </div>

        <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
          <button id="src-create-btn" class="btn btn-primary">Create</button>
          <button id="src-cancel-btn" class="btn">Cancel</button>
        </div>
      </div>

      <div id="src-corpus-list" class="corpus-list"></div>

      <div id="src-detail" style="display:none;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border,#ddd)">
        <h3 id="src-detail-name" style="margin:0 0 0.75rem"></h3>
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap">
          <label style="cursor:pointer">
            <input id="src-file-input" type="file" style="display:none" multiple accept=".txt,.md,.html,.htm,.pdf">
            <span class="btn">Upload files</span>
          </label>
          <button id="src-ingest-btn" class="btn btn-primary">Build corpus</button>
          <span id="src-status-badge" class="status-badge"></span>
          <button id="src-refresh-btn" class="btn" title="Refresh status">&#8635;</button>
        </div>
        <div id="src-chunk-inspector" class="chunk-inspector" style="display:none">
          <h4 style="margin:0 0 0.5rem">Chunks (<span id="src-chunk-count">0</span>)</h4>
          <div id="src-chunk-list"></div>
        </div>
      </div>
    </div>
  `;

  document.title = `Sources — ${window.__pg.agent.name} · Agent Playground`;

  const apiBase = `/api/drafts/${folder}/knowledge/corpora`;

  async function loadList() {
    try {
      const res = await fetch(apiBase, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      corpora = data.corpora ?? [];
    } catch {
      corpora = [];
    }
    renderList();
  }

  function renderList() {
    const listEl = el.querySelector('#src-corpus-list');
    if (!corpora.length) {
      listEl.innerHTML = '<p style="color:var(--text-muted,#888)">No corpora yet. Create one above.</p>';
      return;
    }
    listEl.innerHTML = corpora.map((c) => `
      <div class="corpus-card" data-id="${esc(c.id)}" style="cursor:pointer">
        <span class="corpus-name">${esc(c.name)}</span>
        <span class="corpus-meta">${c.chunkCount ?? 0} chunks</span>
        <span class="corpus-meta" style="font-size:11px;opacity:0.7">${esc(c.storeStrategy ?? 'bm25')}</span>
        <span class="status-badge status-${esc(c.status)}">${esc(c.status)}</span>
        <button class="btn btn-danger" data-del="${esc(c.id)}" title="Delete" style="padding:2px 8px;font-size:12px">&#10005;</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.corpus-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.dataset.del) return;
        selectCorpus(card.dataset.id);
      });
    });
    listEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this corpus?')) return;
        await fetch(`${apiBase}/${encodeURIComponent(btn.dataset.del)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (selectedId === btn.dataset.del) {
          selectedId = null;
          el.querySelector('#src-detail').style.display = 'none';
        }
        await loadList();
      });
    });
  }

  async function selectCorpus(id) {
    selectedId = id;
    const meta = corpora.find((c) => c.id === id);
    if (!meta) return;
    const detail = el.querySelector('#src-detail');
    detail.style.display = 'block';
    el.querySelector('#src-detail-name').textContent = meta.name;
    updateStatusBadge(meta.status);
    await loadInspect(id);
  }

  function updateStatusBadge(status) {
    const badge = el.querySelector('#src-status-badge');
    badge.className = `status-badge status-${status}`;
    badge.textContent = status;
  }

  async function loadInspect(id) {
    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(id)}/inspect`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const inspector = el.querySelector('#src-chunk-inspector');
      if (!data.chunks?.length) { inspector.style.display = 'none'; return; }
      inspector.style.display = 'block';
      el.querySelector('#src-chunk-count').textContent = data.chunks.length;
      el.querySelector('#src-chunk-list').innerHTML = data.chunks.slice(0, 20).map((c) => `
        <div class="chunk-card">
          <div class="chunk-source">${esc(c.source)} &middot; chunk ${c.index}</div>
          <div>${esc(c.text.slice(0, 200))}${c.text.length > 200 ? '&hellip;' : ''}</div>
        </div>
      `).join('');
    } catch {
      /* inspect endpoint may not exist yet */
    }
  }

  el.querySelector('#src-new-btn').addEventListener('click', () => {
    el.querySelector('#src-new-form').style.display = 'block';
    el.querySelector('#src-corpus-name').focus();
  });

  el.querySelector('#src-cancel-btn').addEventListener('click', () => {
    el.querySelector('#src-new-form').style.display = 'none';
    el.querySelector('#src-corpus-name').value = '';
    el.querySelector('#src-store-strategy').value = 'bm25';
    const cards = el.querySelectorAll('.strategy-card');
    cards.forEach((c, i) => {
      c.style.border = i === 0 ? '2px solid var(--accent,#5b6ee1)' : '2px solid transparent';
      c.style.background = i === 0 ? '' : 'var(--bg-subtle,#f5f5f5)';
    });
  });

  el.querySelectorAll('.strategy-card').forEach((card) => {
    card.addEventListener('click', () => {
      el.querySelector('#src-store-strategy').value = card.dataset.strategy;
      el.querySelectorAll('.strategy-card').forEach((c) => {
        c.style.border = '2px solid transparent';
        c.style.background = 'var(--bg-subtle,#f5f5f5)';
      });
      card.style.border = '2px solid var(--accent,#5b6ee1)';
      card.style.background = '';
    });
  });

  el.querySelector('#src-create-btn').addEventListener('click', async () => {
    const name = el.querySelector('#src-corpus-name').value.trim();
    if (!name) { el.querySelector('#src-corpus-name').focus(); return; }
    await fetch(apiBase, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name, sourceType: 'text', storeStrategy: el.querySelector('#src-store-strategy').value || 'bm25' }),
    });
    el.querySelector('#src-corpus-name').value = '';
    el.querySelector('#src-new-form').style.display = 'none';
    await loadList();
  });

  el.querySelector('#src-file-input').addEventListener('change', async (e) => {
    if (!selectedId) return;
    for (const file of e.target.files) {
      const buf = await file.arrayBuffer();
      await fetch(`${apiBase}/${encodeURIComponent(selectedId)}/upload?filename=${encodeURIComponent(file.name)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        body: buf,
      });
    }
    e.target.value = '';
  });

  el.querySelector('#src-ingest-btn').addEventListener('click', async () => {
    if (!selectedId) return;
    await fetch(`${apiBase}/${encodeURIComponent(selectedId)}/ingest`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    updateStatusBadge('ingesting');
    pollStatus(selectedId);
  });

  el.querySelector('#src-refresh-btn').addEventListener('click', async () => {
    if (!selectedId) return;
    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(selectedId)}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const meta = await res.json();
      updateStatusBadge(meta.status);
      if (meta.status === 'ready') await loadInspect(selectedId);
    } catch { /* ignore */ }
  });

  function pollStatus(id) {
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
        if (!res.ok) { clearInterval(iv); return; }
        const meta = await res.json();
        if (selectedId === id) updateStatusBadge(meta.status);
        if (meta.status === 'ready' || meta.status === 'error') {
          clearInterval(iv);
          await loadList();
          if (meta.status === 'ready' && selectedId === id) await loadInspect(id);
        }
      } catch { clearInterval(iv); }
    }, 1500);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  loadList();
}

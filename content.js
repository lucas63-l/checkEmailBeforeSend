(() => {
  'use strict';
  if (globalThis.__draftCheckActive) return;
  globalThis.__draftCheckActive = true;
  const states = new Map();
  let contextEpoch = 0;
  let scheduled = false;

  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  }
  function request(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out after 8 seconds. Work remains pending; select Check draft to retry.')), 8000);
      try {
        chrome.runtime.sendMessage(message).then(response => {
          clearTimeout(timer);
          if (!response?.ok) reject(new Error(response?.error || 'Extension unavailable.'));
          else resolve(response);
        }, error => { clearTimeout(timer); reject(error); });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  function reset(state, message) {
    state.run++;
    state.snapshot = null;
    state.button.disabled = false;
    state.cancel.hidden = true;
    state.view.hidden = true;
    state.popup.hidePopover();
    state.button.textContent = 'Check draft';
    state.results.replaceChildren();
    state.status.textContent = message;
  }
  function snapshot(state) {
    return { ...DraftExtract.extract(state.editor, state.root, state.supported), opportunityId: state.selection.value };
  }
  async function loadOpportunities(state) {
    const load = ++state.load;
    state.selection.disabled = true;
    try {
      const { opportunities } = await request({ type: 'context:get' });
      if (load !== state.load || !state.editor.isConnected) return;
      const selected = state.selection.value;
      state.selection.replaceChildren();
      const none = element('option', 'No opportunity selected — comparisons pending', state.selection);
      none.value = '';
      for (const fact of opportunities) {
        const option = element('option', `${fact.company || 'Unknown company'} · ${fact.role || 'Unknown role'} · ${fact.email || 'Unknown recipient'} · ${fact.id}`, state.selection);
        option.value = fact.id;
      }
      state.selection.value = opportunities.some(f => f.id === selected) ? selected : '';
      state.selection.disabled = false;
    } catch (error) {
      if (load === state.load) {
        state.selection.replaceChildren();
        element('option', 'Opportunities unavailable — reload list to recover', state.selection).value = '';
        reset(state, `Incomplete: opportunities unavailable. ${error.message}`);
      }
    }
  }
  function positionResults(state) {
    const anchor = state.host.getBoundingClientRect();
    const { width } = state.popup.getBoundingClientRect();
    const height = Math.min(460, innerHeight - 24);
    const below = innerHeight - anchor.bottom - 12;
    const above = anchor.top - 12;
    const top = below >= height || below > above ? anchor.bottom + 8 : anchor.top - height - 8;
    state.popup.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, anchor.right - width))}px`;
    state.popup.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, top))}px`;
  }
  function openResults(state) {
    state.popup.showPopover();
    positionResults(state);
  }
  function placeControl(state) {
    const anchor = actionAnchor(state);
    if (anchor) anchor.before(state.host);
    else state.root.prepend(state.host);
  }
  function actionAnchor(state) {
    const toolbar = [...state.root.querySelectorAll('.btC')].find(node => !state.editor.contains(node));
    if (!toolbar) return null;
    return [toolbar.closest('.aDh'), toolbar.closest('table'), toolbar].find(node => node && node !== state.root && state.root.contains(node) && !node.contains(state.editor));
  }
  function render(state, result, draft, revision) {
    state.results.replaceChildren();
    const confirmed = result.findings.filter(f => f.certainty === 'Confirmed').length;
    state.status.textContent = result.findings.length ? `${confirmed} confirmed; ${result.findings.length - confirmed} to review.` : result.completed.length ? 'No inconsistencies found in the completed checks.' : 'Incomplete — no checks completed.';
    element('p', `Incomplete coverage — ${result.pending.length} checks or boundaries pending.`, state.results).className = 'pending';
    const findings = element('div', undefined, state.results);
    let page = 0;
    function showPage() {
      findings.replaceChildren();
      const start = page * 20;
      for (const finding of result.findings.slice(start, start + 20)) {
        const article = element('article', undefined, findings);
        const details = element('details', undefined, article);
        element('summary', `${finding.certainty}: ${finding.explanation}`, details);
        for (const item of finding.evidence) {
          element('div', `${item.field} · offsets ${item.start}–${item.end}`, details);
          element('pre', item.text, details);
        }
      }
      if (result.findings.length > 20) {
        const previous = element('button', 'Previous findings', findings);
        previous.type = 'button';
        previous.disabled = page === 0;
        const next = element('button', 'Next findings', findings);
        next.type = 'button';
        next.disabled = start + 20 >= result.findings.length;
        element('p', `Findings ${start + 1}–${Math.min(start + 20, result.findings.length)} of ${result.findings.length}. All findings remain available.`, findings);
        previous.addEventListener('click', () => { page--; showPage(); });
        next.addEventListener('click', () => { page++; showPage(); });
      }
    }
    showPage();
    const coverage = element('details', undefined, state.results);
    element('summary', 'Coverage and incomplete checks', coverage);
    element('h4', 'Completed', coverage);
    const completed = element('ul', undefined, coverage);
    for (const item of result.completed) element('li', item, completed);
    element('h4', 'Pending / unavailable', coverage);
    const pending = element('ul', undefined, coverage);
    for (const item of result.pending) element('li', item, pending);
    for (const item of result.excluded) {
      element('h4', `Intentionally excluded: ${item.reason}${item.field ? ` · ${item.field} · offsets ${item.start}–${item.end}` : ''}`, coverage);
      element('pre', item.text, coverage);
    }
    const inspected = element('details', undefined, state.results);
    element('summary', `Exact snapshot checked · context revision ${revision}`, inspected);
    element('pre', JSON.stringify(draft, null, 2), inspected);
    state.view.hidden = false;
    openResults(state);
  }
  async function check(state) {
    reset(state, 'Checking this draft locally…');
    const run = state.run;
    const epoch = contextEpoch;
    state.button.disabled = true;
    state.cancel.hidden = false;
    try {
      const draft = snapshot(state);
      state.snapshot = JSON.stringify(draft);
      if (state.snapshot.length > 2000000) throw new Error('Serialized snapshot exceeds 2,000,000 UTF-16 units. No analysis ran; the entire draft remains pending.');
      const { context } = await request({ type: 'context:get' });
      if (run !== state.run || !state.editor.isConnected) return;
      const { result, revision } = await request({ type: 'analyze', draft, revision: context.revision });
      if (run !== state.run || !state.editor.isConnected) return;
      const current = JSON.stringify(snapshot(state));
      const latest = await request({ type: 'context:get' });
      if (run !== state.run || !state.editor.isConnected) return;
      if (current !== state.snapshot || JSON.stringify(snapshot(state)) !== state.snapshot || epoch !== contextEpoch || latest.context.revision !== revision) {
        reset(state, 'Draft or saved context changed. Results are stale; select Check draft again.');
        return;
      }
      render(state, result, draft, revision);
    } catch (error) {
      if (run === state.run) reset(state, `Incomplete: ${error.message} Select Check draft to retry. If the extension was reloaded, reload Gmail to restore the connection.`);
    } finally {
      if (run === state.run) { state.button.disabled = false; state.cancel.hidden = true; }
    }
  }
  function mount(editor, root, supported) {
    const host = document.createElement('div');
    host.setAttribute('data-draft-check', '');
    const shadow = host.attachShadow({ mode: 'open' });
    element('style', `
      :host{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0;flex:none;color-scheme:light;font:13px/1.45 system-ui,sans-serif;color:#202124}
      section{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:4px 0;padding:6px 0;border-top:1px solid #e8eaed}
      .selection{display:flex;align-items:center;gap:8px;flex:1 0 100%;min-width:0}.selection label{flex:1;min-width:0}select{box-sizing:border-box;max-width:100%;width:100%;font:inherit}select:focus-visible{outline:2px solid #174ea6}
      button{flex:none;white-space:nowrap;font:inherit;border:1px solid #b9c5de;border-radius:5px;padding:5px 8px;cursor:pointer;background:#edf3ff;color:#174ea6}
      button:focus-visible,summary:focus-visible{outline:2px solid #174ea6;outline-offset:2px}button:disabled{opacity:.6;cursor:default}
      [hidden]{display:none}p{margin:6px 0}.status{flex:1 1 140px;min-width:0;font-size:12px;margin:0;overflow-wrap:anywhere}
      .popup{position:fixed;inset:auto;margin:0;box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-height:min(460px,calc(100dvh - 24px));overflow:auto;overscroll-behavior:contain;padding:12px;border:1px solid #dadce0;border-radius:10px;background:#fff;color:#202124;box-shadow:0 6px 24px #0003;font:13px/1.45 system-ui,sans-serif}
      .popup-header{display:flex;justify-content:space-between;align-items:center;gap:12px;position:sticky;top:-12px;margin:-12px -12px 8px;padding:10px 12px;background:#fff;border-bottom:1px solid #dadce0;z-index:1}
      article{margin:8px 0;padding:8px;border-left:3px solid #c58b15;background:#fffcf5}
      pre{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0;user-select:text}
      details{margin:8px 0}article details{margin:0}summary{cursor:pointer;color:#174ea6}h4{margin:6px 0}.pending{color:#885500}ul{padding-left:20px}
    `, shadow);
    const section = element('section', undefined, shadow);
    section.setAttribute('aria-label', 'Draft consistency checker');
    const selectionRow = element('div', undefined, section);
    selectionRow.className = 'selection';
    const selectionLabel = element('label', 'Opportunity for this compose', selectionRow);
    const selection = element('select', undefined, selectionLabel);
    element('option', 'Loading opportunities…', selection).value = '';
    const button = element('button', 'Check draft', section);
    button.type = 'button';
    const cancel = element('button', 'Cancel check', section);
    cancel.type = 'button';
    cancel.hidden = true;
    const context = element('button', 'Recipient facts', section);
    context.type = 'button';
    const refresh = element('button', 'Reload opportunities', selectionRow);
    refresh.type = 'button';
    const view = element('button', 'View results', section);
    view.type = 'button';
    view.hidden = true;
    view.setAttribute('aria-haspopup', 'dialog');
    view.setAttribute('aria-controls', 'draft-check-results');
    view.setAttribute('aria-expanded', 'false');
    const status = element('p', 'Local, read-only checks. Runs only when selected.', section);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.className = 'status';
    const popup = element('div', undefined, shadow);
    popup.id = 'draft-check-results';
    popup.className = 'popup';
    popup.setAttribute('popover', 'auto');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Draft check results');
    const header = element('div', undefined, popup);
    header.className = 'popup-header';
    element('strong', 'Draft check results', header);
    const close = element('button', 'Close results', header);
    close.type = 'button';
    close.autofocus = true;
    const results = element('div', undefined, popup);
    const state = { editor, root, supported, host, button, cancel, status, results, popup, view, selection, load: 0, run: 0, snapshot: null };
    selection.addEventListener('change', () => reset(state, 'Opportunity selection changed. Results are stale; select Check draft again.'));
    refresh.addEventListener('click', () => { reset(state, 'Reloading opportunities. Recheck this draft.'); loadOpportunities(state); });
    view.addEventListener('click', () => openResults(state));
    close.addEventListener('click', () => { popup.hidePopover(); view.focus(); });
    popup.addEventListener('toggle', () => view.setAttribute('aria-expanded', String(popup.matches(':popover-open'))));
    button.addEventListener('click', () => check(state));
    cancel.addEventListener('click', () => reset(state, 'Cancelled. Work remains pending; select Check draft to retry.'));
    context.addEventListener('click', async () => {
      try { await request({ type: 'options' }); }
      catch (error) { reset(state, `Incomplete: recipient facts unavailable. ${error.message}`); }
    });
    placeControl(state);
    states.set(editor, state);
    loadOpportunities(state);
  }
  function scan() {
    scheduled = false;
    for (const [editor, state] of states) {
      if (!editor.isConnected || !state.root.contains(editor) || !editor.matches(DraftExtract.EDITOR)) {
        reset(state, 'Closed.'); state.host.remove(); states.delete(editor);
      }
    }
    for (const editor of document.querySelectorAll(DraftExtract.EDITOR)) {
      const association = DraftExtract.composeRoot(editor);
      let state = states.get(editor);
      if (state && state.root !== association.root) {
        reset(state, 'Compose layout changed. Recheck this draft.'); state.host.remove(); states.delete(editor); state = null;
      }
      if (!state) { mount(editor, association.root, association.supported); continue; }
      if (!state.host.isConnected) { placeControl(state); reset(state, 'Compose controls were restored. Recheck this draft.'); }
      const anchor = actionAnchor(state);
      if (anchor && state.host.nextElementSibling !== anchor) placeControl(state);
      if (state.snapshot !== null) {
        try {
          if (JSON.stringify(snapshot(state)) !== state.snapshot) reset(state, 'Draft changed. Results are stale; select Check draft again.');
        } catch (error) { reset(state, `Incomplete extraction: ${error.message}`); }
      }
    }
  }
  function schedule() {
    if (!scheduled) { scheduled = true; queueMicrotask(scan); }
  }
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('input', schedule, true);
  document.addEventListener('change', schedule, true);
  window.addEventListener('resize', () => {
    for (const state of states.values()) if (state.popup.matches(':popover-open')) positionResults(state);
  });
  setInterval(() => { if ([...states.values()].some(state => state.snapshot !== null)) schedule(); }, 500);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recipientContext) {
      contextEpoch++;
      for (const state of states.values()) {
        reset(state, 'Saved recipient facts changed. Results are stale; select Check draft again.');
        loadOpportunities(state);
      }
    }
  });
  scan();
})();

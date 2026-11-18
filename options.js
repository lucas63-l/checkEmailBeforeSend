'use strict';
const records = document.getElementById('records');
const save = document.getElementById('save');
const status = document.getElementById('status');
const editor = document.getElementById('editor');
const fields = { email: 'Recipient email', name: 'Recipient name', company: 'Company', role: 'Role', location: 'Location', date: 'Event date', time: 'Event time' };
let revision;
let verified = false;
let baseline;
let attempted;
const factsKey = facts => JSON.stringify(facts.map(fact => Object.keys(fact).sort().map(key => [key, fact[key]])));

function element(tag, text, parent) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
async function request(message) {
  let timer;
  let response;
  try {
    response = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('No acknowledgement within 8 seconds.')), 8000); })
    ]);
  } catch (error) { error.unconfirmed = true; throw error; }
  finally { clearTimeout(timer); }
  if (!response?.ok) throw new Error(response?.error || 'Extension unavailable.');
  return response;
}
function addRecord(fact) {
  const card = element('fieldset', undefined, records);
  card.dataset.id = fact.id;
  element('legend', 'Opportunity', card);
  for (const [key, title] of Object.entries(fields)) {
    const label = element('label', title, card);
    const input = element('textarea', undefined, label);
    input.rows = 1;
    input.dataset.key = key;
    input.value = fact[key] ?? '';
    input.original = input.value === '' ? undefined : fact[key];
    input.initial = input.value;
  }
  for (const [key, title] of [['aliases', 'Name aliases'], ['companyAliases', 'Company aliases']]) {
    const group = element('fieldset', undefined, card);
    group.dataset.aliases = key;
    element('legend', title, group);
    function addAlias(value = '') {
      const row = element('div', undefined, group);
      const label = element('label', 'Alias', row);
      const input = element('textarea', undefined, label);
      input.rows = 1;
      input.value = value;
      input.original = value;
      input.initial = input.value;
      const remove = element('button', 'Remove alias', row);
      remove.type = 'button';
      remove.addEventListener('click', () => { row.remove(); add.focus(); });
    }
    const add = element('button', 'Add alias', group);
    add.type = 'button';
    add.addEventListener('click', () => addAlias());
    for (const value of fact[key] || []) addAlias(value);
    if (Object.hasOwn(fact, key)) group.dataset.present = 'true';
  }
  const remove = element('button', 'Remove opportunity', card);
  remove.type = 'button';
  remove.addEventListener('click', () => { card.remove(); document.getElementById('add').focus(); });
}
function proposed() {
  return [...records.children].map(card => {
    const fact = { id: card.dataset.id };
    for (const input of card.querySelectorAll('[data-key]')) if (input.value !== '') fact[input.dataset.key] = input.value === input.initial ? input.original : input.value;
    for (const group of card.querySelectorAll('[data-aliases]')) {
      const values = [...group.querySelectorAll('textarea')].map(input => input.value === input.initial ? input.original : input.value);
      if (values.length || group.dataset.present) fact[group.dataset.aliases] = values;
    }
    return fact;
  });
}
function busy(value) {
  editor.disabled = value || revision === undefined;
  save.disabled = value || !verified;
  document.getElementById('reload').disabled = value;
  document.getElementById('verify').disabled = value;
}
async function load(keepEdits = false) {
  busy(true);
  try {
    const { context, activationFailures } = await request({ type: 'context:get' });
    const facts = DraftChecker.opportunities(context);
    document.getElementById('activation').textContent = activationFailures?.length ? `Incomplete activation at installation: ${activationFailures.join('; ')}. Reopen or reload affected Gmail tabs to retry injection.` : '';
    document.getElementById('committed').textContent = JSON.stringify(context, null, 2);
    const committed = factsKey(facts);
    if (keepEdits && revision !== undefined && committed !== baseline && committed !== attempted) {
      verified = false;
      status.textContent = `Verified saved revision ${context.revision}. Other edits changed saved facts. Proposed edits are retained, but saving is blocked to prevent overwriting them. Inspect committed state, then discard edits and reload before making a new proposal.`;
      return;
    }
    if (!keepEdits || revision === undefined) { records.replaceChildren(); facts.forEach(addRecord); }
    revision = context.revision;
    baseline = committed;
    attempted = undefined;
    verified = true;
    status.textContent = `${keepEdits ? 'Verified saved' : 'Loaded'} revision ${revision}. ${keepEdits ? 'Proposed edits retained; inspect committed state before saving again.' : ''}${context.version !== 2 ? ' Legacy facts are preserved. Conversion occurs only when you save.' : ''}`;
  } catch (error) {
    verified = false;
    status.textContent = `Incomplete: ${error.message} Stored state and proposed edits were not changed. Verify saved state to recover.`;
  } finally { busy(false); }
}
save.addEventListener('click', async () => {
  busy(true);
  try {
    const proposal = { version: 2, revision, facts: proposed() };
    DraftChecker.validateContext(proposal);
    attempted = factsKey(proposal.facts);
    const { context } = await request({ type: 'context:save', context: proposal });
    revision = context.revision;
    baseline = attempted;
    attempted = undefined;
    document.getElementById('committed').textContent = JSON.stringify(context, null, 2);
    status.textContent = `Saved revision ${revision}. Existing draft results are invalidated.`;
  } catch (error) {
    if (error.unconfirmed) verified = false;
    status.textContent = error.unconfirmed
      ? `Save outcome unconfirmed: ${error.message} Edits remain here. Verify saved state before retrying; a timeout does not cancel the write.`
      : `Not saved: ${error.message} Proposed edits remain here; last valid state is preserved.`;
  } finally { busy(false); }
});
document.getElementById('add').addEventListener('click', () => { addRecord({ id: crypto.randomUUID() }); records.lastElementChild.querySelector('textarea').focus(); });
document.getElementById('reload').addEventListener('click', () => load());
document.getElementById('verify').addEventListener('click', () => load(true));
load();

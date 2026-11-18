const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const checker = require('../checker.js');

function setup(initial = { revision: 0, facts: [] }) {
  let listener;
  let installed;
  let stored = { recipientContext: initial };
  let failure;
  const injections = [];
  const chrome = {
    runtime: { id: 'test', getURL: name => `chrome-extension://test/${name}`, onMessage: { addListener: fn => listener = fn }, onInstalled: { addListener: fn => installed = fn }, openOptionsPage: async () => {} },
    storage: { local: {
      get: async key => { if (failure === 'get') throw new Error('Read failed'); return { [key]: structuredClone(stored[key]) }; },
      set: async value => { if (failure === 'set') throw new Error('Write failed'); stored = { ...stored, ...structuredClone(value) }; }
    } },
    tabs: { query: async query => { assert.equal(query.url, 'https://mail.google.com/*'); return [{ id: 1 }, { id: 2 }]; } },
    scripting: { executeScript: async config => { if (failure === 'inject') throw new Error('Injection blocked'); injections.push(config); } }
  };
  const sandbox = vm.createContext({ chrome, DraftChecker: checker, importScripts: name => assert.equal(name, 'checker.js') });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), sandbox);
  const request = (message, sender = { id: 'test', url: 'chrome-extension://test/options.html' }) => new Promise(resolve => assert.equal(listener(message, sender, resolve), true));
  return { request, setFailure: value => failure = value, stored: () => stored, installed: () => installed(), injections };
}

test('context saves serialize and reject stale concurrent revisions without partial updates', async () => {
  const app = setup();
  const [first, second] = await Promise.all([
    app.request({ type: 'context:save', context: { revision: 0, facts: [{ email: 'recipient@example.test', name: 'Recipient' }] } }),
    app.request({ type: 'context:save', context: { revision: 0, facts: [{ email: 'colleague@other.example', name: 'Colleague' }] } })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /changed in another window/);
  assert.deepEqual(app.stored().recipientContext, { revision: 1, facts: [{ email: 'recipient@example.test', name: 'Recipient' }] });
});

test('storage failures and invalid whole updates preserve last valid state and allow recovery', async () => {
  const app = setup();
  const before = structuredClone(app.stored());
  app.setFailure('set');
  const fail = await app.request({ type: 'context:save', context: { revision: 0, facts: [{ email: 'recipient@example.test' }] } });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /Write failed/);
  assert.deepEqual(app.stored(), before);
  app.setFailure('get');
  assert.equal((await app.request({ type: 'context:get' })).ok, false);
  app.setFailure(null);
  assert.equal((await app.request({ type: 'context:save', context: { revision: 0, facts: [{ email: 'recipient@example.test' }, { email: 'bad' }] } })).ok, false);
  assert.deepEqual(app.stored(), before);
  assert.equal((await app.request({ type: 'context:save', context: { revision: 0, facts: [{ email: 'recipient@example.test' }] } })).ok, true);
});

test('trust boundary restricts writers and analysis checks the context revision', async () => {
  const app = setup();
  assert.equal((await app.request({ type: 'context:get' }, { id: 'other' })).ok, false);
  assert.equal((await app.request({ type: 'context:save', context: { revision: 0, facts: [] } }, { id: 'test', url: 'https://mail.google.com/' })).ok, false);
  const changed = await app.request({ type: 'analyze', revision: 99, draft: {} });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /context changed/);
});

test('installation injects into already-open Gmail tabs without a reload', async () => {
  const app = setup();
  await app.installed();
  assert.deepEqual(app.injections.map(c => c.target.tabId), [1, 2]);
  for (const injection of app.injections) {
    assert.equal(injection.target.allFrames, true);
    assert.deepEqual(Array.from(injection.files), ['extract.js', 'content.js']);
  }
});

test('failed automatic injection remains visible in installation diagnostics', async () => {
  const app = setup();
  app.setFailure('inject');
  await app.installed();
  const response = await app.request({ type: 'context:get' });
  assert.equal(response.activationFailures.length, 2);
  assert.match(response.activationFailures[0], /Tab 1: Injection blocked/);
});

test('read-only legacy projection and interrupted conversion preserve committed records and retry safely', async () => {
  const legacy = { revision: 7, facts: [{ email: 'recipient@example.test', name: '你好 👩🏽‍💻\r\n é  ', company: 'Example Company', aliases: ['Recipient\r\nAlias'], companyAliases: ['B\\" Ltd'] }] };
  const app = setup(legacy);
  const response = await app.request({ type: 'context:get' });
  assert.deepEqual(app.stored().recipientContext, legacy);
  assert.deepEqual(response.opportunities, checker.opportunities(legacy));
  const proposal = { version: 2, revision: 7, facts: response.opportunities };
  app.setFailure('set');
  assert.equal((await app.request({ type: 'context:save', context: proposal })).ok, false);
  assert.deepEqual(app.stored().recipientContext, legacy);
  app.setFailure(null);
  assert.deepEqual((await app.request({ type: 'context:get' })).context, legacy);
  const committed = await app.request({ type: 'context:save', context: proposal });
  assert.equal(committed.context.revision, 8);
  assert.deepEqual(committed.context.facts.map(({ id, ...fact }) => fact), legacy.facts);
  const uncertainRetry = await app.request({ type: 'context:save', context: proposal });
  assert.equal(uncertainRetry.ok, false);
  assert.deepEqual((await app.request({ type: 'context:get' })).context, structuredClone(committed.context));
  const extra = { ...proposal.facts[0], id: 'second', role: 'sales position' };
  const [first, second] = await Promise.all([
    app.request({ type: 'context:save', context: { version: 2, revision: 8, facts: [...proposal.facts, extra] } }),
    app.request({ type: 'context:save', context: { version: 2, revision: 8, facts: [] } })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(app.stored().recipientContext.facts.length, 2);
});

test('malformed or oversized legacy state remains unresolved on reads, saves and installation', async () => {
  for (const legacy of [
    null,
    { revision: 1, facts: [{ email: 'invalid', name: 'keep me' }] },
    { revision: 1, facts: Array.from({ length: 50 }, (_, i) => ({ email: `${i}@example.test`, name: 'Name', aliases: Array(10).fill('界'.repeat(200)) })) },
    { revision: 1, facts: [{ email: 'recipient@example.test', unsupported: 'retain' }] }
  ]) {
    const app = setup(legacy);
    assert.equal((await app.request({ type: 'context:get' })).ok, false);
    assert.equal((await app.request({ type: 'context:save', context: { version: 2, revision: 1, facts: [] } })).ok, false);
    await app.installed();
    assert.deepEqual(app.stored().recipientContext, legacy);
  }
});

test('worker restart reads the complete committed context and prevents a legacy writer from dropping opportunity IDs', async () => {
  const committed = { version: 2, revision: 9, facts: [{ id: 'first', email: 'recipient@example.test', role: 'research internship' }, { id: 'second', email: 'recipient@example.test', role: 'sales position' }] };
  const restarted = setup(structuredClone(committed));
  assert.deepEqual((await restarted.request({ type: 'context:get' })).context, committed);
  const result = await restarted.request({ type: 'context:save', context: { revision: 9, facts: [{ email: 'recipient@example.test' }] } });
  assert.equal(result.ok, false);
  assert.match(result.error, /older options page/);
  assert.deepEqual(restarted.stored().recipientContext, committed);
});

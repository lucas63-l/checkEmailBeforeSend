importScripts('checker.js');

let queue = Promise.resolve();
async function readContext() {
  const stored = await chrome.storage.local.get('recipientContext');
  return DraftChecker.validateContext(stored.recipientContext === undefined ? DraftChecker.emptyContext() : stored.recipientContext);
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Untrusted caller.');
  if (message.type === 'context:get') {
    const context = await readContext();
    const { activationFailures = [] } = await chrome.storage.local.get('activationFailures');
    return { context, opportunities: DraftChecker.opportunities(context), activationFailures };
  }
  if (message.type === 'context:save') {
    if (sender.url !== chrome.runtime.getURL('options.html')) throw new Error('Only the context options page may save facts.');
    DraftChecker.validateContext(message.context);
    const current = await readContext();
    if (current.version === 2 && message.context.version !== 2) throw new Error('An older options page cannot replace opportunities. Reload the options page; proposed edits remain unchanged.');
    if (message.context.revision !== current.revision) throw new Error('Saved context changed in another window. Reload saved facts before editing again. Your proposed text is still here.');
    const next = { ...message.context, revision: current.revision + 1 };
    DraftChecker.validateContext(next);
    await chrome.storage.local.set({ recipientContext: next });
    return { context: next };
  }
  if (message.type === 'analyze') {
    const context = await readContext();
    if (context.revision !== message.revision) throw new Error('Recipient context changed. Recheck the current draft.');
    return { result: DraftChecker.analyze(message.draft, context), revision: context.revision };
  }
  if (message.type === 'options') { await chrome.runtime.openOptionsPage(); return {}; }
  throw new Error('Unknown request.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const task = queue.then(() => handle(message, sender));
  queue = task.catch(() => {});
  task.then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  let activationFailures;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
    const results = await Promise.allSettled(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['extract.js', 'content.js'] })));
    activationFailures = results.flatMap((result, i) => result.status === 'rejected' ? [`Tab ${tabs[i].id}: ${result.reason.message}`] : []);
  } catch (error) { activationFailures = [error.message]; }
  await chrome.storage.local.set({ activationFailures });
});

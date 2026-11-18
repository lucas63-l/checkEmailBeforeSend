const { test, expect } = require('@playwright/test');
const path = require('node:path');
const project = path.resolve(__dirname, '../..');

function compose(id, variant = 'new', body = 'Hi Recipient,\nI am interested in an internship at Example Company.') {
  const root = variant === 'reply' ? 'ip' : 'M9';
  return `<div id="${id}" class="${root}" ${variant === 'popout' ? 'role="dialog"' : ''}>
    <input name="subjectbox" value="Internship interest at Other Company">
    <div><span email="recipient@example.test" name="Recipient">Recipient</span><input name="to" value="recipient@example.test" type="hidden"></div>
    <div class="aQH"></div>
    <div role="textbox" contenteditable="true" g_editable="true" aria-multiline="true" style="white-space:pre-wrap">${body}</div>
  </div>`;
}
async function init(page, html = compose('first')) {
  await page.setContent(`<html lang="en"><body><main>${html}</main></body></html>`);
  await page.addScriptTag({ path: path.join(project, 'checker.js') });
  await page.evaluate(() => {
    window.calls = [];
    window.contextValue = { revision: 0, facts: [] };
    window.contextListeners = [];
    window.hold = false;
    window.releases = [];
    window.fail = null;
    window.chrome = {
      storage: { onChanged: { addListener: f => window.contextListeners.push(f) } },
      runtime: { sendMessage: async message => {
        window.calls.push(structuredClone(message));
        if (window.fail) return { ok: false, error: window.fail };
        if (message.type === 'context:get') return { ok: true, context: structuredClone(window.contextValue), opportunities: window.DraftChecker.opportunities(window.contextValue) };
        if (message.type === 'options') return { ok: true };
        if (message.type === 'analyze') {
          const result = window.DraftChecker.analyze(message.draft, window.contextValue);
          if (window.hold) await new Promise(resolve => window.releases.push(resolve));
          return { ok: true, result, revision: message.revision };
        }
      } }
    };
  });
  await page.addScriptTag({ path: path.join(project, 'extract.js') });
  await page.addScriptTag({ path: path.join(project, 'content.js') });
}
const control = (page, id) => page.locator(`#${id}`).getByRole('button', { name: 'Check draft', exact: true });
const status = (page, id) => page.locator(`#${id}`).getByRole('status');

for (const variant of ['new', 'reply', 'forward', 'popout']) {
  test(`${variant}: already-open and newly-opened compose automatically get exactly one working control`, async ({ page }) => {
    await init(page, compose('first', variant));
    await expect(control(page, 'first')).toHaveCount(1);
    expect(await page.evaluate(() => window.calls.filter(c => c.type === 'analyze').length)).toBe(0);
    await page.locator('main').evaluate((main, html) => main.insertAdjacentHTML('beforeend', html), compose('second', variant));
    await expect(control(page, 'second')).toHaveCount(1);
    await control(page, 'first').click();
    await expect(status(page, 'first')).toContainText('to review');
    await expect(page.locator('#first')).toContainText('interest at Other Company');
    await expect(page.locator('#first')).toContainText('recipient@example.test');
    await expect(status(page, 'second')).toHaveText('Local, read-only checks. Runs only when selected.');
    const snapshots = await page.evaluate(() => window.calls.filter(c => c.type === 'analyze'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].draft.body).toContain('internship at Example Company');
  });
}

test('multiple drafts remain isolated through navigation, rerender, minimize, close and reopen', async ({ page }) => {
  await init(page, compose('first') + compose('second', 'reply', 'Hi Recipient,\n[NAME]'));
  await control(page, 'second').click();
  await expect(status(page, 'second')).toContainText('1 confirmed');
  await page.locator('#second').evaluate(root => root.hidden = true);
  await page.locator('#second').evaluate(root => root.hidden = false);
  await expect(control(page, 'second')).toHaveCount(1);
  await page.evaluate(() => location.hash = '#inbox/another');
  await expect(control(page, 'first')).toHaveCount(1);
  await page.locator('#second [data-draft-check]').evaluate(host => host.remove());
  await expect(control(page, 'second')).toHaveCount(1);
  await expect(status(page, 'second')).toContainText('restored');
  await page.locator('#second').evaluate(root => root.remove());
  await expect(page.locator('[data-draft-check]')).toHaveCount(1);
  await page.locator('main').evaluate((main, html) => main.insertAdjacentHTML('beforeend', html), compose('second', 'forward', 'fresh draft'));
  await expect(status(page, 'second')).toContainText('Runs only when selected');
  await page.locator('#first [contenteditable]').evaluate(editor => editor.outerHTML = '<div role="textbox" contenteditable="true" aria-multiline="true">replacement</div>');
  await expect(control(page, 'first')).toHaveCount(1);
});

test('structured quotes/signatures excluded; ambiguous and post-quote new text kept exactly', async ({ page }) => {
  await init(page, compose('first', 'new', 'Hi Recipient,<div>你好 👩🏽‍💻 é   </div><div class="gmail_quote">[COMPANY] quoted</div><div>new [NAME]</div><div class="gmail_signature" data-smartmail="gmail_signature">[ROLE] signature</div><blockquote>unmarked [DATE]</blockquote>'));
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('2 confirmed');
  const draft = await page.evaluate(() => window.calls.find(c => c.type === 'analyze').draft);
  expect(draft.rawBody).toContain('[COMPANY] quoted');
  expect(draft.body).not.toContain('[COMPANY]');
  expect(draft.body).not.toContain('[ROLE]');
  expect(draft.body).toContain('你好 👩🏽‍💻 é   \nnew [NAME]\nunmarked [DATE]');
  expect(draft.excluded.map(e => e.text)).toEqual(['[COMPANY] quoted', '[ROLE] signature']);
  expect(draft.pending.some(p => p.includes('Ambiguous'))).toBe(true);
});

test('read-only checks preserve exact Unicode multiline evidence and render hostile text safely', async ({ page }) => {
  await init(page);
  const body = '\tHi Recipient,\n\n你好 👩🏽‍💻 é  [NAME]\r\n  <img src=x onerror="window.pwned=1">  ';
  await page.locator('#first [contenteditable]').evaluate((editor, value) => editor.textContent = value, body);
  const before = await page.locator('#first [contenteditable]').evaluate(editor => editor.innerHTML);
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('1 confirmed');
  const draft = await page.evaluate(() => window.calls.find(c => c.type === 'analyze').draft);
  expect(draft.body).toBe(body);
  expect(draft.rawBody).toBe(body);
  expect(await page.locator('#first [contenteditable]').evaluate(editor => editor.innerHTML)).toBe(before);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(await page.locator('#first [data-draft-check]').evaluate(host => host.shadowRoot.querySelectorAll('img').length)).toBe(0);
});

test('mutations in every relevant field invalidate displayed success', async ({ page }) => {
  await init(page, compose('first', 'new', 'Hi Recipient,\nAll fine.'));
  await page.locator('[name="subjectbox"]').fill('Hello');
  for (const field of ['body', 'subject', 'recipient', 'attachment', 'context']) {
    await control(page, 'first').click();
    await expect(status(page, 'first')).toHaveText('No inconsistencies found in the completed checks.');
    await page.evaluate(field => {
      if (field === 'body') document.querySelector('[contenteditable]').append('changed');
      if (field === 'subject') { const input = document.querySelector('[name="subjectbox"]'); input.value = 'Changed'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      if (field === 'recipient') document.querySelector('[email]').setAttribute('name', 'Recipient Other');
      if (field === 'attachment') document.querySelector('.aQH').innerHTML = '<span class="aV3">résumé.pdf</span>';
      if (field === 'context') { window.contextValue.revision++; for (const listener of window.contextListeners) listener({ recipientContext: {} }, 'local'); }
    }, field);
    await expect(status(page, 'first')).toContainText('stale');
    await expect(page.locator('#first').getByText('No inconsistencies found in the completed checks.', { exact: true })).toHaveCount(0);
  }
});

test('mutation during analysis, cancellation, retries and out-of-order completion never restore stale findings', async ({ page }) => {
  await init(page);
  await page.evaluate(() => window.hold = true);
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(1);
  await page.locator('[contenteditable]').fill('new [NAME]');
  await expect(status(page, 'first')).toContainText('stale');
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(2);
  await page.evaluate(() => window.releases[1]());
  await expect(status(page, 'first')).toContainText('1 confirmed');
  await page.evaluate(() => window.releases[0]());
  await expect(status(page, 'first')).toContainText('1 confirmed');
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(3);
  await page.getByRole('button', { name: 'Cancel check' }).click();
  await page.evaluate(() => window.releases[2]());
  await expect(status(page, 'first')).toContainText('Cancelled');
  await page.evaluate(() => window.hold = false);
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('1 confirmed');
  expect(await page.locator('#first article').count()).toBe(2);
});

test('storage, extraction, layout and timeout failures stay visibly incomplete and recover', async ({ page }) => {
  await init(page);
  await page.evaluate(() => window.fail = 'Storage unavailable');
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('Incomplete: Storage unavailable');
  await page.evaluate(() => { window.fail = null; window.realExtract = DraftExtract.extract; DraftExtract.extract = () => { throw new Error('Synthetic extraction failure'); }; });
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('Incomplete: Synthetic extraction failure');
  await page.evaluate(() => { DraftExtract.extract = window.realExtract; window.hold = true; });
  await page.clock.install();
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(1);
  await page.clock.fastForward(8100);
  await expect(status(page, 'first')).toContainText('Timed out');
  await page.evaluate(() => { window.hold = false; window.releases[0](); });
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('to review');
});

test('inherited reply subject and unknown attachment layout are pending, never silently filtered', async ({ page }) => {
  await init(page, `<div class="thread"><h2 class="hP">Internship interest at Other Company</h2>${compose('first', 'reply')}</div>`);
  await page.locator('[name="subjectbox"]').evaluate(node => node.remove());
  await page.locator('.aQH').evaluate(node => node.innerHTML = '<span>unknown-file.pdf</span>');
  await control(page, 'first').click();
  const draft = await page.evaluate(() => window.calls.find(c => c.type === 'analyze').draft);
  expect(draft.subject).toBe('Internship interest at Other Company');
  expect(draft.pending.some(p => p.includes('exact outgoing subject'))).toBe(true);
  expect(draft.pending.some(p => p.includes('attachment layout'))).toBe(true);
  await expect(page.locator('#first')).toContainText('Incomplete coverage');
});

test('oversized draft keeps full opposite-end evidence and reports no completed checks', async ({ page }) => {
  await init(page);
  const body = '[NAME]\n' + 'x'.repeat(200001) + '\n[COMPANY]';
  await page.locator('[contenteditable]').evaluate((editor, value) => editor.textContent = value, body);
  await control(page, 'first').click();
  await expect(status(page, 'first')).toHaveText('Incomplete — no checks completed.');
  const draft = await page.evaluate(() => window.calls.find(c => c.type === 'analyze').draft);
  expect(draft.body).toBe(body);
  await expect(page.locator('#first')).toContainText('entire draft remains pending');
});

test('reinjection does not duplicate controls or handlers', async ({ page }) => {
  await init(page);
  await page.addScriptTag({ path: path.join(project, 'content.js') });
  await expect(control(page, 'first')).toHaveCount(1);
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('to review');
  expect(await page.evaluate(() => window.calls.filter(c => c.type === 'analyze').length)).toBe(1);
});

test('all findings remain accessible across pages without truncation or duplicates', async ({ page }) => {
  await init(page, compose('first', 'new', Array(41).fill('[NAME]').join('\n')));
  await page.locator('[name="subjectbox"]').fill('Hello');
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('41 confirmed');
  await expect(page.locator('#first article')).toHaveCount(20);
  await expect(page.locator('#first')).toContainText('Findings 1–20 of 41');
  await page.getByRole('button', { name: 'Next findings' }).click();
  await expect(page.locator('#first')).toContainText('Findings 21–40 of 41');
  await expect(page.locator('#first article')).toHaveCount(20);
  await page.getByRole('button', { name: 'Next findings' }).click();
  await expect(page.locator('#first')).toContainText('Findings 41–41 of 41');
  await expect(page.locator('#first article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Next findings' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous findings' }).click();
  await expect(page.locator('#first')).toContainText('Findings 21–40 of 41');
});

test('programmatic subject changes without events invalidate results on the snapshot watcher', async ({ page }) => {
  await init(page, compose('first', 'new', 'Hi Recipient, all fine.'));
  await page.locator('[name="subjectbox"]').fill('Hello');
  await control(page, 'first').click();
  await expect(status(page, 'first')).toHaveText('No inconsistencies found in the completed checks.');
  await page.evaluate(() => document.querySelector('[name="subjectbox"]').value = 'Changed without event');
  await expect(status(page, 'first')).toContainText('stale');
});

test('unsupported editable container retains its automatic control and pending association', async ({ page }) => {
  await init(page, '<section id="first"><div role="textbox" contenteditable="true" aria-multiline="true">[NAME]</div></section>');
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('1 confirmed');
  const draft = await page.evaluate(() => window.calls.find(c => c.type === 'analyze').draft);
  expect(draft.pending.some(p => p.includes('Unrecognized compose'))).toBe(true);
  expect(draft.pending.some(p => p.includes('Subject field is unavailable'))).toBe(true);
});

test('results stay within the viewport without displacing Gmail compose fields or actions', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await init(page, `<style>
    body{margin:0}header{position:fixed;top:0;left:0;right:0;height:64px;background:#e8eef8;z-index:10}
    .M9{position:fixed;top:80px;bottom:12px;right:12px;width:600px;display:flex;flex-direction:column;background:white}
    .compose-fields{flex:1;min-height:0;overflow:auto}.btC{flex:none;padding:8px;display:flex;gap:8px;align-items:center}
  </style><header>Gmail header</header><div id="first" class="M9">
    <div class="compose-fields"><input name="subjectbox" value="Internship interest at Other Company">
    <span email="recipient@example.test" name="Recipient">Recipient</span><div class="aQH"></div>
    <div role="textbox" contenteditable="true" g_editable="true">Hi Colleague,<br>[NAME]<br>Please find attached my CV.<br>Target role: Research intern<br>Target role: Sales lead</div></div>
    <div class="btC"><button type="button">Send</button></div>
  </div>`);
  const subject = page.locator('[name="subjectbox"]');
  const before = await subject.boundingBox();
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('2 confirmed');
  const after = await subject.boundingBox();
  expect(after.y).toBe(before.y);
  const host = await page.locator('[data-draft-check]').boundingBox();
  expect(host.height).toBeLessThan(100);
  await expect(page.locator('.btC [data-draft-check]')).toHaveCount(0);
  const popup = page.getByRole('dialog', { name: 'Draft check results' });
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(12);
  expect(box.y + box.height).toBeLessThanOrEqual(688);
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(888);
  const finding = popup.locator('article').filter({ hasText: 'The text claims an attachment' });
  await expect(finding.locator('pre').first()).toBeHidden();
  await finding.locator('summary').click();
  await expect(finding.locator('pre').first()).toHaveText('Please find attached');
  const expanded = await popup.boundingBox();
  expect(expanded.y + expanded.height).toBeLessThanOrEqual(688);
  await page.getByRole('button', { name: 'Close results' }).click();
  await expect(popup).toBeHidden();
  await expect(control(page, 'first')).toBeVisible();
  await page.getByRole('button', { name: 'View results' }).click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await page.screenshot({ path: path.join(project, 'test-results', 'compact-compose.png'), fullPage: true });
  await page.getByRole('button', { name: 'View results' }).click();
  await page.screenshot({ path: path.join(project, 'test-results', 'compose-results-popup.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 400 });
  await expect.poll(async () => {
    const resized = await popup.boundingBox();
    return resized.x >= 12 && resized.y >= 12 && resized.x + resized.width <= 348 && resized.y + resized.height <= 388;
  }).toBe(true);
});

test('toolbar-like markup in the email body is never used for extension controls', async ({ page }) => {
  await init(page, compose('first', 'new', '<div class="btC">Pasted content [NAME]</div>'));
  const editor = page.locator('#first [contenteditable]');
  const before = await editor.innerHTML();
  await expect(editor.locator('[data-draft-check]')).toHaveCount(0);
  await control(page, 'first').click();
  await expect(status(page, 'first')).toContainText('1 confirmed');
  expect(await editor.innerHTML()).toBe(before);
});

for (const zoom of [1, 2]) {
  test(`checker uses its own row above the full Gmail toolbar at ${zoom * 100}% zoom-equivalent width`, async ({ page }) => {
    await page.setViewportSize({ width: 1100 / zoom, height: 900 / zoom });
    await init(page, `<style>
      body{margin:0;font:13px Arial}.M9{width:480px;max-width:calc(100vw - 24px);margin:12px;background:#fff}
      .formatting{height:40px;background:#eaf0fa;border-radius:20px;display:flex;align-items:center;padding:0 12px}
      .native-actions{width:100%;border-collapse:collapse;height:40px}.btC{height:40px;white-space:nowrap;padding:0}
      .native-actions button{font:13px Arial;padding:6px;border:0;background:transparent}.native-actions button:first-child{background:#0b57d0;color:white;border-radius:20px;padding:10px 16px}
    </style><div id="first" class="M9">
      <input name="subjectbox" value="Hello"><span email="recipient@example.test" name="Recipient">Recipient</span><div class="aQH"></div>
      <div role="textbox" contenteditable="true" g_editable="true">Hi Recipient, [NAME]</div>
      <div class="aDh"><div class="formatting">Undo　Redo　 Sans Serif　 B　 I　 U</div>
      <table class="native-actions"><tbody><tr><td class="btC"><button type="button">Send</button><button type="button">Formatting</button><button type="button">Attach</button><button type="button">Link</button><button type="button">More</button><button type="button">Discard</button></td></tr></tbody></table></div>
    </div>`);
    const host = page.locator('[data-draft-check]');
    expect(await host.evaluate(node => node.closest('.aDh'))).toBeNull();
    expect(await host.evaluate(node => node.nextElementSibling?.className)).toBe('aDh');
    const toolbar = page.locator('.native-actions');
    const before = await toolbar.boundingBox();
    expect(before.height).toBeLessThanOrEqual(42);
    await control(page, 'first').click();
    await expect(status(page, 'first')).toContainText('1 confirmed');
    await page.getByRole('button', { name: 'Close results' }).click();
    const after = await toolbar.boundingBox();
    expect(after.height).toBe(before.height);
    expect(after.width).toBe(before.width);
    const controlBox = await host.boundingBox();
    const formattingBox = await page.locator('.formatting').boundingBox();
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(formattingBox.y);
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(1100 / zoom);
    const buttons = ['Check draft', 'Recipient facts', 'View results'];
    const boxes = await Promise.all(buttons.map(name => page.getByRole('button', { name, exact: true }).boundingBox()));
    expect(boxes.every(box => box.y === boxes[0].y)).toBe(true);
    await page.locator('.aDh').evaluate(node => node.outerHTML = node.outerHTML);
    await expect(host).toHaveCount(1);
    expect(await host.evaluate(node => node.nextElementSibling?.className)).toBe('aDh');
    await page.screenshot({ path: path.join(project, 'test-results', `toolbar-row-${zoom * 100}.png`), fullPage: true });
  });
}

test('opportunity selection stays with its editor and selection/fact changes cancel in-flight results', async ({ page }) => {
  await init(page, compose('first') + compose('second'));
  await page.evaluate(() => {
    window.contextValue = { version: 2, revision: 1, facts: [
      { id: 'research', email: 'recipient@example.test', company: 'Example Company', role: 'research internship' },
      { id: 'sales', email: 'recipient@example.test', company: 'Other Company', role: 'sales position' }
    ] };
    for (const listener of window.contextListeners) listener({ recipientContext: {} }, 'local');
  });
  const first = page.locator('#first').getByRole('combobox');
  const second = page.locator('#second').getByRole('combobox');
  await expect(first.locator('option')).toHaveCount(3);
  await expect(first).toHaveValue('');
  await expect(second).toHaveValue('');
  await first.selectOption('research');
  await second.selectOption('sales');
  await page.evaluate(() => window.hold = true);
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(1);
  await first.selectOption('sales');
  await expect(status(page, 'first')).toContainText('stale');
  await page.evaluate(() => window.releases[0]());
  await expect(page.locator('#first').getByRole('button', { name: 'View results' })).toBeHidden();
  await expect(second).toHaveValue('sales');
  await control(page, 'first').click();
  await expect.poll(() => page.evaluate(() => window.releases.length)).toBe(2);
  await page.evaluate(() => {
    window.contextValue.facts[1].role = 'another role';
    window.contextValue.revision++;
    for (const listener of window.contextListeners) listener({ recipientContext: {} }, 'local');
    window.releases[1]();
  });
  await expect(status(page, 'first')).toContainText('stale');
  await expect(page.locator('#first').getByRole('button', { name: 'View results' })).toBeHidden();
  await page.locator('#first').evaluate(root => root.hidden = true);
  await page.locator('#first').evaluate(root => root.hidden = false);
  await expect(first).toHaveValue('sales');
  await page.locator('#first [data-draft-check]').evaluate(node => node.remove());
  await expect(first).toHaveValue('sales');
  await page.locator('#first').evaluate(root => root.remove());
  await page.locator('main').evaluate((main, html) => main.insertAdjacentHTML('beforeend', html), compose('first'));
  await expect(page.locator('#first').getByRole('combobox')).toBeEnabled();
  await expect(page.locator('#first').getByRole('combobox')).toHaveValue('');
  await expect(second).toHaveValue('sales');
  await page.locator('#second [contenteditable]').evaluate(editor => editor.outerHTML = editor.outerHTML);
  await expect(page.locator('#second').getByRole('combobox')).toBeEnabled();
  await expect(page.locator('#second').getByRole('combobox')).toHaveValue('');
});

test('classified previous employment keeps complete evidence and other checks active in the popover', async ({ page }) => {
  const previous = 'My previous role was in sales at Other Company.';
  await init(page, compose('first', 'new', previous + ' I’m applying for the research internship at Example Company in City A.'));
  await page.locator('[name="subjectbox"]').fill('Application for the research internship at Example Company');
  await control(page, 'first').click();
  await expect(status(page, 'first')).toHaveText('No inconsistencies found in the completed checks.');
  await page.getByText('Coverage and incomplete checks', { exact: true }).click();
  await expect(page.locator('#first pre').filter({ hasText: previous }).first()).toHaveText(previous);
  await expect(page.locator('#first')).toContainText('excluded only from target opportunity comparisons');
  await expect(page.locator('#first')).toContainText('No valid explicit opportunity selection');
});

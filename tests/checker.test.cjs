const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, validateContext, emptyContext, MAX_DRAFT, MAX_WIRE } = require('../checker.js');
const draft = changes => ({ opportunityId: 'legacy-0', recipients: [{ email: 'recipient@example.test', name: 'Recipient' }], subject: '', body: '', rawBody: '', rawHtml: '', attachments: [], pending: [], excluded: [], ...changes });
const context = { revision: 1, facts: [{ email: 'recipient@example.test', name: 'Recipient', aliases: ['Recipient Alias'], company: 'Example Company', companyAliases: ['Example Company Ltd'], role: 'Research intern', location: 'City A', date: '2026-12-01', time: '10:00 UTC' }, { email: 'colleague@other.example', name: 'Colleague Other', company: 'Other Company', role: 'Sales lead' }] };

test('cross-company draft yields exact subject and recipient evidence without setup', () => {
  const result = analyze(draft({ subject: 'Internship interest at Other Company', body: 'Hi Recipient,\nI am interested in an internship at Example Company.' }), emptyContext());
  const cross = result.findings.find(f => f.code === 'company-across-fields');
  assert.ok(cross);
  assert.equal(cross.certainty, 'Review');
  assert.deepEqual(cross.evidence.map(e => e.text), ['Internship interest at Other Company', 'internship at Example Company.']);
  assert.ok(result.findings.find(f => f.code === 'domain-company').evidence.some(e => e.text === 'recipient@example.test'));
});

test('greeting mismatch, all supported labels, filename conflict and placeholder have evidence', () => {
  const result = analyze(draft({ body: 'Dear Colleague,\nRecipient name: Colleague\nTarget company: Other Company\nTarget role: Sales lead\nTarget location: City B\nEvent date: 2026-12-02\nEvent time: 11:00 UTC\n[COMPANY]', attachments: ['Other_Company-cover-letter.pdf'] }), context);
  for (const code of ['greeting', 'context-name', 'context-company', 'context-role', 'context-location', 'context-date', 'context-time', 'attachment-context', 'placeholder']) {
    assert.ok(result.findings.some(f => f.code === code && f.evidence.length > 0), code);
  }
  assert.equal(result.findings.find(f => f.code === 'placeholder').certainty, 'Confirmed');
});

test('different entities, dates and aliases are legitimate; no arbitrary name/date scanning', () => {
  const result = analyze(draft({ subject: 'Internship interest at Example Company Ltd', body: 'Hi Recipient Alias,\nAt Other Company I worked with Colleague. I moved from City B to City A.\nThe first interview was 2026-11-01; the second is 2026-12-01.\nTarget company: Example Company Ltd\nTarget role: Research intern\nEvent date: 2026-12-01' }), context);
  assert.deepEqual(result.findings, []);
  assert.ok(result.pending.some(p => p.includes('semantic')));
  assert.ok(result.completed.length > 0);
});

test('same explicit slot differing across sections requires review', () => {
  const result = analyze(draft({ subject: 'Event date: 2026-12-01', body: 'Event date: 2026-12-02\nTarget role: Research intern\nTarget role: Sales lead' }), emptyContext());
  assert.ok(result.findings.some(f => f.code === 'conflicting-date' && f.evidence.length === 2 && f.certainty === 'Review'));
  assert.ok(result.findings.some(f => f.code === 'conflicting-role'));
});

test('attachment claims: missing, present, negated and unknown extraction', () => {
  const missing = analyze(draft({ body: 'Please find attached my CV.' }), context);
  assert.equal(missing.findings.find(f => f.code === 'missing-attachment').certainty, 'Confirmed');
  assert.equal(analyze(draft({ body: 'Please find attached my CV.', attachments: ['CV.pdf'] }), context).findings.length, 0);
  assert.equal(analyze(draft({ body: 'I have not attached a file.' }), context).findings.length, 0);
  const unknown = analyze(draft({ body: 'Please find attached my CV.', pending: ['Unknown attachment layout'] }), context);
  assert.equal(unknown.findings.find(f => f.code === 'missing-attachment').certainty, 'Review');
  assert.ok(!unknown.completed.some(c => c.startsWith('Explicit attachment claims')));
});

test('empty and multiple-recipient drafts retain incomplete checks', () => {
  const result = analyze(draft({ recipients: [] }), emptyContext());
  assert.equal(result.findings.length, 0);
  assert.ok(result.pending.some(p => p.includes('recipient')));
  const group = analyze(draft({ recipients: [{ email: 'recipient@example.test', name: 'Recipient' }, { email: 'colleague@other.example', name: 'Colleague' }], body: 'Hello Colleague,' }), context);
  assert.ok(!group.findings.some(f => f.code === 'greeting'));
});

test('UTF-16 limits are exact; oversized opposite-end evidence is never partially analyzed', () => {
  const base = draft();
  const overhead = base.recipients[0].email.length + base.recipients[0].name.length;
  const text = 'x'.repeat(MAX_DRAFT - overhead);
  assert.ok(analyze(draft({ body: text, rawBody: text }), context).completed.length > 0);
  const over = 'Target company: Other Company\n' + text + '\nTarget company: Example Company';
  const result = analyze(draft({ body: over, rawBody: over }), context);
  assert.deepEqual(result.completed, []);
  assert.deepEqual(result.findings, []);
  assert.ok(result.pending.some(p => p.includes('entire draft remains pending')));
  const wire = analyze(draft({ rawHtml: 'x'.repeat(MAX_WIRE) }), context);
  assert.equal(wire.completed.length, 0);
});

test('Unicode, whitespace, line breaks and exact evidence offsets survive JSON', () => {
  const body = 'Hi Recipient,\n\n\t你好 👩🏽‍💻 e\u0301\u00a0 — [NAME]\r\n  end  ';
  const snapshot = draft({ body, rawBody: body });
  const restored = JSON.parse(JSON.stringify(snapshot));
  const result = analyze(restored, context);
  assert.equal(restored.body, body);
  const item = result.findings.find(f => f.code === 'placeholder').evidence[0];
  assert.equal(body.slice(item.start, item.end), '[NAME]');
  assert.equal(item.start, body.indexOf('[NAME]'));
});

test('invalid context rejects whole update, including duplicate identities and size limits', () => {
  assert.equal(validateContext(context), context);
  for (const invalid of [ { revision: 0, facts: [{ email: 'bad' }] }, { revision: 0, facts: [context.facts[0], context.facts[0]] }, { revision: 0, facts: [{ email: 'a@example.test', company: '' }] }, { revision: 0, facts: [{ email: 'a@example.test', aliases: Array(11).fill('a') }] }, { revision: 0, facts: [{ email: 'a@example.test', role: 'x'.repeat(201) }] }, { revision: 0, facts: [{ email: 'a@example.test', extra: 'x' }] } ]) assert.throws(() => validateContext(invalid));
  const large = { revision: 0, facts: Array.from({ length: 50 }, (_, i) => ({ email: `${i}@example.test`, name: 'Name', aliases: Array(10).fill('界'.repeat(200)) })) };
  assert.throws(() => validateContext(large), /48,000/);
});

test('malformed input is failure, not empty success', () => {
  assert.throws(() => analyze({}, context), /Invalid draft/);
  assert.throws(() => analyze(draft({ attachments: [null] }), context), /Invalid draft fields/);
});

test('sentence-initial company phrase and explicit filename target work with just one saved recipient', () => {
  const result = analyze(draft({ subject: 'Application at Other Company', body: 'Internship at Example Company', attachments: ['Cover_letter_for_Other_Company.pdf'] }), { revision: 0, facts: [context.facts[0]] });
  assert.ok(result.findings.some(f => f.code === 'target-company'));
  assert.ok(result.findings.some(f => f.code === 'company-across-fields'));
  assert.ok(result.findings.some(f => f.code === 'attachment-target' && f.evidence[0].text === 'Cover_letter_for_Other_Company.pdf'));
  assert.throws(() => validateContext({ revision: 0, facts: [{ email: 'a@example.test', aliases: ['A'] }] }), /canonical/);
});

const { opportunities, MAX_OPPORTUNITY_BYTES } = require('../checker.js');
const opportunityContext = { version: 2, revision: 3, facts: [
  { id: 'research', email: 'recipient@example.test', name: 'Recipient', aliases: ['Recipient Alias'], company: 'Example Company', companyAliases: ['Example Company Ltd'], role: 'research internship', location: 'City A' },
  { id: 'sales', email: 'recipient@example.test', company: 'Other Company', role: 'sales position' }
] };

test('ordinary application prose compares every company and role with exact original evidence', () => {
  const subject = 'Application for the sales position at Other Company';
  const body = '👩🏽‍💻 I’m applying for the research internship at Example Company in City A.\n' + 'x'.repeat(150000) + '\nI am applying for the sales position at Other Company.';
  const input = draft({ opportunityId: 'research', subject, body, rawBody: body });
  const result = analyze(input, opportunityContext);
  for (const code of ['target-company', 'target-role', 'company-across-fields', 'role-across-fields']) assert.ok(result.findings.some(f => f.code === code), code);
  assert.equal(result.findings.filter(f => f.code === 'target-role').length, 2);
  assert.equal(result.findings.filter(f => f.code === 'target-company').length, 2);
  for (const finding of result.findings) {
    for (const item of finding.evidence) {
      if (item.field === 'Body' || item.field === 'Subject') assert.equal(input[item.field.toLowerCase()].slice(item.start, item.end), item.text);
      if (item.field.startsWith('Saved role')) assert.equal(item.text, opportunityContext.facts[0].role);
    }
  }
  assert.ok(result.findings.some(f => f.evidence.some(e => e.field === 'Body' && e.start > 150000)));
  assert.ok(result.pending.some(p => /unlabeled location\/date\/time/.test(p)));
});

test('explicit previous employment is retained as scoped exclusion, aliases preserve intended application', () => {
  const previous = 'My previous role was in sales at Other Company.';
  const body = previous + ' I’m applying for the research internship at Example Company Ltd in City A.';
  const result = analyze(draft({ opportunityId: 'research', body, rawBody: body }), opportunityContext);
  assert.deepEqual(result.findings, []);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].text, previous);
  assert.equal(body.slice(result.excluded[0].start, result.excluded[0].end), previous);
  assert.match(result.excluded[0].reason, /only from target/);
  const stillChecked = analyze(draft({ opportunityId: 'research', body: 'My previous role was [ROLE]. I’m applying for the sales position at Other Company.' }), opportunityContext);
  for (const code of ['placeholder', 'target-company', 'target-role']) assert.ok(stillChecked.findings.some(f => f.code === code));
});

test('selection is explicit, duplicate recipient opportunities remain distinct and mismatched recipient stays pending', () => {
  assert.equal(validateContext(opportunityContext), opportunityContext);
  const input = { subject: 'Application for the sales position at Other Company', body: 'I’m applying for the research internship at Example Company.' };
  const none = analyze(draft({ ...input, opportunityId: '' }), opportunityContext);
  assert.ok(none.pending.some(p => /explicit opportunity selection/.test(p)));
  assert.ok(!none.findings.some(f => /^target-/.test(f.code)));
  assert.ok(none.findings.some(f => f.code === 'role-across-fields'));
  const sales = analyze(draft({ opportunityId: 'sales', subject: input.subject }), opportunityContext);
  assert.deepEqual(sales.findings, []);
  const mismatch = analyze(draft({ ...input, opportunityId: 'sales', recipients: [{ email: 'other@example.com', name: 'Other' }] }), opportunityContext);
  assert.ok(mismatch.findings.some(f => f.code === 'opportunity-recipient' && f.evidence.some(e => e.text === 'recipient@example.test')));
  assert.ok(!mismatch.findings.some(f => f.code === 'target-role'));
  const many = analyze(draft({ opportunityId: 'research', subject: input.subject, recipients: [{ email: 'recipient@example.test', name: 'Recipient' }, { email: 'cc@example.com', name: 'CC' }] }), opportunityContext);
  assert.ok(many.findings.some(f => f.code === 'target-role'));
  assert.ok(many.pending.some(p => /greeting identity/.test(p)));
});

test('legacy projection preserves every field and alias exactly without mutating or writing its source', () => {
  const legacy = { revision: 8, facts: [{ ...context.facts[0], name: '你好 👩🏽‍💻\r\n é  ', aliases: ['一\r\n二', 'Recipient\t '], companyAliases: ['B\\"\r\n Ltd'] }, context.facts[1]] };
  const before = JSON.stringify(legacy);
  const projected = opportunities(JSON.parse(before));
  assert.deepEqual(projected.map(({ id, ...fact }) => fact), legacy.facts);
  assert.deepEqual(projected.map(f => f.id), ['legacy-0', 'legacy-1']);
  assert.equal(JSON.stringify(legacy), before);
  assert.doesNotThrow(() => validateContext({ version: 2, revision: 8, facts: projected }));
  assert.deepEqual(opportunities(legacy), projected);
  assert.throws(() => opportunities({ revision: 0, facts: [{ email: 'bad' }] }));
});

test('opportunity count, IDs, canonical aliases and exact serialized byte boundary are enforced', () => {
  assert.throws(() => validateContext({ ...opportunityContext, facts: [opportunityContext.facts[0], opportunityContext.facts[0]] }), /unique/);
  assert.throws(() => validateContext({ ...opportunityContext, facts: Array(51).fill(opportunityContext.facts[0]) }), /50/);
  assert.throws(() => validateContext({ ...opportunityContext, facts: [{ ...opportunityContext.facts[0], id: 'x'.repeat(81) }] }), /ID/);
  assert.throws(() => validateContext({ version: 2, revision: 0, facts: [{ id: 'one', email: 'a@example.test', companyAliases: ['B'] }] }), /canonical/);
  const value = { version: 2, revision: 0, facts: Array.from({ length: 50 }, (_, i) => ({ id: `id-${i}`, email: `${i}@example.test`, name: 'Name', aliases: [] })) };
  let size = Buffer.byteLength(JSON.stringify(value));
  for (const fact of value.facts) {
    for (let i = 0; i < 10 && size < MAX_OPPORTUNITY_BYTES; i++) {
      const count = Math.min(200, MAX_OPPORTUNITY_BYTES - size - (fact.aliases.length ? 3 : 2));
      if (count < 1) break;
      fact.aliases.push('x'.repeat(count));
      size = Buffer.byteLength(JSON.stringify(value));
    }
  }
  assert.equal(size, MAX_OPPORTUNITY_BYTES);
  assert.equal(validateContext(value), value);
  value.facts.at(-1).role = 'x';
  assert.throws(() => validateContext(value), /52,000/);
});

test('company extraction stops at sentence boundaries and visits later same-line application claims', () => {
  const body = 'I’m applying for the research internship at Example Company. I’m applying for the sales position at Other Company. I am applying for the research internship at Example Company Ltd.';
  const result = analyze(draft({ opportunityId: 'research', body, rawBody: body }), opportunityContext);
  assert.equal(result.findings.filter(f => f.code === 'target-company').length, 1);
  assert.equal(result.findings.filter(f => f.code === 'target-role').length, 1);
  assert.equal(result.findings.filter(f => f.code === 'company-across-fields').length, 1);
});

test('serialized envelope, recipients and filenames honor exact boundaries including JSON escaping', () => {
  const input = draft({ opportunityId: 'research', body: '👩🏽‍💻\n[NAME] \\"', rawBody: '👩🏽‍💻\n[NAME] \\"' });
  const overhead = JSON.stringify({ draft: input, context: opportunityContext }).length;
  input.rawHtml = 'x'.repeat(MAX_WIRE - overhead);
  assert.equal(JSON.stringify({ draft: input, context: opportunityContext }).length, MAX_WIRE);
  assert.ok(analyze(input, opportunityContext).findings.some(f => f.code === 'placeholder'));
  input.rawHtml += 'x';
  const over = analyze(input, opportunityContext);
  assert.deepEqual(over.completed, []);
  assert.deepEqual(over.findings, []);
  for (const key of ['recipients', 'attachments']) {
    const list = Array.from({ length: 100 }, (_, i) => key === 'recipients' ? { email: `${i}@example.com`, name: '你好' } : `file-${i}.pdf`);
    assert.ok(analyze(draft({ [key]: list }), emptyContext()).completed.length > 0);
    assert.deepEqual(analyze(draft({ [key]: [...list, list[0]] }), emptyContext()).completed, []);
  }
});

test('cross-field company and role comparisons run without recipient identity or opportunity selection', () => {
  for (const recipients of [[], [{ email: 'one@example.com', name: '' }, { email: 'two@example.com', name: '' }]]) {
    const result = analyze(draft({ opportunityId: '', recipients, subject: 'Application for the sales position at Other Company', body: 'I’m applying for the research internship at Example Company.' }), emptyContext());
    assert.ok(result.findings.some(f => f.code === 'company-across-fields'));
    assert.ok(result.findings.some(f => f.code === 'role-across-fields'));
    assert.ok(result.pending.some(p => /greeting and filename/.test(p)));
    assert.ok(result.pending.some(p => /explicit opportunity selection/.test(p)));
    assert.ok(!result.findings.some(f => ['greeting', 'domain-company', 'attachment-context'].includes(f.code)));
  }
});

test('every legacy record at its exact byte limit fits conversion without altering any field', () => {
  const legacy = { revision: 0, facts: Array.from({ length: 50 }, (_, i) => ({ email: `${i}@example.com`, name: '你好', aliases: [] })) };
  for (const fact of legacy.facts) {
    for (let i = 0; i < 10; i++) {
      const remaining = 48000 - Buffer.byteLength(JSON.stringify(legacy)) - (fact.aliases.length ? 3 : 2);
      if (remaining < 1) break;
      fact.aliases.push('x'.repeat(Math.min(200, remaining)));
    }
  }
  assert.equal(Buffer.byteLength(JSON.stringify(legacy)), 48000);
  validateContext(legacy);
  const migrated = { version: 2, revision: legacy.revision, facts: opportunities(legacy) };
  validateContext(migrated);
  assert.deepEqual(migrated.facts.map(({ id, ...fact }) => fact), legacy.facts);
});

test('unknown opportunity facts including email stay optional and leave specific coverage pending', () => {
  const partial = { version: 2, revision: 0, facts: [{ id: 'unknown-email', company: 'Example Company', role: 'research internship' }, { id: 'unknown-company', email: 'recipient@example.test' }] };
  validateContext(partial);
  const input = draft({ opportunityId: 'unknown-email', subject: 'Application for the sales position at Other Company', attachments: ['Cover_letter_for_Other_Company.pdf'] });
  const result = analyze(input, partial);
  for (const code of ['target-company', 'target-role', 'attachment-target']) assert.ok(result.findings.some(f => f.code === code), code);
  assert.ok(result.pending.some(p => /recipient email is unknown/.test(p)));
  assert.ok(!result.completed.some(c => /email is present/.test(c)));
  assert.ok(!result.findings.some(f => f.code === 'opportunity-recipient'));
  const unknownLayout = analyze({ ...input, pending: ['Unrecognized compose container; field association requires review.'] }, partial);
  assert.ok(unknownLayout.findings.some(f => f.code === 'opportunity-recipient'));
  assert.ok(unknownLayout.pending.some(p => /explicit opportunity selection/.test(p)));
  assert.doesNotThrow(() => analyze(draft({ opportunityId: '', attachments: ['Example Company-cover-letter.pdf'] }), partial));
});

test('previous-employment classification ends at a line break without consuming the following application', () => {
  const previous = 'My previous role was a sales position at Other Company';
  const body = previous + '\r\nI’m applying for the research internship at Example Company.';
  const result = analyze(draft({ opportunityId: 'research', body, rawBody: body }), opportunityContext);
  assert.deepEqual(result.findings, []);
  assert.equal(result.excluded[0].text, previous);
  assert.equal(result.excluded[0].end, previous.length);
  assert.equal(body.slice(result.excluded[0].start, result.excluded[0].end), previous);
});

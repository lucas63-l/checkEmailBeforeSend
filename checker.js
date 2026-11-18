(function (root) {
  'use strict';
  const MAX_DRAFT = 200000;
  const MAX_WIRE = 2000000;
  const MAX_CONTEXT_BYTES = 48000;
  const MAX_OPPORTUNITY_BYTES = 52000;
  const emptyContext = () => ({ revision: 0, facts: [] });
  const fold = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[\s_\-]+/gu, ' ').trim();
  const email = value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);

  function validateContext(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.facts) || value.facts.length > 50) {
      throw new Error('Context must contain a revision and at most 50 recipient records.');
    }
    if (value.version !== undefined && value.version !== 2) throw new Error('Unsupported context version; stored data was not changed.');
    if (Object.keys(value).some(key => !['revision', 'facts', 'version'].includes(key))) throw new Error('Unknown context field.');
    const modern = value.version === 2;
    const seen = new Set();
    const keys = ['email', 'name', 'company', 'role', 'location', 'date', 'time', 'aliases', 'companyAliases', ...(modern ? ['id'] : [])];
    for (const fact of value.facts) {
      if (!fact || typeof fact !== 'object' || ((!modern || fact.email !== undefined) && (typeof fact.email !== 'string' || !email(fact.email)))) throw new Error('Recipient email must be valid when supplied; legacy records require it.');
      const identity = modern ? fact.id : fold(fact.email);
      if (modern && (typeof identity !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(identity))) throw new Error('Each opportunity needs an ID of 1–80 ASCII letters, digits or hyphens.');
      if (seen.has(identity)) throw new Error('Each recipient needs a unique email in legacy context; opportunity IDs must be unique.');
      seen.add(identity);
      if ((fact.aliases && !fact.name) || (fact.companyAliases && !fact.company)) throw new Error('Aliases require a canonical name or company in the same record.');
      for (const [key, field] of Object.entries(fact)) {
        if (!keys.includes(key)) throw new Error(`Unknown recipient field: ${key}`);
        if (key === 'aliases' || key === 'companyAliases') {
          if (!Array.isArray(field) || field.length > 10 || field.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new Error(`${key} must contain at most 10 nonempty strings of at most 200 characters.`);
        } else if (typeof field !== 'string' || field.length > 200 || !field.trim()) throw new Error(`${key} must be a nonempty string of at most 200 characters.`);
      }
    }
    const limit = modern ? MAX_OPPORTUNITY_BYTES : MAX_CONTEXT_BYTES;
    if (new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error(`Saved context exceeds ${limit.toLocaleString('en')} UTF-8 bytes. Nothing was saved.`);
    return value;
  }

  function opportunities(context) {
    validateContext(context);
    return context.facts.map((fact, i) => context.version === 2 ? { ...fact } : { id: `legacy-${i}`, ...fact });
  }

  function validateDraft(draft) {
    if (draft?.opportunityId !== undefined && (typeof draft.opportunityId !== 'string' || draft.opportunityId.length > 80)) throw new Error('Invalid opportunity selection.');
    if (!draft || typeof draft.subject !== 'string' || typeof draft.body !== 'string' || typeof draft.rawBody !== 'string' || typeof draft.rawHtml !== 'string' || !Array.isArray(draft.recipients) || !Array.isArray(draft.attachments) || !Array.isArray(draft.pending) || !Array.isArray(draft.excluded)) throw new Error('Invalid draft snapshot.');
    if (draft.recipients.some(r => !r || typeof r.email !== 'string' || typeof r.name !== 'string') || draft.attachments.some(a => typeof a !== 'string') || draft.pending.some(p => typeof p !== 'string') || draft.excluded.some(e => !e || typeof e.text !== 'string' || typeof e.reason !== 'string')) throw new Error('Invalid draft fields.');
  }

  function analyze(draft, context) {
    validateDraft(draft);
    validateContext(context);
    const result = { findings: [], completed: [], pending: [...draft.pending], excluded: [...draft.excluded] };
    const size = draft.subject.length + draft.rawBody.length + draft.attachments.join('').length + draft.recipients.map(r => r.email + r.name).join('').length;
    if (size > MAX_DRAFT || JSON.stringify({ draft, context }).length > MAX_WIRE || draft.recipients.length > 100 || draft.attachments.length > 100) {
      result.pending.push('Input limit exceeded (200,000 UTF-16 content units, 2,000,000 serialized units, 100 recipients, or 100 attachments). No analysis ran; the entire draft remains pending.');
      return result;
    }
    const fields = [ { field: 'Subject', text: draft.subject }, { field: 'Body', text: draft.body }, ...draft.attachments.map((text, i) => ({ field: `Attachment ${i + 1}`, text })) ];
    const evidence = (field, text, start = 0, end = text.length) => ({ field, text, start, end });
    const add = (code, certainty, explanation, items) => result.findings.push({ code, certainty, explanation, evidence: items });
    for (const field of fields) {
      for (const match of field.text.matchAll(/\[(?:NAME|COMPANY|ROLE|DATE|TIME|LOCATION|RECIPIENT|INSERT[^\]\n]*)\]|\{\{[^{}\n]+\}\}|<(?:(?:FIRST|LAST)[ _]?)?NAME>/giu)) {
        add('placeholder', 'Confirmed', 'An unresolved template placeholder remains.', [evidence(field.field, match[0], match.index, match.index + match[0].length)]);
      }
    }
    result.completed.push('Template placeholders in the subject, new text, and attachment filenames.');
    const claims = /\b(?:I(?:'ve| have)? attached|we(?:'ve| have)? attached|please (?:find|see) (?:the )?attached|attached (?:is|are|my|our|the)|(?:my|our|the) (?:resume|résumé|CV|document|file|cover letter) is attached)\b/giu;
    for (const field of fields.slice(0, 2)) {
      for (const match of field.text.matchAll(claims)) {
        if (draft.attachments.length === 0) {
          const uncertain = draft.pending.some(p => /attachment/iu.test(p));
          add('missing-attachment', uncertain ? 'Review' : 'Confirmed', uncertain ? 'The text claims an attachment; attachment extraction is incomplete.' : 'The text claims an attachment, but this compose has none.', [evidence(field.field, match[0], match.index, match.index + match[0].length), evidence('Attachments', '(none detected)')]);
        }
      }
    }
    if (!draft.pending.some(p => /attachment/iu.test(p))) result.completed.push('Explicit attachment claims against attachment presence; filenames only, never file contents.');

    const recipients = draft.recipients;
    const saved = opportunities(context);
    const selected = saved.find(f => f.id === draft.opportunityId);
    const one = selected && (!selected.email || recipients.some(r => fold(r.email) === fold(selected.email))) && !draft.pending.some(p => /recipient|compose container/iu.test(p)) ? selected : undefined;
    if (selected && !one) add('opportunity-recipient', 'Review', 'The selected opportunity cannot be associated with a parsed recipient in this compose. Opportunity comparisons remain pending.', [evidence('Selected opportunity ID', selected.id), ...(selected.email ? [evidence('Selected opportunity recipient', selected.email)] : []), ...recipients.map(r => evidence('Recipient', r.email))]);
    const labels = { name: 'Recipient name', company: 'Target company', role: 'Target role', location: 'Target location', date: 'Event date', time: 'Event time' };
    for (const [key, label] of Object.entries(labels)) {
      const matches = [];
      const pattern = new RegExp(`^${label}:[ \\t]*([^\\r\\n]+)`, 'gimu');
      for (const field of fields.slice(0, 2)) {
        for (const match of field.text.matchAll(pattern)) matches.push({ value: match[1], evidence: evidence(field.field, match[0], match.index, match.index + match[0].length) });
      }
      const aliases = one ? [one[key], ...(key === 'name' ? one.aliases || [] : key === 'company' ? one.companyAliases || [] : [])].filter(Boolean) : [];
      for (const match of matches) {
        if (aliases.length && !aliases.some(a => fold(a) === fold(match.value))) add(`context-${key}`, 'Review', `${label} differs from the selected opportunity. Confirm that it describes the same opportunity or event.`, [match.evidence, evidence(`Saved ${key} (${one.id})`, one[key])]);
      }
      for (let i = 1; i < matches.length; i++) {
        if (fold(matches[0].value) !== fold(matches[i].value)) add(`conflicting-${key}`, 'Review', `Explicit ${label.toLowerCase()} values differ. They conflict only if they refer to the same intended entity or event.`, [matches[0].evidence, matches[i].evidence]);
      }
    }
    result.completed.push('Explicit English labels: Recipient name, Target company/role/location, Event date/time; differing values require review. Dates and times are compared literally.');

    let recipient = { email: '', name: '' };
    if (one?.email) recipient = recipients.find(r => fold(r.email) === fold(one.email));
    else if (recipients.length === 1) recipient = recipients[0];
    const names = [one?.name, ...(one?.aliases || []), recipient.name].filter(Boolean);
    const greeting = /^(?:[\s\n]*)(?:Dear|Hi|Hello|Hey)[ \t]+([^,\n!]+)/iu.exec(draft.body);
    if (recipients.length === 1 && greeting && names.length && !names.some(n => fold(n) === fold(greeting[1]) || fold(n.split(/\s/u)[0]) === fold(greeting[1]))) {
      add('greeting', 'Review', 'The greeting differs from the sole recipient’s name and saved aliases.', [evidence('Body', greeting[0], greeting.index, greeting.index + greeting[0].length), evidence('Recipient name', recipient.name), evidence('Recipient', recipient.email), ...(one?.name ? [evidence('Saved name', one.name)] : [])]);
    }
    const companies = [one?.company, ...(one?.companyAliases || [])].filter(Boolean);
    const targeted = [];
    const roles = [];
    const prior = [];
    for (const field of fields.slice(0, 2)) {
      for (const match of field.text.matchAll(/\bMy previous role was\b[^\r\n.!?]*(?:[.!?]|$)/gimu)) {
        const item = evidence(field.field, match[0], match.index, match.index + match[0].length);
        prior.push(item);
        result.excluded.push({ ...item, reason: 'Explicit previous employment; excluded only from target opportunity comparisons' });
      }
    }
    const targetPattern = /\b(?:[Ii]nterest|[Ii]nternship|[Oo]pportunity|[Pp]osition|[Rr]ole|[Aa]pplication|[Aa]pplying|[Ii]nterview)(?:[ \t]+[\p{L}\p{N}-]+){0,6}?[ \t]+(?:at|with)[ \t]+([\p{Lu}\p{N}][\p{L}\p{N}&'’.-]*(?:(?<![.])[ \t]+[\p{Lu}\p{N}][\p{L}\p{N}&'’.-]*){0,5})/gu;
    for (const field of fields.slice(0, 2)) {
      for (const match of field.text.matchAll(targetPattern)) {
        if (!prior.some(p => p.field === field.field && match.index >= p.start && match.index < p.end)) targeted.push({ company: match[1].replace(/[.]$/u, ''), evidence: evidence(field.field, match[0], match.index, match.index + match[0].length) });
      }
      const rolePattern = /\b(?:Application for|I(?:['’]m| am) applying for)[ \t]+(?:the[ \t]+|a[n]?[ \t]+)?([\p{L}\p{N}][\p{L}\p{N} &'’/-]*?[ \t]+(?:position|role|internship|job)|internship)[ \t]+(?:at|with)[ \t]+([\p{Lu}\p{N}][\p{L}\p{N}&'’.-]*(?:(?<![.])[ \t]+[\p{Lu}\p{N}][\p{L}\p{N}&'’.-]*){0,5})/gu;
      for (const match of field.text.matchAll(rolePattern)) {
        if (!prior.some(p => p.field === field.field && match.index >= p.start && match.index < p.end)) roles.push({ role: match[1], evidence: evidence(field.field, match[0], match.index, match.index + match[0].length) });
      }
    }
    for (const target of targeted) {
      if (companies.length && !companies.some(c => fold(c) === fold(target.company))) add('target-company', 'Review', 'A company in an opportunity phrase differs from the selected opportunity’s company/aliases. Confirm the intended organization.', [target.evidence, evidence(`Saved company (${one.id})`, one.company)]);
    }
    for (let i = 1; i < targeted.length; i++) {
      const sameAlias = companies.some(c => fold(c) === fold(targeted[0].company)) && companies.some(c => fold(c) === fold(targeted[i].company));
      if (fold(targeted[0].company) !== fold(targeted[i].company) && !sameAlias) {
        add('company-across-fields', 'Review', 'Opportunity phrases name different companies; verify that they describe the same opportunity.', [targeted[0].evidence, targeted[i].evidence]);
      }
    }
    for (const target of roles) {
      if (one?.role && fold(target.role) !== fold(one.role)) add('target-role', 'Review', 'An explicit application role differs from the selected opportunity. Role synonyms are not inferred.', [target.evidence, evidence(`Saved role (${one.id})`, one.role)]);
    }
    for (let i = 1; i < roles.length; i++) {
      if (fold(roles[0].role) !== fold(roles[i].role)) add('role-across-fields', 'Review', 'Explicit application phrases name different roles; confirm the intended opportunity.', [roles[0].evidence, roles[i].evidence]);
    }
    const domain = recipient.email.split('@')[1] || '';
    const stem = domain.split('.')[0];
    if (stem.length >= 3 && !['gmail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'proton', 'mail', 'live', 'aol'].includes(stem.toLowerCase())) {
      for (const target of targeted.filter(t => t.evidence.field === 'Subject')) {
        if (!companies.length && !fold(target.company).replace(/ /gu, '').includes(fold(stem))) add('domain-company', 'Review', 'The subject’s opportunity company does not resemble the recipient domain. Domains are only a hint, not verified company identity.', [target.evidence, evidence('Recipient', recipient.email)]);
      }
    }
    for (let i = 0; i < draft.attachments.length; i++) {
      if (!one && recipients.length !== 1) continue;
      const filename = draft.attachments[i];
      const namedCompany = /(?:cover[ _-]*letter|application|proposal)[ _-]+for[ _-]+(.+)\.[^.]+$/iu.exec(filename);
      if (namedCompany && companies.length && !companies.some(c => fold(c) === fold(namedCompany[1]))) {
        add('attachment-target', 'Review', 'The company after “for” in the attachment filename differs from the saved intended company; document contents were not checked.', [evidence(`Attachment ${i + 1}`, filename), evidence(`Saved company (${one.id})`, one.company)]);
      }
      for (const other of saved.filter(f => one ? f.id !== one.id : !f.email || fold(f.email) !== fold(recipient.email))) {
        for (const key of ['name', 'company', 'role']) {
          const value = other[key];
          const intended = [one?.[key], ...(key === 'company' ? one?.companyAliases || [] : key === 'name' ? one?.aliases || [] : [])].filter(Boolean);
          if (value && fold(value).length >= 3 && !intended.some(v => fold(v) === fold(value)) && fold(filename).includes(fold(value))) {
            add('attachment-context', 'Review', `The filename mentions ${key} saved for another opportunity. The file contents were not checked.`, [evidence(`Attachment ${i + 1}`, filename), evidence(`Other saved opportunity (${other.id})`, value), one ? evidence('Selected opportunity ID', one.id) : evidence('Compose recipient email', recipient.email)]);
          }
        }
      }
    }
    result.completed.push('English opportunity-company phrases across subject/body, independently of recipient or opportunity selection.');
    if (one || recipients.length === 1) result.completed.push('Optional company-domain hints and filenames mentioning another saved opportunity’s facts.');
    result.completed.push('Bounded English application-role phrases; explicit “My previous role was…” is excluded only from target comparisons, with source evidence retained.');
    if (recipients.length === 1 && names.length) result.completed.push('Sole-recipient greeting against display name and selected saved aliases.');
    if (recipients.length === 1 && !names.length) result.pending.push('Recipient name is unavailable; greeting comparison remains pending.');
    if (recipients.length !== 1 && !one) result.pending.push('Single intended recipient is unavailable or ambiguous; recipient-specific greeting and filename comparisons remain pending.');
    if (recipients.length !== 1 && one) result.pending.push('No sole recipient: greeting identity remains ambiguous; other comparisons use the explicit selected opportunity.');
    if (!one) result.pending.push('No valid explicit opportunity selection for this compose; missing or ambiguous selection leaves saved name/company/role/location/date/time comparisons pending.');
    if (one) {
      if (one.email) result.completed.push('Selected opportunity recipient email is present in this compose; labels use that opportunity.');
      else result.pending.push('Selected opportunity recipient email is unknown; recipient email consistency remains pending. Other known facts use the explicit selection.');
      const unknown = ['name', 'company', 'role', 'location', 'date', 'time'].filter(key => !one[key]);
      if (unknown.length) result.pending.push(`Selected opportunity has no saved ${unknown.join(', ')}; those saved-fact comparisons remain pending.`);
    }
    result.pending.push('General semantic meaning, other role expressions, unlabeled location/date/time conflicts, non-English phrasing, and attachment contents are not checked. Dates/times require labels; event identity, equivalent date formats and time zones are not inferred.');
    return result;
  }
  const api = { analyze, validateContext, validateDraft, emptyContext, opportunities, MAX_DRAFT, MAX_WIRE, MAX_CONTEXT_BYTES, MAX_OPPORTUNITY_BYTES };
  if (typeof module !== 'undefined') module.exports = api;
  else root.DraftChecker = api;
})(globalThis);

(function (root) {
  'use strict';
  const EDITOR = '[contenteditable="true"][role="textbox"][g_editable="true"], [contenteditable="true"][role="textbox"][aria-multiline="true"], .Am.Al.editable[contenteditable="true"]';
  const EXCLUDE = '.gmail_quote, blockquote[type="cite"], .gmail_signature[data-smartmail="gmail_signature"]';
  function textOf(node, skip, excluded) {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1) return '';
    if (skip && node.matches(EXCLUDE)) {
      excluded.push({ reason: node.matches('.gmail_signature') ? 'Gmail signature marker' : 'Structured quotation marker', text: textOf(node, false, []) });
      return '';
    }
    if (node.tagName === 'BR') return '\n';
    let text = '';
    for (const child of node.childNodes) {
      const part = textOf(child, skip, excluded);
      if (child.nodeType === 1 && /^(DIV|P|LI|TR|BLOCKQUOTE|PRE|H[1-6])$/u.test(child.tagName) && text && !text.endsWith('\n')) text += '\n';
      text += part;
    }
    return text;
  }
  function composeRoot(editor) {
    let fallback = editor.parentElement;
    for (let parent = editor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.querySelectorAll(EDITOR).length !== 1) break;
      if (parent.matches('.M9, .AD, .ip, [role="dialog"], form')) return { root: parent, supported: true };
      if (parent.querySelector('[name="subjectbox"], [name="to"], [email], [data-hovercard-id]')) fallback = parent;
    }
    return { root: fallback, supported: false };
  }
  function extract(editor, container, supported = true) {
    if (!editor.isConnected || !container.contains(editor)) throw new Error('Compose editor was closed or replaced.');
    const pending = [];
    const excluded = [];
    const rawBody = textOf(editor, false, []);
    const body = textOf(editor, true, excluded);
    if (!supported) pending.push('Unrecognized compose container; field association requires review.');
    if (editor.querySelector('blockquote:not([type="cite"]):not(.gmail_quote), .gmail_signature:not([data-smartmail="gmail_signature"])') || /(?:^|\n)(?:On .+wrote:|-- ?$|From:)/imu.test(body)) pending.push('Ambiguous quotation/signature boundary: unmarked text was retained and checked.');
    const recipients = [];
    const outsideBody = node => !editor.contains(node) && !node.closest('[data-draft-check]');
    for (const node of container.querySelectorAll('[email], [data-hovercard-id], [data-email], input[name="to"], input[name="cc"], input[name="bcc"], textarea[name="to"], textarea[name="cc"], textarea[name="bcc"]')) {
      if (!outsideBody(node)) continue;
      const value = node.getAttribute('email') || node.getAttribute('data-email') || node.getAttribute('data-hovercard-id') || node.value || '';
      const addresses = [...value.matchAll(/[^\s<>,;"@]+@[^\s<>,;"@]+\.[^\s<>,;"@]+/gu)].map(m => m[0]);
      if (value.trim() && !addresses.length) pending.push('A recipient field could not be parsed; recipient comparisons are incomplete.');
      for (const address of addresses) {
        const name = node.getAttribute('name') && !['to', 'cc', 'bcc'].includes(node.getAttribute('name')) ? node.getAttribute('name') : node.getAttribute('data-name') || (node.hasAttribute('email') ? node.textContent : '');
        const existing = recipients.find(r => r.email.toLowerCase() === address.toLowerCase());
        if (existing && !existing.name && name) existing.name = name;
        if (!existing) recipients.push({ email: address, name: name || '' });
      }
    }
    for (const node of container.querySelectorAll('input[role="combobox"], textarea[role="combobox"]')) {
      if (outsideBody(node) && node.value.trim()) pending.push('Uncommitted recipient entry remains; commit recipient chips and recheck.');
    }
    const subjectInput = container.querySelector('input[name="subjectbox"], input[name="subject"]');
    let subject = subjectInput?.value;
    if (subject === undefined) {
      let ancestor = container.parentElement;
      while (ancestor && ancestor !== document.body && !ancestor.querySelector('h2.hP')) ancestor = ancestor.parentElement;
      const titles = ancestor && ancestor !== document.body ? ancestor.querySelectorAll('h2.hP') : [];
      subject = titles.length === 1 ? titles[0].textContent : '';
      pending.push(titles.length === 1 ? 'Inherited conversation title used for reply/forward subject; exact outgoing subject header is unavailable.' : 'Subject field is unavailable in this layout.');
    }
    const attachments = [];
    const attachmentNodes = container.querySelectorAll('[data-attachment-name], .aQH .aV3, .aQH .vI, .aQH [download_url]');
    const used = new Set();
    for (const node of attachmentNodes) {
      if (!outsideBody(node) || [...used].some(other => other.contains(node) || node.contains(other))) continue;
      const download = node.getAttribute('download_url');
      const name = node.getAttribute('data-attachment-name') || (download ? download.slice(download.indexOf(':') + 1, download.indexOf(':', download.indexOf(':') + 1)) : node.textContent);
      if (!name) pending.push('An attachment filename could not be extracted.');
      else attachments.push(name);
      used.add(node);
    }
    for (const input of container.querySelectorAll('input[type="file"]')) {
      for (const file of input.files || []) {
        if (!attachments.includes(file.name)) {
          attachments.push(file.name);
          pending.push('Selected attachment is not yet represented by a completed attachment chip; upload remains unverified.');
        }
      }
    }
    if (container.querySelector('.aQH [role="progressbar"], .aQH .aV6, [data-uploading="true"]')) pending.push('Attachment upload is pending; presence and final filenames require rechecking.');
    for (const region of container.querySelectorAll('.aQH')) {
      if ((region.textContent.trim() || region.childElementCount) && !region.querySelector('[data-attachment-name], .aV3, .vI, [download_url]')) pending.push('Unrecognized attachment layout; attachment extraction is incomplete.');
    }
    if (editor.querySelector('img, video, audio, canvas, iframe, object')) pending.push('Non-text body content is present; only text and attachment filenames are checked.');
    return { recipients, subject, body, rawBody, rawHtml: editor.innerHTML, attachments, excluded, pending: [...new Set(pending)] };
  }
  root.DraftExtract = { EDITOR, composeRoot, extract, textOf };
})(globalThis);

# Check Draft for Gmail

A Manifest V3 Chrome extension that checks individual Gmail drafts for inconsistent recipient and application details, missing attachments, and leftover placeholders. Each compose editor gets a local, read-only checker and an explicit opportunity selector. The extension never rewrites, sends, or discards emails. It has no production dependencies, networking, telemetry, credentials, or external inference.

## Features

- Compare supported company, role, and greeting phrases with saved opportunity facts.
- Flag explicit attachment claims when no attachment is found, and check filenames for conflicting details.
- Find placeholders such as `[NAME]`, `[COMPANY]`, and `{{...}}`.
- Inspect exact evidence, the checked snapshot, and checks that remain incomplete.
- Save up to 50 opportunities locally, including different roles for the same recipient.

Checks use bounded English rules. Review the findings and incomplete coverage before sending.

## Install and use

1. In Chrome 114 or later, open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked**, then select this repository's root folder, which contains `manifest.json`. No build or dependency installation is required to use the extension.
3. Open Gmail. Existing and newly opened editors receive controls automatically. Analysis runs only when you select **Check draft**.
4. Open **Recipient facts** to manage opportunities through the form. Add any known recipient email, name, company, role, location, event date, event time, or aliases. Unknown facts, including email, are optional. Add aliases individually so multiline values remain one alias. Save the proposed set.
5. In each compose, select **Opportunity for this compose**. Nothing is selected automatically, even for a unique recipient. Different drafts may select different roles for the same email.
6. Select **Check draft**. Expand findings for exact evidence and UTF-16 offsets. **Coverage and incomplete checks** lists completed work, pending work, and intentional exclusions. **Exact snapshot checked** includes the opportunity ID and complete extracted draft.
7. Close the popup, press Escape, or click outside to dismiss it. **View results** reopens it. Findings use display pages of 20. All findings and complete evidence remain available.

**Reload opportunities** retries an unavailable saved list without starting analysis. Missing selection leaves independent checks active and saved-fact comparisons pending. A known selected email absent from the parsed recipients produces a review finding. An unknown saved email leaves recipient consistency pending while known target facts remain usable through explicit selection. Uncommitted recipients or an unsupported compose association leave opportunity comparisons pending. With multiple parsed recipients, an explicitly selected opportunity can supply target facts, but greeting identity remains pending.

Selection belongs to the live editor object. Minimize, navigation, footer replacement, and restored controls keep that editor's selection. Closing, replacing, or moving an editor into another compose container resets selection. Reopened drafts require selection again. No draft IDs are inferred and no associations are stored or transferred between editors.

Installation attempts injection into already-open Gmail tabs and frames. Failures appear in the options page. Reopen or reload an affected tab to retry injection. After reloading the extension itself, reload Gmail if Chrome invalidates an existing content-script connection. Installation does not migrate or overwrite context.

## Supported consistency checks

| Check | Implemented comparison |
| --- | --- |
| Application roles | Sentence-case `Application for [the/a/an] <role> at/with <Company>` and `I'm`, `I’m`, or `I am applying for [the/a/an] <role> at/with <Company>`. A role ends in `position`, `role`, `internship`, or `job`; bare `internship` also works. Every supported occurrence is compared with the selected role and with the first supported role in the draft, including occurrences in the same field. Differences require **Review**. Synonyms such as `intern` and `internship` are not inferred. |
| Opportunity companies | Retains English phrases beginning with `Interest`, `Internship`, `Opportunity`, `Position`, `Role`, `Application`, `Applying`, or `Interview`, also with a lowercase initial. Up to six intervening words precede `at` or `with`. Company names have one to six tokens, each beginning with an uppercase letter or digit. Matching uses horizontal whitespace within a line. Every occurrence is compared with selected company aliases and the first supported company. A period ends a company phrase. Differences require **Review**. |
| Previous employment | `My previous role was ...` through the next period, question mark, exclamation mark, or line ending explicitly describes prior employment. Its full source text and offsets remain in coverage. Only target-company and target-role comparisons exclude that range. Placeholders and attachment claims still run there. Other descriptions of employment, punctuation inside company abbreviations, and unrelated relationships require human review. |
| Recipient | When a saved email is known, selection checks that email against parsed compose recipients. An unknown saved email leaves email comparison pending. Dear/Hi/Hello/Hey at the beginning of new text is compared with a sole recipient's display name and selected name, aliases, and first name. Greeting differences require **Review**. |
| Explicit labels | Line-start `Recipient name:`, `Target company:`, `Target role:`, `Target location:`, `Event date:`, and `Event time:` compare with selected saved facts and repeated values. These checks remain available. Differences require **Review** because entity or event identity can be ambiguous. |
| Company domain | Without a selected company, a sole recipient's non-consumer domain stem is a hint for subject opportunity companies. **Review** only. No corporate-domain or public-suffix database. |
| Attachment presence | Explicit claims such as `Please find attached`, `I've attached`, `Attached is`, and `My CV is attached` against extracted attachment presence. **Confirmed** if absent, or **Review** if attachment extraction or upload is incomplete. |
| Attachment filenames | Explicit `Cover_letter_for_Other_Company.pdf` style company targets against selected company aliases. Also finds another saved opportunity's name, company, or role in filenames, including another role for the same recipient. **Review** only; file contents are never read. |
| Placeholders | `[NAME]`, `[COMPANY]`, `[ROLE]`, `[DATE]`, `[TIME]`, `[LOCATION]`, `[RECIPIENT]`, `[INSERT...]`, `{{...}}`, and `<FIRST_NAME>`/`<NAME>` variants in subject, new text, and filenames. **Confirmed** markers, although a literal example can be intentional. |

For `recipient@example.test`, select Example Company / research internship / City A. The subject `Application for the sales position at Other Company` and body `I’m applying for the research internship at Example Company in City A.` produce supported company and role findings. Evidence includes exact subject/body phrases and selected facts. One underlying mistake can produce several findings; there is no promised warning count.

`My previous role was in sales at Other Company. I’m applying for the research internship at Example Company in City A.` does not produce a company or role conflict for that opportunity. `At Other Company I worked with Colleague.` also does not match an application claim. Arbitrary employer mentions are not scanned for contradictions.

Comparison retains existing NFKC, case, whitespace, underscore, and hyphen normalization. Evidence always preserves original source text. Saved names and companies support explicit aliases. Role synonyms have no alias list.

This is bounded English matching, not general semantic understanding. Unlabeled location, date, and time prose is **not checked**. `in City A` in an application sentence is retained as source text but is not a location comparison. Event identity, equivalent date formats, time-zone interpretation, indirect contradictions, unsupported role expressions, non-English phrasing, and attachment contents remain pending limitations. Supported date/time labels compare literal normalized strings. All semantic differences are possible conflicts needing review.

**No inconsistencies found in the completed checks.** applies only to completed checks. Coverage remains available. No completed checks produces **Incomplete — no checks completed.** Oversized or failed work never becomes success.

## Saved context and recovery

`chrome.storage.local.recipientContext` accepts the legacy `{ revision, facts }` object and the new `{ version: 2, revision, facts }` object. Each new fact has a stable `id`; other facts are optional. Legacy records retain their required email. New emails need not be unique; IDs must be unique. The existing key, worker queue, sender validation, revision conflicts, and single-object storage write remain in use. Only the extension options page can save.

Legacy reads validate the complete saved object and project each record to `legacy-<index>` in memory. Reads and installation perform no migration write. The form preserves every original field and alias, including Unicode, JSON escapes, whitespace, empty alias lists, and multiline strings. Untouched textarea values retain original CRLF rather than silently saving the browser's LF display normalization. Newly edited values use the browser's input representation.

An explicit form save converts the whole proposed set in one write. At most 50 records remain supported. Existing 1–200 UTF-16-unit strings and at most 10 aliases per list remain supported. Aliases require their canonical name or company. IDs allow 1–80 ASCII letters, digits, or hyphens. Legacy objects retain the 48,000 UTF-8-byte bound. Version 2 allows 52,000 bytes after JSON serialization, measured with `TextEncoder`. The increase covers metadata: 50 generated legacy IDs plus the version field add less than 1,000 bytes, so every valid legacy object fits without dropping facts. New IDs use `crypto.randomUUID()`.

Malformed, unsupported, or oversized legacy records stay stored and visibly unresolved. They are not filtered, cleared, or silently replaced. Saves cannot bypass an invalid stored state. This increment has no repair editor for invalid legacy data; recovery requires restoring valid context through an explicit, separately reviewed storage repair. Ordinary valid data needs no JSON editing.

Saves serialize and reject stale revisions. Errors preserve proposed edits and the last committed state. A save acknowledgement timeout does **not** cancel a write. **Save opportunities** stays disabled after an unconfirmed outcome until **Verify saved state (keep edits)** succeeds. Verification reads through the same queue, displays the exact committed object, and preserves proposed edits. If saved facts match the loaded baseline or the attempted save, verification updates the revision and enables an intentional retry. If another window changed saved facts, saving stays blocked to prevent overwriting concurrent edits. Inspect the committed state and explicitly discard/reload before making a new proposal. Stable IDs prevent duplicate records on retry. **Discard edits and reload** explicitly replaces proposed edits with committed data.

An interrupted conversion has either the old complete object or the new complete object to verify. There are no multi-key migration steps, background retries, or persisted migration checkpoints. Chrome storage durability during an OS or device failure is not guaranteed by these tests. Removal is part of the proposed set and takes effect on save. Changes to any saved facts invalidate existing results; removal of a selected opportunity clears its selector.

## Extraction and compose layout

`extract.js` remains unchanged. It recognizes multiline Gmail editors inside `.M9`, `.AD`, `.ip`, dialogs, or forms with one editor. A MutationObserver mounts controls on existing and new editors. Unknown containers retain controls and disclose incomplete field association.

Controls occupy their own full-width row before `.aDh` or the enclosing action table, with a header fallback. They are never inserted in the native `.btC` Send/action cell or toolbar-like markup within the body. The opportunity selector and reload button share the upper extension row. Analysis buttons use the lower row. Narrow controls wrap within the extension area. Findings use a native, viewport-bounded popover. Expanded evidence does not displace compose fields. Close, Escape, outside-click dismissal, visible status, labels, keyboard focus, and View results remain available. Chrome 114+ is required.

Only `.gmail_quote`, `blockquote[type="cite"]`, and `.gmail_signature[data-smartmail="gmail_signature"]` subtrees are structurally excluded. Full text and reasons remain inspectable. New text after those sections remains eligible. Unmarked blockquotes, partial signature markers, and textual `On ... wrote:`, `From:`, or `--` boundaries remain checked and disclosed as ambiguous. Previous-employment exclusions have the narrower target-comparison scope described above. Exclusion is separate from extraction failure or pending work.

Extraction preserves text-node Unicode, whitespace, punctuation, and line breaks, adding structural breaks for block elements and `<br>`. Complete raw body, extracted body, raw HTML, exclusions, recipients, subject, and filenames remain available. Evidence offsets refer to extracted fields in UTF-16 units. Gmail's own input normalization is outside extension control. Non-text content, unknown attachment markup, uploads, and inherited reply titles leave checks pending. A unique nearby `h2.hP` can supply an inherited conversation title, but the exact outgoing reply/forward subject remains unavailable in that layout.

## Processing boundaries

- Draft content allows 200,000 UTF-16 units across complete raw body, subject, recipient identities, and filenames. A snapshot allows at most 100 recipients and 100 filenames.
- The JSON-serialized draft/context envelope allows 2,000,000 UTF-16 units. Raw HTML, exclusions, opportunity ID, JSON escapes, and saved context count. Oversized input remains wholly pending; there is no sampling, truncation, chunking, or partial comparison.
- Context byte limits measure UTF-8 after JSON serialization. These differ from string and envelope UTF-16 limits. Unicode and JSON escaping are tested separately.
- Each extension messaging stage allows eight seconds for acknowledgement. Cancellation invalidates the compose run. Older, timed-out, or out-of-order responses cannot replace a newer run. Reloading saved lists also rejects superseded responses.
- Snapshots include the explicit opportunity ID and bind to the saved revision. DOM/input/change events and a 500 ms value-property watcher invalidate results. Snapshots and context are checked again before rendering. No transactional lock is placed on Gmail. Reverting before observation can restore the identical snapshot.
- Findings are computed in full before display. Pagination shows 20 at a time and does not remove evidence. Output has no separate byte cap or truncation path. Dense results can use substantial memory; a messaging or rendering failure leaves analysis incomplete. Worst-case responsiveness and output transport on the user's hardware remain unverified.
- Retry checks the complete current snapshot and replaces results. Draft text, findings, and compose associations are never persisted for resume. After browser/worker interruption, verify uncertain saved writes and recheck the current draft. A full Gmail reload clears editor selections.
- External request/token limits, provider encoding, network retry/backoff, mailbox pagination, attachment-content parsing, cloud sync, and durable draft-processing checkpoints are inapplicable. The extension has no external service or file-content input.

Saved opportunities persist in this Chrome profile until removed or uninstalled. Installation diagnostics contain tab IDs and error messages. Production code does not write draft text to storage or test output. Rendering uses safe text APIs. Gmail-only host permissions, storage and scripting permissions, and `connect-src 'none'` remain unchanged.

## Development

Use Node.js 20 or later and npm. Run these commands from the repository root to install test dependencies and run the logic and storage tests:

```powershell
npm.cmd ci
npm.cmd test
```

The browser suite currently expects Windows, an installed Google Chrome, and Playwright Chromium in the repository's `.playwright-browsers` folder:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.playwright-browsers"
npx.cmd playwright install chromium
npm.cmd run test:browser
```

There is no build step. After changing extension files, reload the extension at `chrome://extensions`, then reload Gmail.

| File | Responsibility |
| --- | --- |
| `manifest.json` | Extension registration, permissions, and Gmail content scripts. |
| `extract.js` | Extract compose fields, recipients, and attachment filenames. |
| `content.js` | Compose controls, analysis requests, and results display. |
| `checker.js` | Consistency rules and saved-context validation. |
| `background.js` | Analysis messages, saved context, and installation injection. |
| `options.html`, `options.js`, `options.css` | Opportunity editor and save recovery. |
| `tests/` | Node tests and Playwright browser fixtures. |

## Verification reference

Node tests exercise production checker exports and the worker's actual message handler with synthetic Chrome storage and failure injection. Browser fixtures use installed Chrome. The unpacked-extension test uses the last sorted `chromium-*` folder under `.playwright-browsers`, with the Windows binary at `chrome-win64/chrome.exe`, in a disposable profile and intercepts Gmail-origin navigation with synthetic HTML. It exercises actual isolated content scripts, extension messages, storage, the options form, concurrent revisions, committed saves with lost acknowledgements, malformed legacy state, and service-worker stop/recovery. It never connects to a mailbox. Test screenshots and reports are under ignored `test-results/`.

The tests cover exact findings and offsets, aliases, legacy projection, form conversion without CRLF loss, failed conversion, unknown legacy fields, saved-byte limits, duplicate recipient opportunities, separate selections, selection/fact changes during analysis, cancellation, timeouts, late responses, replacement/reopened editors, recovery, quotations/signatures, read-only hostile-text rendering, dense display pages, opposite-end evidence, input limits, popup bounds, native toolbar size, footer replacement, and normal/narrow/zoom-equivalent widths.

Live Gmail verification remains required for new messages, inline replies, forwards, pop-outs, frames, multiple editors, attachment chips, and inherited subjects. Synthetic fixtures prove extension behavior against those fixtures, not current signed-in Gmail markup. On 2026-11-18 the in-app Gmail probe again reached Google's public Gmail product page. The normal Chrome profile was not modified or given the unpacked extension. No message was sent.

## Evidence ledger

**Confirmed findings**

- The existing extension and test infrastructure were present directly in the requested folder. No workspace, project, permission, or production dependency was added.
- Context consumers are shared validation/analysis exports, worker read/save/analyze messages, options load/save/recovery, compose list loading, exact snapshots, and storage invalidation. Extraction and manifest need no change. Installation writes diagnostics only.
- On 2026-11-18, the final integrated `npm.cmd test` run passed all 30 logic/storage tests. `npm.cmd run test:browser` passed all 23 browser tests, including the unpacked extension. No tests failed or remained pending in these suites. Earlier baseline evidence was 16 Node tests and 21 browser tests.
- The selector initially exceeded the existing compact-row height bound. Adjusting extension spacing and reload placement restored the original assertion without weakening it. Separate native toolbar and popover assertions remain in place.
- Legacy conversion, duplicate-recipient opportunities, committed acknowledgement loss, and worker stop/recovery are tested through the unpacked extension. Failed storage writes and interrupted conversion before commit are tested through the production worker handler with synthetic storage.
- Live Gmail verification is unavailable through the tested in-app session. No signed-in mailbox was accessed.

**Hypotheses**

- Explicit opportunity context and bounded prose evidence are useful for applications and professional outreach.
- Explicit previous-employment relationships reduce some false positives.
- This combination provides differentiation. Competitor listings overlap on basic recipient, placeholder, and attachment checks; uniqueness and market demand have not been established.

**Untested assumptions**

- Live Gmail markup across accounts and languages matches the adapter.
- Real pop-outs, frames, quoted attachment metadata, and uploads behave like fixtures.
- Near-limit responsiveness and dense output are acceptable on real user hardware.
- Users understand and value explicit opportunity setup and reselection after editor replacement.

**Not known / unresolved**

- Live compose compatibility, exact inherited outgoing subject headers, and ambiguous quotation/signature intent.
- Arbitrary semantic relationships, indirect contradictions, and equivalent dates or time zones.
- Device/OS failure durability during a storage write. Conversion uses a single object, but tests do not simulate a disk crash during Chrome's internal write.
- Invalid legacy data has no automatic repair workflow. It remains intact and visibly incomplete.

## Report-only candidates

Attachment previews or document-content comparison could detect a correctly named file containing the wrong employer. A future candidate is an explicit, local preview of user-selected text-bearing PDF or DOCX files. It would require new file access, parsers, format/size/encoding bounds, and evidence for incomplete parsing. No file content is read here.

Revocable, narrowly scoped warning suppression could reduce repeated false positives. Explicit aliases remain the local option. No warning-learning, automatic mailbox learning, or broad suppression was added.

Conversational or model-assisted interpretation could recognize more role synonyms and relationships than these rules. No provider is selected or implemented. An approved service would receive specifically approved recipient names/addresses, subject, newly written body, attachment filenames, and selected saved facts. Quoted/signature text would remain excluded unless separately approved; ambiguous boundaries need an explicit decision. Provider retention, training use, request/output limits, credentials, and failure recovery would require review before transmission. The available alternative is the local bounded checker with visible pending coverage.

Send interception, send blocking, automatic correction, mailbox scanning, application tracking, job scraping, cloud sync, attachment parsing, and store publishing remain outside this increment.

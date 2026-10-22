// scripts/apply-sr-compress.mjs
// Sales Recon re-plan agreed 19 Oct: Sales Recon finishes Thu 19 Nov (V3-V6).
//   V3  #90 moved in; #295 on Mon 26
//   V4  #220 fills the Wednesday
//   V5  brought-forward + #208
//   V6  UI week: #283 prototype review (Fri plan) + #346 split into 3 page sub-issues
//   V7  buffer week (no planned coding)
//   V8/V9  OCR (#164) + #156, tentative January dates until APEX is re-planned
//
// Preview (changes nothing):   node scripts/apply-sr-compress.mjs
// Write to GitHub:             node scripts/apply-sr-compress.mjs --apply
// Also set Project Due:        add --with-due   (only while the sync is disabled)
// Token: GH_TOKEN from .env. Safe to re-run.

import './env.mjs';

const ORG = 'onlineoms';
const REPO = 'devinfra';
const PROJECT_NUMBER = 2;
const ME = 'faqhrul-dev';
const MODULE = 'Accounts';

const APPLY = process.argv.includes('--apply');
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GH_TOKEN is not set. Add it to .env in the project-status-sync folder (see .env.example).');
  process.exit(1);
}

// Org-level issue fields (from list_issue_fields on onlineoms)
const ISSUE_FIELD = { Priority: 39751922, 'Start date': 39751923, 'Target date': 39751924 };
const PRIORITY_OPTION = { Urgent: 69559745, High: 69559746, Medium: 69559747, Low: 69559748 };

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

async function rest(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...HEADERS, 'GraphQL-Features': 'sub_issues' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error((json.errors || []).map((e) => e.message).join('; ') || `GraphQL HTTP ${res.status}`);
  }
  return json.data;
}

const issuePath = (n) => `/repos/${ORG}/${REPO}/issues/${n}`;
const getIssue = (n) => rest('GET', issuePath(n));

async function readIssueFields(n) {
  const j = await rest('GET', `${issuePath(n)}/issue-field-values?per_page=100`);
  const list = Array.isArray(j) ? j : j?.issue_field_values || [];
  const nameById = Object.fromEntries(Object.entries(ISSUE_FIELD).map(([k, v]) => [v, k]));
  const out = {};
  for (const o of list) {
    const name = nameById[o.issue_field_id ?? o.field_id ?? o.issue_field?.id];
    if (!name) continue;
    let v = o.single_select_option?.name ?? o.value;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = v.slice(0, 10);
    out[name] = v;
  }
  return out;
}

// Same endpoint your sync uses. For Priority, try the option name first, then the option id,
// and report which one GitHub accepted.
async function writeIssueField(n, name, value) {
  const field_id = ISSUE_FIELD[name];
  const variants = name === 'Priority' ? [value, PRIORITY_OPTION[value]] : [value];
  let lastErr;
  for (const v of variants) {
    try {
      await rest('POST', `${issuePath(n)}/issue-field-values`, {
        issue_field_values: [{ field_id, value: typeof v === 'number' ? v : String(v) }],
      });
      if (v !== variants[0]) console.log(`    note: ${name} accepted the option id, not the name`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function loadProject() {
  const d = await gql(
    `query($o: String!, $n: Int!) {
      organization(login: $o) {
        projectV2(number: $n) {
          id
          fields(first: 50) {
            nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
          }
        }
      }
    }`,
    { o: ORG, n: PROJECT_NUMBER },
  );
  const p = d.organization.projectV2;
  const fields = {};
  for (const f of p.fields.nodes) if (f?.name) fields[f.name] = f;
  return { id: p.id, fields };
}

// Returns the existing item if the issue is already on the board
async function ensureOnBoard(P, issueNodeId) {
  const d = await gql(
    `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
    { p: P.id, c: issueNodeId },
  );
  return d.addProjectV2ItemById.item.id;
}

async function setBoardSelect(P, itemId, fieldName, optionName) {
  const f = P.fields[fieldName];
  const opt = f?.options.find((o) => o.name === optionName);
  if (!opt) throw new Error(`Option "${optionName}" not found in board field "${fieldName}"`);
  await gql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) {
        projectV2Item { id }
      }
    }`,
    { p: P.id, i: itemId, f: f.id, o: opt.id },
  );
}

async function addSubIssue(parentNumber, childNumber) {
  const child = await getIssue(childNumber);
  try {
    await rest('POST', `${issuePath(parentNumber)}/sub_issues`, { sub_issue_id: child.id });
  } catch (e) {
    if (/already/i.test(e.message)) return; // already linked
    throw e;
  }
}

// All issues assigned to me (open and closed), to find new issues by exact title on re-runs
async function myIssuesByTitle() {
  const map = new Map();
  for (let page = 1; page < 20; page++) {
    const list = await rest(
      'GET',
      `/repos/${ORG}/${REPO}/issues?assignee=${ME}&state=all&per_page=100&page=${page}`,
    );
    for (const i of list) if (!i.pull_request) map.set(i.title.trim(), i);
    if (list.length < 100) break;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
const hidden = (s, t) => `<!-- Start: ${s} Target: ${t} -->`;
const HIDDEN = /<!--\s*Start:\s*\d{4}-\d{2}-\d{2}\s+Target:\s*\d{4}-\d{2}-\d{2}\s*-->/i;
const demote = (t) => (t || '').replace(/^## /gm, '### ');
const show = (v) => (v == null || v === '' ? '(empty)' : v);
const d = (s, t = s) => ({ 'Start date': s, 'Target date': t });
const acTable = (rows) =>
  ['| No. | Acceptance Criteria |', '|---|---|', ...rows.map(([n, t]) => `| ${n} | ${t} |`)].join('\n');
const WITH_DUE = process.argv.includes('--with-due');

// Board date field (Project Due) is not loaded by loadProject(); look it up separately.
async function loadDateField(name) {
  const r = await gql(
    `query($o: String!, $n: Int!) {
      organization(login: $o) { projectV2(number: $n) { fields(first: 50) { nodes { ... on ProjectV2Field { id name dataType } } } } }
    }`,
    { o: ORG, n: PROJECT_NUMBER },
  );
  const f = r.organization.projectV2.fields.nodes.find((x) => x?.name === name && x.dataType === 'DATE');
  if (!f) throw new Error(`Board date field "${name}" not found`);
  return f.id;
}

async function setBoardDate(P, itemId, fieldId, date) {
  await gql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $d: Date!) {
      updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { date: $d } }) { projectV2Item { id } }
    }`,
    { p: P.id, i: itemId, f: fieldId, d: date },
  );
}

// ---------------------------------------------------------------------------
// Cycles. code: [issue or key, start, target]
// ---------------------------------------------------------------------------
const CYCLES = [
  { project: 'Sales Recon V3', plan: 414, planDates: ['2026-10-23'], release: 357, releaseDate: '2026-10-29',
    parents: [[155, '2026-10-21', '2026-10-26']],
    code: [[294, '2026-10-24', '2026-10-26'], [315, '2026-10-24', '2026-10-26'], [295, '2026-10-26'], [90, '2026-10-27'], [298, '2026-10-28'], [303, '2026-10-28']],
    note: '#294 + #315 are coded on Saturday and go out in their own PR on Monday, next to #295\'s PR. #298 + #303 are on hold; if PR #300\'s review is not settled by planning, they move to the V7 buffer week.' },
  { project: 'Sales Recon V4', plan: 416, planDates: ['2026-10-30'], release: 415, releaseDate: '2026-11-05',
    code: [[213, '2026-10-31', '2026-11-02'], [317, '2026-10-31', '2026-11-02'], [91, '2026-11-03'], [92, '2026-11-03'], [220, '2026-11-04']],
    note: '#220 was estimated at 1.5 days and has one day. If it runs over, move #92 to the OCR cycle and start #220 on Tuesday afternoon.' },
  { project: 'Sales Recon V5', plan: 418, planDates: ['2026-11-07'], release: 417, releaseDate: '2026-11-12',
    parents: [[409, '2026-11-09', '2026-11-11']],
    code: [[410, '2026-11-09'], [411, '2026-11-10'], [412, '2026-11-11'], [208, '2026-11-11']],
    note: 'Planning on Saturday: Friday 6 Nov is a public holiday (Hari Keputeraan Sultan Perak). Monday 9 Nov is a working day.' },
  { project: 'Sales Recon V6', plan: 420, planDates: ['2026-11-13'], release: 419, releaseDate: '2026-11-19',
    parents: [[346, '2026-11-14', '2026-11-18']],
    code: [[283, '2026-11-13'], ['UI1', '2026-11-14', '2026-11-16'], ['UI2', '2026-11-17'], ['UI3', '2026-11-18']],
    note: 'UI week. The prototype (#283) is drafted beforehand and reviewed with users at this planning; the agreed changes become the sub-issues\' acceptance criteria. Last Sales Recon cycle before APEX.' },
  { project: 'Sales Recon V7', plan: 422, planDates: ['2026-11-20'], release: 421, releaseDate: '2026-11-26', buffer: true, code: [],
    note: 'Buffer week before annual leave (30 Nov - 4 Dec). No planned coding. Used if #298/#303 stay on hold or the UI week overruns. If nothing slips, decide at the V6 retrospective whether APEX V1 starts here.' },
  { project: 'Sales Recon V8', plan: 424, planDates: ['2027-01-02'], release: 423, releaseDate: '2027-01-07',
    parents: [[164, '2027-01-04', '2027-01-13']],
    code: [[351, '2027-01-04', '2027-01-05'], [156, '2027-01-05'], [352, '2027-01-06']],
    note: 'OCR, after APEX. Tentative dates: confirmed when APEX is re-planned. Planning on Saturday 2 Jan if 1 Jan 2027 is a holiday (check the 2027 memo).' },
  { project: 'Sales Recon V9', plan: 426, planDates: ['2027-01-08'], release: 425, releaseDate: '2027-01-14',
    code: [[354, '2027-01-09', '2027-01-11'], [353, '2027-01-12'], [355, '2027-01-13']],
    note: 'OCR, after APEX. Tentative dates: confirmed when APEX is re-planned.' },
];

// ---------------------------------------------------------------------------
// Titles and bodies
// ---------------------------------------------------------------------------
const TITLES = {
  283: 'Prototype Sales Recon UI enhancement',
  346: 'Implement Sales Recon UI enhancement',
};

const UI_SUBS = [
  { key: 'UI1', title: 'Enhance Daily Sales Bank-in page UI', page: 'Daily Sales Bank-in page',
    extra: 'Coded Saturday and Monday; one PR on Monday.' },
  { key: 'UI2', title: 'Enhance Incomplete Submission and Manage Linked Dump list UI', page: 'Incomplete Submission and Manage Linked Dump list pages',
    extra: 'Both lists use the shared `InfiniteScrollLoader` (#292-#295). After the layout change they must still pass AC-27 to AC-30, AC-41 and AC-42.' },
  { key: 'UI3', title: 'Enhance Transaction Management page UI', page: 'Transaction Management page', extra: '' },
];

const uiSubBody = (s, parent) => `Part of #${parent}. UI enhancement of the **${s.page}**, as agreed in the prototype review (#283).

## Acceptance Criteria
${acTable([
  ['—', `Every change agreed in #283 for the ${s.page} is in place.`],
  ['—', `Data, filters and actions on the ${s.page} work the same as before the change.`],
  ['—', `The ${s.page} displays correctly in Chrome and Safari on desktop, and in Safari on iPhone.`],
])}

AC numbers are assigned at V6 planning (Fri 13 Nov), and the rows are replaced with the specific changes agreed in the prototype review.

## Don't miss
- UI only: no API or database changes. If the prototype needs one, raise it at planning instead.
- Use the central axios client from #220 for any API call the page touches.${s.extra ? `\n- ${s.extra}` : ''}`;

const body346 = (subRefs) => `Implement the Sales Recon UI enhancement agreed in the prototype review (#283), one page per coding day in the Sales Recon V6 cycle.

## Acceptance Criteria
${acTable([
  ['—', 'Every sub-issue below is done and all its acceptance criteria pass.'],
  ['—', 'Accounts staff and outlet leaders use the same features as before; only the layout and look change.'],
])}

## Delivered by
${subRefs.map(([r, s]) => `- ${r} ${s.page}`).join('\n')}

## Don't miss
- Blocked by #283 (prototype review at V6 planning, Fri 13 Nov).
- The infinite-scroll lists (#292-#295) must still pass AC-25 to AC-32 and AC-39 to AC-42 after the layout change.
- Outlet-leader screens checked in Safari on iPhone.

${hidden('2026-11-14', '2026-11-18')}`;

const body283 = `Prototype the Sales Recon UI enhancement (#346) and review it with users at Sales Recon V6 planning.

## What to do
- Draft the prototype before planning for the three pages in #346: Daily Sales Bank-in, Incomplete Submission and Manage Linked Dump lists, Transaction Management.
- Review it with accounts staff and outlet leaders at planning (Fri 13 Nov).
- Write the agreed changes into the acceptance criteria of #346's sub-issues.

## Acceptance Criteria
${acTable([
  ['—', 'The prototype covers the Daily Sales Bank-in page, the Incomplete Submission and Manage Linked Dump lists, and the Transaction Management page.'],
  ['—', 'Accounts staff and outlet leaders have tried the prototype and their feedback is recorded on this issue.'],
  ['—', 'Each of #346\'s sub-issues lists the agreed changes for its page as acceptance criteria.'],
])}

## Don't miss
- Anything that needs an API or database change is out of scope for the UI week; log it as a new issue.

${hidden('2026-11-13', '2026-11-13')}`;

const planBody = (c, ref) => `Planning for the **${c.project}** cycle (SDRPP-001 §1.2).${c.note ? `\n\n${c.note}` : ''}

## Coding this cycle
${c.code.length ? c.code.map(([k, s, t]) => `- ${ref(k)} (${s}${t && t !== s ? ` to ${t}` : ''})`).join('\n') : '- None planned (buffer week).'}

Release: #${c.release} on ${c.releaseDate}.

## Acceptance Criteria
${acTable([
  ['—', 'Existing and expected processes for this cycle are reviewed in the Module Process Document.'],
  ['—', 'Users have tried the prototype, if this cycle changes what users see.'],
  ['—', 'Every coding issue in this cycle has acceptance criteria agreed by the development lead and product owner.'],
  ['—', 'Scope and delivery dates for this cycle are confirmed.'],
])}

${hidden(c.planDates[0], c.planDates[1] || c.planDates[0])}`;

const releaseBody = (c, ref) => `Thursday test and release for **${c.project}** (SDRPP-001 §1.2 and §3).${c.buffer ? `\n\n${c.note}` : ''}

## Issues in this release
${[...(c.parents || []).map(([k]) => k), ...c.code.map(([k]) => k)].map((k) => `- ${ref(k)}`).join('\n') || '- None planned (buffer week). Anything moved into this week is listed here at planning.'}

## Acceptance Criteria
${acTable([
  ['—', 'Every acceptance criterion of the issues above has one row in the test spreadsheet, attached to its issue.'],
  ['—', 'Every row is marked Pass.'],
  ['—', 'The development lead has verified the spreadsheet and approved the release.'],
  ['—', 'The test branch is merged to main and deployed to production.'],
  ['—', 'A GitHub Release tag is created.'],
])}

${hidden(c.releaseDate, c.releaseDate)}`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = [];
const fail = (what, e) => { failures.push(`${what}: ${e.message}`); console.log(`    FAILED: ${e.message}`); };
const expected = [];
const keyNum = {};
const ref = (k) => (typeof k === 'number' ? `#${k}` : keyNum[k] ? `#${keyNum[k]}` : `(new: ${UI_SUBS.find((s) => s.key === k)?.title || k})`);

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');
console.log(WITH_DUE ? 'Project Due will be set to each cycle\'s Thursday.' : 'Project Due is NOT touched (add --with-due to set it).');

const P = await loadProject();
const dueFieldId = WITH_DUE ? await loadDateField('Project Due') : null;
const mine = await myIssuesByTitle();

async function applyFields(n, nodeId, { project, fields, priority, due }) {
  if (!APPLY) return;
  try {
    const itemId = await ensureOnBoard(P, nodeId);
    if (project) await setBoardSelect(P, itemId, 'Project', project);
    await setBoardSelect(P, itemId, 'Module', MODULE);
    if (WITH_DUE && due) await setBoardDate(P, itemId, dueFieldId, due);
  } catch (e) { fail(`#${n} board fields`, e); }
  const cur = await readIssueFields(n).catch(() => ({}));
  const all = { ...(priority ? { Priority: priority } : {}), ...(fields || {}) };
  for (const [k, v] of Object.entries(all)) {
    if (cur[k] === v) continue;
    try { await writeIssueField(n, k, v); } catch (e) { fail(`#${n} ${k}`, e); }
  }
  if (fields) expected.push([n, fields]);
}

// Update an existing issue: project, dates, optional title/body; keeps the hidden line in step
async function updateExisting(n, c, s, t, { title, body } = {}) {
  let issue;
  try { issue = await getIssue(n); } catch (e) { return fail(`#${n} read`, e); }
  const cur = await readIssueFields(n).catch(() => ({}));
  let newBody = body ?? null;
  if (!newBody && HIDDEN.test(issue.body || '')) {
    const synced = issue.body.replace(HIDDEN, hidden(s, t));
    if (synced !== issue.body) newBody = synced;
  }
  if (newBody && newBody.trim() === (issue.body || '').trim()) newBody = null;
  const newTitle = title && title !== issue.title ? title : null;
  console.log(`\n#${n} ${issue.title}${newTitle ? `\n  title -> "${newTitle}"` : ''}`);
  console.log(`  ${c.project} | ${show(cur['Start date'])} -> ${s}, ${show(cur['Target date'])} -> ${t}${newBody ? ' | body updated' : ''}${issue.state === 'closed' ? ' | CLOSED (left closed)' : ''}`);
  if (!APPLY) return;
  const patch = {};
  if (newTitle) patch.title = newTitle;
  if (newBody) patch.body = newBody;
  if (Object.keys(patch).length) await rest('PATCH', issuePath(n), patch).catch((e) => fail(`#${n} title/body`, e));
  await applyFields(n, issue.node_id, { project: c.project, fields: d(s, t), due: c.releaseDate });
}

// 1. UI sub-issues under #346 (created first so #346's body can link them)
console.log('\n--- #346 sub-issues (Sales Recon V6) ---');
const v6 = CYCLES.find((c) => c.project === 'Sales Recon V6');
for (const s of UI_SUBS) {
  const [, start, target = start] = v6.code.find(([k]) => k === s.key);
  const found = mine.get(s.title);
  const body = `${uiSubBody(s, 346)}\n\n${hidden(start, target)}`;
  console.log(`\n${found ? `#${found.number} (already exists)` : 'NEW'} ${s.title}\n  Sales Recon V6 | Low | ${start} -> ${target} | under #346`);
  if (found) { keyNum[s.key] = found.number; }
  if (!APPLY) continue;
  try {
    const issue = found || (await rest('POST', `/repos/${ORG}/${REPO}/issues`, { title: s.title, body, assignees: [ME] }));
    if (!found) console.log(`  created #${issue.number}`);
    keyNum[s.key] = issue.number;
    await applyFields(issue.number, issue.node_id, { project: 'Sales Recon V6', fields: d(start, target), priority: 'Low', due: v6.releaseDate });
    await addSubIssue(346, issue.number).catch((e) => fail(`#${issue.number} link to #346`, e));
  } catch (e) { fail(`create "${s.title}"`, e); }
}

// 2. Existing issues, cycle by cycle
const BODIES = { 283: body283 };
for (const c of CYCLES) {
  console.log(`\n=== ${c.project} (release ${c.releaseDate}) ===`);
  for (const [n, s, t] of c.parents || []) {
    const body = n === 346 ? body346(UI_SUBS.map((x) => [ref(x.key), x])) : undefined;
    await updateExisting(n, c, s, t, { title: TITLES[n], body });
  }
  for (const [k, s, t = s] of c.code) {
    if (typeof k !== 'number') continue;
    await updateExisting(k, c, s, t, { title: TITLES[k], body: BODIES[k] });
  }
  // Plan and Release issues
  await updateExisting(c.plan, c, c.planDates[0], c.planDates[1] || c.planDates[0], { body: planBody(c, ref) });
  await updateExisting(c.release, c, c.releaseDate, c.releaseDate, { body: releaseBody(c, ref) });
}

// 3. Verify
if (APPLY) {
  console.log('\n--- Verifying ---');
  let bad = 0;
  for (const [n, f] of expected) {
    const now = await readIssueFields(n).catch(() => ({}));
    for (const [k, v] of Object.entries(f)) {
      if (now[k] !== v) { bad++; console.log(`  #${n} ${k}: expected ${v}, GitHub has ${show(now[k])}`); }
    }
  }
  const subs = await rest('GET', `${issuePath(346)}/sub_issues?per_page=50`).catch(() => []);
  const linked = new Set(subs.map((x) => x.number));
  for (const s of UI_SUBS) if (keyNum[s.key] && !linked.has(keyNum[s.key])) { bad++; console.log(`  #${keyNum[s.key]} is not a sub-issue of #346`); }
  console.log(bad ? `\n${bad} value(s) did not stick (see above).` : `\nAll ${expected.length} issues' dates and the #346 sub-issues verified.`);
}
console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nNo failures.');
process.exit(failures.length ? 1 : 0);

// scripts/apply-cycles.mjs
// Moves the Dev Pipeline to the SDRPP-001 weekly cycle:
//   Fri plan -> Sat(½) + Mon-Wed code (1 issue = 1 day = 1 PR) -> Thu test + release.
//   One cycle = one Project value; Project Due = that cycle's Thursday.
// Creates a Plan and a Release issue per cycle, the brought-forward feature issues,
// adds Acceptance Criteria tables to cycle 1 issues, and sets every date and Project.
//
// Preview (changes nothing):   node scripts/apply-cycles.mjs
// Write to GitHub:             node scripts/apply-cycles.mjs --apply
// Token: GH_TOKEN from .env (see .env.example). Safe to re-run.

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
const show = (v) => (v == null || v === '' ? '(empty)' : v);
const d = (s, t = s) => ({ 'Start date': s, 'Target date': t });
const acTable = (rows) =>
  ['| No. | Acceptance Criteria |', '|---|---|', ...rows.map(([n, t]) => `| ${n} | ${t} |`)].join('\n');

// ---------------------------------------------------------------------------
// Acceptance criteria (Sales Recon module numbering continues from AC-20)
// ---------------------------------------------------------------------------
const AC = {
  297: [
    ['AC-21', 'Accounts staff can generate the reconciliation for a 3-month date range without an error.'],
    ['AC-22', 'Accounts staff see that generation is in progress, and the Generate button stays disabled until it finishes.'],
    ['AC-23', 'The reconciliation summary updates by itself when generation finishes.'],
    ['AC-24', 'Accounts staff see an error message when generation fails.'],
  ],
  155: [
    ['AC-25', 'On the Recon Dashboard, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-26', 'On the Recon Dashboard, rows already shown stay visible while more rows load.'],
    ['AC-27', 'On Manage Linked Dump, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-28', 'On Manage Linked Dump, rows already shown stay visible while more rows load.'],
    ['AC-29', 'On Incomplete Submission, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-30', 'On Incomplete Submission, rows already shown stay visible while more rows load.'],
    ['AC-31', 'On Shortage Status, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-32', 'On Shortage Status, rows already shown stay visible while more rows load.'],
  ],
};
const pick = (list, ...ids) => list.filter(([n]) => ids.includes(n));

// Existing body becomes "Implementation notes" under a new AC section (only once)
const withAcSection = (intro, rows) => (oldBody) => {
  if (/##\s*Acceptance Criteria\s*\n\s*\|/i.test(oldBody || '')) return null; // already converted
  return `${intro}\n\n## Acceptance Criteria\n${acTable(rows)}\n\n## Implementation notes\n${(oldBody || '').trim()}`;
};

const BODY_297 = (oldBody) => {
  if (/##\s*Acceptance Criteria\s*\n\s*\|/i.test(oldBody || '')) return null;
  const notes = (oldBody || '')
    .replace(/^## Problem[\s\S]*?(?=## What to do)/, '')
    .replace(/## Acceptance criteria[\s\S]*?(?=## Don't miss)/i, '')
    .replace(HIDDEN, '')
    .trim();
  return `Generating the reconciliation for a large date range runs inside the web request and times out, so accounts staff get a 504 error in production.

Status: backend change is in an open PR; the frontend (progress, polling, error message) is this cycle's work.

## Acceptance Criteria
${acTable(AC[297])}

## Implementation notes
${notes}`;
};

const BODY_155 = (oldBody) => {
  if (/##\s*Acceptance Criteria\s*\n\s*\|/i.test(oldBody || '')) return null;
  return `Paginated lists in Sales Recon jump back to the top while scrolling in Safari, and briefly flash a loading view in every browser while the next page loads.

## Acceptance Criteria
${acTable(AC[155])}

## Delivered by
- #292 Recon Dashboard: AC-25, AC-26
- #293 Manage Linked Dump: AC-27, AC-28
- #294 Incomplete Submission: AC-29, AC-30
- #295 Shortage Status: AC-31, AC-32

## Implementation notes
${(oldBody || '').trim()}`;
};

// ---------------------------------------------------------------------------
// New feature issues (brought-forward, cycle 4)
// ---------------------------------------------------------------------------
const BF_PARENT = {
  key: 'BF',
  title: 'Check brought-forward amounts are banked in on the declared day',
  body: `Outlet leaders declare a brought-forward (BF) amount in their daily Excel when they could not bank in all of a sales date's cash. The accounts team's Python script carries it into the sales entry CSV. OMS checks whether the bank-in made on the declared day actually covered that BF, and shows it as Covered, Late (covered on a later day) or Outstanding (amount still owed). Module Process Document EP-11.

## Acceptance Criteria
AC-16 to AC-20 from the Module Process Document v0.2 (Appendix A). To be agreed by the development lead and product owner at cycle 4 planning and copied here word for word before coding starts.

## Implementation notes
- Depends on the accounts team adding the BF columns to their Python script. Agree the column names first (proposed: \`brought_forward_amount\`, \`brought_forward_sales_date\`).
- \`accounts.sales_data\` is unique per (sales_date, account_id, project_id), so only one BF per outlet per day fits. Confirm leaders never carry forward from two different days at once.
- Files without the BF columns must keep uploading as today (\`uploadSalesFromExcel\`).
- Use strict YYYY-MM-DD for the BF date: \`parseDate\` falls back to \`new Date(...).toISOString()\`, which can shift a date by one day.
- Cover check uses \`cash_dumps.sales_dates_hint\` (which sales dates each dump covers and how much).
- Weekend handling is still open in the process document.`,
  project: 'Sales Recon V5', s: '2026-11-09', t: '2026-11-11',
};
const BF_SUBS = [
  { key: 'BF1', title: 'Store brought-forward amounts from the sales upload', s: '2026-11-09',
    body: 'Part of #{BF}. Add the BF amount and BF sales date to the sales upload, store them, and show invalid BF rows on the upload result with row number and reason.\n\nDelivers: acceptance criteria assigned at cycle 4 planning.' },
  { key: 'BF2', title: 'Calculate brought-forward cover status', s: '2026-11-10',
    body: 'Part of #{BF}. For each declared BF, work out Covered, Late or Outstanding from the cash dumps, with the remaining amount and the covering dump(s). Refresh when the reconciliation is generated.\n\nDelivers: acceptance criteria assigned at cycle 4 planning.' },
  { key: 'BF3', title: 'Show brought-forward reconciliation to accounts staff', s: '2026-11-11',
    body: 'Part of #{BF}. Screen listing each BF with outlet, original sales date, declared day, amount, status and covering dump(s), with filters.\n\nDelivers: acceptance criteria assigned at cycle 4 planning.' },
];

// ---------------------------------------------------------------------------
// Cycles (SDRPP-001 §1.2). code: [issue or key, start, target]
// ---------------------------------------------------------------------------
const CYCLES = [
  { project: 'Sales Recon V2', plan: ['2026-10-16', '2026-10-19'], release: '2026-10-22', reuseRelease: 356, planStatus: 'In Progress',
    code: [[297, '2026-10-20'], [292, '2026-10-21'], [293, '2026-10-21']] },
  { project: 'Sales Recon V3', plan: ['2026-10-23'], release: '2026-10-29', reuseRelease: 357,
    code: [[294, '2026-10-24', '2026-10-26'], [315, '2026-10-24', '2026-10-26'], [295, '2026-10-27'], [298, '2026-10-28'], [303, '2026-10-28']],
    parents: [155] },
  { project: 'Sales Recon V4', plan: ['2026-10-30'], release: '2026-11-05',
    code: [[213, '2026-10-31', '2026-11-02'], [317, '2026-10-31', '2026-11-02'], [91, '2026-11-03'], [92, '2026-11-03'], [90, '2026-11-04']] },
  { project: 'Sales Recon V5', plan: ['2026-11-07'], release: '2026-11-12', note: 'Planning on Saturday: Friday 6 Nov is a public holiday (Hari Keputeraan Sultan Perak).',
    code: [['BF1', '2026-11-09'], ['BF2', '2026-11-10'], ['BF3', '2026-11-11']], parents: ['BF'] },
  { project: 'Sales Recon V6', plan: ['2026-11-13'], release: '2026-11-19',
    code: [[220, '2026-11-14', '2026-11-16'], [156, '2026-11-17'], [208, '2026-11-18']] },
  { project: 'Sales Recon V7', plan: ['2026-11-20'], release: '2026-11-26', note: 'Includes the UI prototype review with users (#283).',
    code: [[283, '2026-11-20'], [351, '2026-11-21', '2026-11-23'], [352, '2026-11-24'], [353, '2026-11-25']] },
  { project: 'Sales Recon V8', plan: ['2026-11-27'], release: '2026-12-10', note: 'Planned before annual leave (30 Nov - 4 Dec); coding resumes Sat 5 Dec. Wed 9 Dec is buffer.',
    code: [[354, '2026-12-05', '2026-12-07'], [355, '2026-12-08']], parents: [164] },
  { project: 'Sales Recon V9', plan: ['2026-12-11'], release: '2026-12-17', note: '#346 spans the whole cycle; split it into one-day sub-issues at planning once the prototype (#283) is confirmed.',
    code: [[346, '2026-12-12', '2026-12-16']] },
  { project: 'APEX V1', plan: ['2026-12-18'], release: '2026-12-24',
    code: [[114, '2026-12-19', '2026-12-21'], [115, '2026-12-22'], [89, '2026-12-23'], [93, '2026-12-23']], parents: [98] },
  { project: 'APEX V2', plan: ['2026-12-26'], release: '2026-12-31', note: 'Planning on Saturday: Friday 25 Dec is a public holiday (Christmas).',
    code: [[94, '2026-12-28'], [99, '2026-12-28'], [110, '2026-12-29'], [111, '2026-12-30']], parents: [358] },
  { project: 'APEX V3', plan: ['2027-01-02'], release: '2027-01-07', note: 'Planning on Saturday: Friday 1 Jan is New Year (check the 2027 holiday memo).',
    code: [[112, '2027-01-04'], [113, '2027-01-05'], [116, '2027-01-06']], parents: [100] },
  { project: 'APEX V4', plan: ['2027-01-08'], release: '2027-01-14',
    code: [[118, '2027-01-09', '2027-01-11'], [119, '2027-01-12'], [120, '2027-01-13']], parents: [117] },
  { project: 'APEX V5', plan: ['2027-01-15'], release: '2027-01-21', reuseRelease: 359, note: 'Sat 16 - Wed 20 is buffer for APEX overflow. Manual testing (#121) is the Thursday test run.',
    code: [[121, '2027-01-21']] },
];

// Body changes for existing issues in cycle 1 (others get their ACs at their own planning)
const BODY_EDITS = {
  297: { title: 'Move manual recon generation to a background job', body: BODY_297 },
  155: { body: BODY_155 },
  292: { body: withAcSection('Part of #155. Delivers AC-25, AC-26.', pick(AC[155], 'AC-25', 'AC-26')) },
  293: { body: withAcSection('Part of #155. Delivers AC-27, AC-28.', pick(AC[155], 'AC-27', 'AC-28')) },
  294: { body: withAcSection('Part of #155. Delivers AC-29, AC-30. Ships in the same PR as #315.', pick(AC[155], 'AC-29', 'AC-30')) },
  295: { body: withAcSection('Part of #155. Delivers AC-31, AC-32.', pick(AC[155], 'AC-31', 'AC-32')) },
};

const planBody = (c, ref) => `Planning for the **${c.project}** cycle (SDRPP-001 §1.2).${c.note ? `\n\n${c.note}` : ''}

## Coding this cycle
${c.code.map(([k, s, t]) => `- ${ref(k)} (${s}${t && t !== s ? ` to ${t}` : ''})`).join('\n')}

Release: ${ref('REL')} on ${c.release}.

## Acceptance Criteria
${acTable([
  ['—', 'Existing and expected processes for this cycle are reviewed in the Module Process Document.'],
  ['—', 'Users have tried the prototype, if this cycle changes what users see.'],
  ['—', 'Every coding issue in this cycle has acceptance criteria agreed by the development lead and product owner.'],
  ['—', 'Scope and delivery dates for this cycle are confirmed.'],
])}

${hidden(c.plan[0], c.plan[1] || c.plan[0])}`;

const releaseBody = (c, ref) => `Thursday test and release for **${c.project}** (SDRPP-001 §1.2 and §3).

## Issues in this release
${[...(c.parents || []), ...c.code.map(([k]) => k)].map((k) => `- ${ref(k)}`).join('\n')}

## Acceptance Criteria
${acTable([
  ['—', 'Every acceptance criterion of the issues above has one row in the test spreadsheet, attached to its issue.'],
  ['—', 'Every row is marked Pass.'],
  ['—', 'The development lead has verified the spreadsheet and approved the release.'],
  ['—', 'The test branch is merged to main and deployed to production.'],
  ['—', 'A GitHub Release tag is created.'],
])}

${hidden(c.release, c.release)}`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = [];
const fail = (what, e) => {
  failures.push(`${what}: ${e.message}`);
  console.log(`    FAILED: ${e.message}`);
};
const expected = []; // [number, fields] for verification

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');
const P = await loadProject();
const mine = await myIssuesByTitle();
const keyNum = {}; // 'BF' -> 371 etc. ('NEW' placeholders in dry run)

async function upsertIssue({ number, title, body, project, fields, priority = 'Medium', status, parent }) {
  let issue = null;
  if (number) issue = await getIssue(number);
  else issue = mine.get(title) || null;
  const label = issue ? `#${issue.number}` : 'NEW';
  console.log(`\n${label} ${title || issue.title}${issue && title && issue.title !== title ? `   (was "${issue.title}")` : ''}`);
  console.log(`  ${project} | ${priority} | ${fields['Start date']} -> ${fields['Target date']}${status ? ` | ${status}` : ''}${parent ? ` | under #${parent}` : ''}`);
  if (!APPLY) return issue ? issue.number : null;

  try {
    if (!issue) {
      issue = await rest('POST', `/repos/${ORG}/${REPO}/issues`, { title, body, assignees: [ME] });
      console.log(`  created #${issue.number}`);
    } else {
      const patch = {};
      if (title && title !== issue.title) patch.title = title;
      if (body && body.trim() !== (issue.body || '').trim()) patch.body = body;
      if (issue.state === 'closed') patch.state = 'open';
      if (Object.keys(patch).length) await rest('PATCH', issuePath(issue.number), patch);
    }
  } catch (e) {
    fail(`upsert "${title}"`, e);
    return issue?.number || null;
  }
  await applyFields(issue, { project, fields, priority, status });
  if (parent) {
    try { await addSubIssue(parent, issue.number); } catch (e) { fail(`#${issue.number} link to #${parent}`, e); }
  }
  return issue.number;
}

async function applyFields(issue, { project, fields, priority, status }) {
  try {
    const itemId = await ensureOnBoard(P, issue.node_id);
    if (project) await setBoardSelect(P, itemId, 'Project', project);
    await setBoardSelect(P, itemId, 'Module', MODULE);
    if (status) await setBoardSelect(P, itemId, 'Status', status);
  } catch (e) { fail(`#${issue.number} board fields`, e); }
  const cur = await readIssueFields(issue.number).catch(() => ({}));
  const all = { ...(priority ? { Priority: priority } : {}), ...(fields || {}) };
  for (const [k, v] of Object.entries(all)) {
    if (cur[k] === v) continue;
    try { await writeIssueField(issue.number, k, v); } catch (e) { fail(`#${issue.number} ${k}`, e); }
  }
  if (fields) expected.push([issue.number, fields]);
}

const ref = (k) => (typeof k === 'number' ? `#${k}` : keyNum[k] ? `#${keyNum[k]}` : `(${k})`);

// 1. Brought-forward issues first, so plans/releases can reference their numbers
console.log('\n--- Brought-forward feature (cycle 4) ---');
keyNum.BF = await upsertIssue({ title: BF_PARENT.title, body: BF_PARENT.body, project: BF_PARENT.project, fields: d(BF_PARENT.s, BF_PARENT.t) });
for (const s of BF_SUBS) {
  const body = `${s.body.replace('{BF}', keyNum.BF || 'BF')}\n\n${hidden(s.s, s.s)}`;
  keyNum[s.key] = await upsertIssue({ title: s.title, body, project: BF_PARENT.project, fields: d(s.s), parent: keyNum.BF });
}

// 2. Existing coding issues: project, dates, cycle-1 bodies
console.log('\n--- Existing issues ---');
for (const c of CYCLES) {
  for (const n of c.parents || []) {
    if (typeof n !== 'number') continue;
    const issue = await getIssue(n).catch((e) => (fail(`#${n} read`, e), null));
    if (!issue) continue;
    const edit = BODY_EDITS[n];
    const newBody = edit?.body ? edit.body(issue.body) : null;
    console.log(`\n#${n} ${issue.title}  [parent]\n  ${c.project}${newBody ? ' | acceptance criteria added' : ''}`);
    if (!APPLY) continue;
    if (newBody) await rest('PATCH', issuePath(n), { body: newBody }).catch((e) => fail(`#${n} body`, e));
    await applyFields(issue, { project: c.project });
  }
  for (const [k, s, t = s] of c.code) {
    if (typeof k !== 'number') continue;
    const issue = await getIssue(k).catch((e) => (fail(`#${k} read`, e), null));
    if (!issue) continue;
    const cur = await readIssueFields(k).catch(() => ({}));
    const edit = BODY_EDITS[k];
    let newBody = edit?.body ? edit.body(issue.body) : null;
    const base = newBody ?? issue.body ?? '';
    const synced = HIDDEN.test(base) ? base.replace(HIDDEN, hidden(s, t)) : newBody ? `${base}\n\n${hidden(s, t)}` : null;
    if (synced && synced !== issue.body) newBody = synced;
    const title = edit?.title && edit.title !== issue.title ? edit.title : null;
    console.log(`\n#${k} ${issue.title}`);
    console.log(`  ${c.project} | ${show(cur['Start date'])} -> ${s}, ${show(cur['Target date'])} -> ${t}${title ? ` | title -> "${title}"` : ''}${newBody ? ' | body updated' : ''}`);
    if (!APPLY) continue;
    const patch = {};
    if (title) patch.title = title;
    if (newBody) patch.body = newBody;
    if (Object.keys(patch).length) await rest('PATCH', issuePath(k), patch).catch((e) => fail(`#${k} title/body`, e));
    await applyFields(issue, { project: c.project, fields: d(s, t) });
  }
}

// 3. Plan and Release issues per cycle
console.log('\n--- Plan and Release issues ---');
for (const c of CYCLES) {
  const relTitle = `Release ${c.project}`;
  keyNum.REL = c.reuseRelease || mine.get(relTitle)?.number || null;
  // create/update release first so the plan can link to it
  const relNum = await upsertIssue({
    number: c.reuseRelease, title: relTitle, body: releaseBody(c, ref), project: c.project, fields: d(c.release),
  });
  keyNum.REL = relNum;
  await upsertIssue({
    title: `Plan ${c.project}`, body: planBody(c, ref), project: c.project,
    fields: d(c.plan[0], c.plan[1] || c.plan[0]), status: c.planStatus,
  });
}

// 4. Verify
if (APPLY) {
  console.log('\n--- Verifying ---');
  let bad = 0;
  for (const [n, f] of expected) {
    const now = await readIssueFields(n).catch(() => ({}));
    for (const [k, v] of Object.entries(f)) {
      if (now[k] !== v) { bad++; console.log(`  #${n} ${k}: expected ${v}, GitHub has ${show(now[k])}`); }
    }
  }
  console.log(bad ? `\n${bad} value(s) did not stick (see above).` : `\nAll ${expected.length} issues' dates verified.`);
}
console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nNo failures.');
process.exit(failures.length ? 1 : 0);

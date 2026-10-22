// scripts/apply-sr-final.mjs
// Sales Recon plan agreed 21 Oct 2026: merge in branch order (prototype-faqhrul), finish Thu 12 Nov.
//   - Renames every Sales Recon issue to the agreed [TYPE] titles
//   - Puts each issue's acceptance criteria table (AC-01 to AC-54, branch order) in its description,
//     with its commits and merge order; old notes are kept under "Implementation notes"
//   - Dates and Project values for V2 (22 Oct), V3 (29 Oct), V4 (5 Nov), V5 (12 Nov)
//   - Creates [FEATURE] Compliance Overview (V5)
//   - Renames the Plan/Release issues of V2-V5 to [PLAN] / [RELEASE] and rewrites them:
//     plan = commits grouped by issue + every AC of the cycle; release = an AC checklist
//   - Closes: #444/#446 (UI sub-issues), #283 (prototype done), OCR #164 + #351-#355,
//     and the Plan/Release issues of V6-V9
//
// Preview (changes nothing):   node scripts/apply-sr-final.mjs
// Preview with every new body: node scripts/apply-sr-final.mjs --show-bodies
// Write to GitHub:             node scripts/apply-sr-final.mjs --apply --with-due
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
// Sales Recon plan agreed 21 Oct: merge in branch order, done Thu 12 Nov.
// ---------------------------------------------------------------------------
const AC = {
  298: [['AC-01', 'The outlet leader can upload a baki image when no sales entry exists yet for the sales date.']],
  297: [
    ['AC-02', 'Accounts staff can generate the reconciliation for any date range without an error.'],
    ['AC-03', 'Accounts staff see the progress of a running generation.'],
    ['AC-04', 'The reconciliation summary updates by itself when generation finishes.'],
    ['AC-05', 'Accounts staff see an error message when generation fails.'],
    ['AC-06', 'Accounts staff see an estimated time before a generation starts.'],
    ['AC-07', 'Accounts staff see every generation that is running or queued, including those started by other staff.'],
    ['AC-08', 'Accounts staff can remove a queued generation they started.'],
    ['AC-09', 'Accounts staff cannot remove a generation that has already started or that another staff member started.'],
    ['AC-10', 'Accounts staff see when the reconciliation was last generated and who generated it.'],
    ['AC-11', 'Accounts staff can start a new generation while another is running; it waits in the queue and runs after the earlier one finishes.'],
  ],
  303: [['AC-12', 'A baki image removed in the edit form no longer appears on the cash dump after saving.']],
  315: [
    ['AC-13', 'An outlet leader sees only the cash dumps they submitted in Incomplete Submission.'],
    ['AC-14', 'An outlet leader cannot open a cash dump with no recorded submitter from Incomplete Submission.'],
  ],
  292: [
    ['AC-15', 'On the Recon Dashboard, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-16', 'On the Recon Dashboard, rows already shown stay visible while more rows load, with no loading flash.'],
    ['AC-17', 'On the Recon Dashboard, changing a filter shows the list from the first rows again.'],
    ['AC-18', 'On the Recon Dashboard, each row appears only once after more rows load.'],
  ],
  293: [
    ['AC-19', 'On Manage Linked Dump, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-20', 'On Manage Linked Dump, rows already shown stay visible while more rows load, with no loading flash.'],
    ['AC-21', 'On Manage Linked Dump, changing a filter shows the list from the first rows again.'],
    ['AC-22', 'On Manage Linked Dump, each row appears only once after more rows load.'],
  ],
  294: [
    ['AC-23', 'On Incomplete Submission, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-24', 'On Incomplete Submission, rows already shown stay visible while more rows load, with no loading flash.'],
  ],
  295: [
    ['AC-25', 'On Shortage Status, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
    ['AC-26', 'On Shortage Status, rows already shown stay visible while more rows load, with no loading flash.'],
  ],
  213: [['AC-27', 'The running balance for an outlet and sales date equals the total of all variances up to that date, whatever date range was last generated.']],
  317: [['AC-28', 'Shortage Status shows the same running balance as the Recon Dashboard for each outlet and sales date.']],
  90: [['AC-29', 'A slip whose details OCR could not fill is shown as not yet checked on the Daily Sales Bank-in form.']],
  91: [['AC-30', 'Accounts staff can delete a bank transaction only on the day it was uploaded, including a transaction uploaded again after an earlier delete.']],
  156: [['AC-31', 'An outlet and sales date with no sales and no cash dump does not appear on the Recon Dashboard.']],
  208: [['AC-32', 'A bank-in slip or baki image opens in the preview without a timeout error, even when the form has been open for a while.']],
  92: [
    ['AC-33', 'Accounts staff wait less time for the reconciliation to finish generating than before the change.'],
    ['AC-34', 'The matching bank transactions for a bank-in slip appear faster than before the change.'],
    ['AC-35', 'The same bank transactions are matched to each slip as before the change.'],
  ],
  220: [
    ['AC-36', 'Every accounts screen loads, saves and uploads data the same as before the change.'],
    ['AC-37', 'Accounts screens show the same error messages as before the change when a request fails.'],
  ],
  409: [
    ['AC-38', 'Accounts staff can upload a sales entry CSV that includes a brought-forward amount and its original sales date.'],
    ['AC-39', 'Accounts staff see each declared brought-forward with its original sales date, amount and the sales date it was declared on.'],
    ['AC-40', 'A brought-forward shows Covered when the cash dump for the declared sales date includes the full amount against the original sales date.'],
    ['AC-41', 'A brought-forward shows Late when it is covered by a cash dump for a later sales date.'],
    ['AC-42', 'A brought-forward shows Outstanding, with the remaining amount, when it is not yet fully covered.'],
  ],
  346: [
    ['AC-43', 'The outlet leader submits a bank-in in five steps: Outlet & Account, Resit, Duit Sales Untuk, Baki & Catatan, Semak.'],
    ['AC-44', 'The bank-in amount is allocated to outstanding short dates from the oldest date first.'],
    ['AC-45', 'Each slip field filled by OCR shows whether the outlet leader has checked it.'],
    ['AC-46', 'Editing an existing cash dump works the same as before the change.'],
    ['AC-47', 'The page displays correctly in Chrome and Safari on desktop, and in Safari on iPhone.'],
  ],
  CO: [
    ['AC-48', "Management sees, for each outlet, whether today's bank-in was submitted on time, is pending or is missing against the 5:00 PM due time."],
    ['AC-49', 'Management sees, for each outlet, whether the sales entry was uploaded by 1:00 PM.'],
    ['AC-50', 'Management sees, for each bank account, whether the bank transactions were uploaded by 1:00 PM.'],
    ['AC-51', "On Sunday no submission is required, and Monday's cards check both Saturday's and Sunday's sales."],
    ['AC-52', 'Management sees total sales by day, month or year, for all outlets or one outlet.'],
    ['AC-53', 'Management sees the share of reconciliation days in each status, and a Total Short that matches the running balance.'],
    ['AC-54', "Management sees how many of this month's bank-ins were submitted on time, late or not at all."],
  ],
};
const pick = (n, ...ids) => AC[n].filter(([k]) => ids.includes(k));
AC[155] = [...AC[292], ...AC[293], ...AC[294], ...AC[295]];
AC[410] = pick(409, 'AC-38');
AC[411] = pick(409, 'AC-40', 'AC-41', 'AC-42');
AC[412] = pick(409, 'AC-39', 'AC-40', 'AC-41', 'AC-42');

// Every coding issue, in branch (merge) order. step = position in the merge order.
// intro = the live issue / planned change line from the Acceptance Criteria document.
const ISSUES = [
  { n: 298, step: 1, title: '[BUG] Baki Image Dump Submission Guard', project: 'Sales Recon V2', s: '2026-10-21',
    intro: 'Live issue: the outlet leader cannot upload a baki image before the sales entry is uploaded.',
    commits: ['PR #300 (`fix/baki-upload-guard`), merged into `prototype-faqhrul` at `11a60ee`'] },
  { n: 297, step: 2, title: '[FEATURE] Reconciliation Background Job', project: 'Sales Recon V2', s: '2026-10-20', t: '2026-10-21', priority: 'Urgent',
    intro: 'Live issue: generating the reconciliation for a large date range times out with a 504 error.',
    commits: ['PR #390 (`feat/recon-generate-backend`), `dd99091` recon worker backend', '`63cdd1d` queue manual recon generation instead of running it inside the request',
      '`0d6e4c7` keep only recent finished jobs on the accounts queue', '`269e641` add recon jobs, estimate and remove job api calls',
      '`2f5819f` add recon queue side panel and job list components', '`e69b683` poll recon jobs, fetch the estimate and refresh the summary',
      '`b83731e` move generate recon into the side panel and show the last run'] },
  { n: 303, step: 3, title: '[BUG] Delete Baki Image Edit Form', project: 'Sales Recon V2', s: '2026-10-21',
    intro: 'Live issue: a baki image removed in the edit form is still kept after saving.',
    commits: ['In PR #300 (`fix/baki-upload-guard`), together with #298 Baki Image Dump Submission Guard'] },
  { n: 315, step: 4, title: '[CHORE] Hide Dump Submission from Other Leader', project: 'Sales Recon V3', s: '2026-10-24', t: '2026-10-26',
    intro: 'Live issue: cash dumps with no recorded submitter are shown to every outlet leader. Rule: an outlet leader sees only the cash dumps they submitted.',
    commits: ['`57bc48a` show outlet leaders only the incomplete dumps they submitted'] },
  { n: 155, step: 5, title: '[FEATURE] Infinite Scroller', project: 'Sales Recon V3', s: '2026-10-24', t: '2026-10-26',
    intro: 'Live issue: the lists jump back to the top while scrolling in Safari and flash a loading view while the next rows load.',
    delivered: ['#292 Recon Dashboard: AC-15 to AC-18', '#293 Manage Linked Dump: AC-19 to AC-22', '#294 Incomplete Submission: AC-23, AC-24', '#295 Shortage Status: AC-25, AC-26'],
    commits: ['See the four sub-issues'] },
  { n: 292, step: 5, title: '[FEATURE] Infinite Scroller: Recon Dashboard', project: 'Sales Recon V3', s: '2026-10-24', t: '2026-10-26',
    intro: 'Part of #155 Infinite Scroller.', commits: ['`99869bf` move InfiniteScrollLoader to shared components', '`059f2c0` let InfiniteScrollLoader take a rootMargin', '`0612d32` load more recon dashboard rows without a jump or loading flash'] },
  { n: 293, step: 5, title: '[FEATURE] Infinite Scroller: Manage Linked Dump', project: 'Sales Recon V3', s: '2026-10-24', t: '2026-10-26',
    intro: 'Part of #155 Infinite Scroller.', commits: ['`b2368f1` load more linked dumps without a jump or loading flash'] },
  { n: 294, step: 5, title: '[FEATURE] Infinite Scroller: Incomplete Submission', project: 'Sales Recon V3', s: '2026-10-24', t: '2026-10-26',
    intro: 'Part of #155 Infinite Scroller.', commits: ['`30eefcc` load more incomplete submissions without a jump or loading flash'] },
  { n: 213, step: 6, title: '[BUG] Reconciliation Running Balance Calculation', project: 'Sales Recon V3', s: '2026-10-26',
    intro: 'Live issue: the running balance is wrong when the reconciliation was generated for only part of the date range.',
    commits: ['`454d865` keep stored running balance right after generating a smaller range'],
    extra: 'Recon engine change: ask Shafiq to review it. It relies on the save-in-one-transaction step from PR #390 (#297 Reconciliation Background Job).' },
  { n: 317, step: 7, title: '[BUG] Shortage Status Running Balance', project: 'Sales Recon V3', s: '2026-10-26',
    intro: 'Live issue: Shortage Status calculates its own running balance instead of using the saved one.',
    commits: ['`704e362` read stored running balance for Shortage Status'] },
  { n: 295, step: 8, title: '[FEATURE] Infinite Scroller: Shortage Status', project: 'Sales Recon V3', s: '2026-10-26',
    intro: 'Part of #155 Infinite Scroller.', commits: ['`6d7d048` page Shortage Status records and load more on scroll'] },
  { n: 90, step: 9, title: '[BUG] Collapsible Receipt Card', project: 'Sales Recon V3', s: '2026-10-27',
    intro: 'Live issue: when OCR cannot read a slip, the slip card is treated as already checked.',
    commits: ['`fc972d0` show a slip OCR could not fill as not yet checked'] },
  { n: 91, step: 10, title: '[FEATURE] Delete Bank Transaction For Today Only', project: 'Sales Recon V3', s: '2026-10-27',
    intro: 'Live issue: the same-day delete rule for bank transactions does not hold after a re-upload. Rule: a bank transaction can only be deleted on the day it was uploaded, and is uploaded again the same day.',
    commits: ['`cf02670` allow deleting a bank transaction file only on its upload day'] },
  { n: 156, step: 11, title: '[BUG] Reconciliation Row Bug ~No (Sales/Dump)', project: 'Sales Recon V3', s: '2026-10-27',
    intro: 'Live issue: some outlet and sales date rows show Pending with no sales and no cash dump.',
    commits: ['`5d7e0f1` leave out recon rows with no sales and nothing dumped'] },
  { n: 208, step: 12, title: '[BUG] Image Preview Timeout', project: 'Sales Recon V3', s: '2026-10-27',
    intro: 'Live issue: the slip and baki image previews time out once the form has been open for a while.',
    commits: ['`4a96fe5` keep slip and Baki image links valid for an hour'] },
  { n: 92, step: 13, title: '[FEATURE] Optimize Reconciliation Automation Query', project: 'Sales Recon V3', s: '2026-10-27',
    intro: 'Live issue: finding the bank transactions that match a bank-in slip is slow, which slows the cash dump form and the reconciliation. Each criterion is measured on the same data before and after the change.',
    commits: ['`4c13410` turn off JIT on the accounts field pool'] },
  { n: 220, step: 14, title: '[REFACTOR] Central Axios', project: 'Sales Recon V3', s: '2026-10-28',
    intro: 'Technical change: accounts screens move to the central API client, with no new behaviour for users.',
    commits: ['`1ab069e` send 409 instead of 403 when an accounts rule refuses a change', '`73c28f5` move accountApi to the central api client'] },
  { n: 409, step: 15, title: '[FEATURE] Brought Forward Reconciliation Check', project: 'Sales Recon V4', s: '2026-10-31', t: '2026-11-02',
    intro: 'Pain point: a brought-forward amount is tracked only in free-text remarks, so there is no check that it was banked in on the day it was declared. Rule: the outlet leader banks in a brought-forward amount the next day.',
    delivered: ['#410 Store From Sales Upload: AC-38', '#411 Cover Status: AC-40 to AC-42', '#412 Reconciliation List: AC-39 to AC-42'],
    commits: ['See the three sub-issues'],
    extra: 'Adds a migration on a proposed schema: Shafiq reviews it before V4 starts.' },
  { n: 410, step: 15, title: '[FEATURE] Brought Forward: Store From Sales Upload', project: 'Sales Recon V4', s: '2026-10-31',
    intro: 'Part of #409 Brought Forward Reconciliation Check.', commits: ['`a63186a` store brought-forward amounts from the sales upload'] },
  { n: 411, step: 15, title: '[FEATURE] Brought Forward: Cover Status', project: 'Sales Recon V4', s: '2026-11-02',
    intro: 'Part of #409 Brought Forward Reconciliation Check.', commits: ['`3ec5cfc` work out brought-forward cover status'] },
  { n: 412, step: 15, title: '[FEATURE] Brought Forward: Reconciliation List', project: 'Sales Recon V4', s: '2026-11-02',
    intro: 'Part of #409 Brought Forward Reconciliation Check.', commits: ['`b852177` show brought-forward cover status to accounts staff'] },
  { n: 346, step: 16, title: '[FEATURE] Daily Sales Bank In UI Enhancement', project: 'Sales Recon V4', s: '2026-11-03', t: '2026-11-04',
    intro: 'Planned change: the outlet leader submits the daily bank-in through a step-by-step form, as agreed in the prototype review.',
    commits: ['`b53d679` keep outlet and account for the next bank-in', '`71157df` redesign daily sales bank-in as a step-by-step wizard',
      '`32792b8` bank-in wizard buttons and check boxes', '`fd9f4e8` log why a receipt scan failed', '`8606daf` give receipt fields full width and tidy focus and camera error',
      '`ee996d3` auto-allocate bank-in to the oldest short date first', '`f42f797` put the slip check box inside each receipt field'],
    extra: 'One commit is 2,800 lines, so Tuesday has no PR: the PR goes in on Wednesday.' },
];

const CO_TITLE = '[FEATURE] Compliance Overview';
const CO = { step: 17, title: CO_TITLE, project: 'Sales Recon V5', s: '2026-11-09', t: '2026-11-10', priority: 'Medium',
  intro: 'Planned change: management sees on one page whether outlet leaders and accounts staff submit on time, with total sales and reconciliation status.',
  commits: ['`fbb33f4` add management overview endpoints', '`0a2f947` add management overview page'],
  notes: [
    'The code calls the page "Management Overview".',
    'Bank-in is due by 5:00 PM on the day after the sales date; if that is a Sunday, Monday covers both Saturday and Sunday.',
    'Sales entry and bank transactions are due by 1:00 PM. Sales entry uses `updated_at`, so a re-upload after 1:00 PM turns that day late. Bank transactions are counted per bank account by its first upload of the day.',
    'Company holidays are not left out yet; the attendance public holidays page could be the source later.',
    'The reconciliation donut shows an EXCESS slice, which the prototype does not have, so the percentages stay right.',
    'Not built from the prototype: the rules table (CR-01 to CR-07), per-outlet follow-ups and the breach list.',
    'Checked against a seeded test database only: check against real data before release.',
  ] };

// Plan / Release issues for the four remaining cycles
const CYCLES = [
  { project: 'Sales Recon V2', plan: 413, release: 356, releaseDate: '2026-10-22', planDates: null,
    note: 'Release follows the branch order: PR #300 first, then #297 Reconciliation Background Job.' },
  { project: 'Sales Recon V3', plan: 414, release: 357, releaseDate: '2026-10-29', planDates: ['2026-10-23'],
    note: 'Monday\'s PR carries #315 Hide Dump, the Infinite Scroller lists and both running-balance fixes together, because the running-balance commits sit between the scroller commits.' },
  { project: 'Sales Recon V4', plan: 416, release: 415, releaseDate: '2026-11-05', planDates: ['2026-10-30'],
    note: 'Shafiq reviews the brought-forward migration before coding starts.' },
  { project: 'Sales Recon V5', plan: 418, release: 417, releaseDate: '2026-11-12', planDates: ['2026-11-07'],
    note: 'Planning on Saturday: Friday 6 Nov is a public holiday. Wednesday 11 Nov is buffer. Last Sales Recon cycle.' },
];

// Closed with a comment. reason: completed | not_planned
const CLOSE = [
  { n: 444, reason: 'not_planned', why: 'Merged into #346 [FEATURE] Daily Sales Bank In UI Enhancement, which now carries its acceptance criteria and commits.' },
  { n: 446, reason: 'not_planned', why: 'Dropped: the UI enhancement now covers only the Daily Sales Bank-in page (#346).' },
  { n: 283, reason: 'completed', why: 'The prototype is done and built on `prototype-faqhrul` (#346 Daily Sales Bank In UI Enhancement and the Compliance Overview).' },
  ...[164, 351, 352, 353, 354, 355].map((n) => ({ n, reason: 'not_planned', why: 'OCR work is set aside: not a priority for Sales Recon. Reopen when it is planned again.' })),
  ...[419, 420, 421, 422, 423, 424, 425, 426].map((n) => ({ n, reason: 'not_planned', why: 'Sales Recon now finishes in V5 (12 Nov), so this cycle is not needed.' })),
];

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------
// Keep the old body's notes: the "Implementation notes" section if there is one, otherwise the
// old body without its acceptance criteria section and hidden line.
function oldNotes(body) {
  let b = (body || '').replace(HIDDEN, '').trim();
  const m = b.match(/^##\s*Implementation notes\s*\n([\s\S]*)$/im);
  if (m) b = m[1];
  else b = b.replace(/^##\s*Acceptance criteria[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '');
  b = b.replace(/^#+\s*Acceptance Criteria\s*\n\|[^\n]*\n\|[^\n]*\n(\|\s*—[^\n]*\n?)+/gim, '');
  b = b.replace(/^##\s*(Commits|Merge order)[\s\S]*?(?=^##\s|(?![\s\S]))/gim, '');
  return demote(b).trim();
}

const list = (xs) => xs.map((x) => `- ${x}`).join('\n');
function issueBody(it, oldBody, n) {
  const notes = it.notes ? list(it.notes) : oldNotes(oldBody);
  return [
    it.intro,
    `## Acceptance Criteria\n${acTable(AC[n])}`,
    it.delivered ? `## Delivered by\n${list(it.delivered)}` : null,
    `## Commits\nMerge order ${it.step} on \`prototype-faqhrul\`:\n${list(it.commits)}`,
    it.extra || notes ? `## Implementation notes\n${[it.extra ? `- ${it.extra}` : '', notes].filter(Boolean).join('\n')}` : null,
    hidden(it.s, it.t || it.s),
  ].filter(Boolean).join('\n\n');
}

const inCycle = (c) => [...ISSUES.filter((i) => i.project === c.project), ...(CO.project === c.project ? [CO] : [])];
const ref = (i) => `${i.n ? `#${i.n}` : '(new)'} ${i.title}`;

const SUBS = [292, 293, 294, 295, 410, 411, 412];
const top = (c) => inCycle(c).filter((i) => !(i.n && SUBS.includes(i.n)));
const subsOf = (c, parent) => inCycle(c).filter((i) => i.intro.startsWith(`Part of #${parent} `));
const acOf = (i) => (i === CO ? AC.CO : AC[i.n]);
const when = (i) => `${i.s}${i.t && i.t !== i.s ? ` to ${i.t}` : ''}`;

// Plan: one table row per issue (sub-issues as their own rows), then each issue's ACs under its own heading
const cell = (xs) => xs.map((k) => k.replace(/\|/g, '\\|')).join('<br>');
function issueTable(c) {
  const rows = ['| No. | Issue | Date | Commits |', '|---|---|---|---|'];
  for (const i of top(c)) {
    const subs = subsOf(c, i.n);
    rows.push(`| ${i.step} | ${ref(i)} | ${when(i)} | ${subs.length ? 'See the sub-issues below' : cell(i.commits)} |`);
    for (const x of subs) rows.push(`| ${x.step} | ↳ ${ref(x)} | ${when(x)} | ${cell(x.commits)} |`);
  }
  return rows.join('\n');
}

const planBody = (c, ref) => {
  const groups = top(c).map((i) => `### ${ref(i)}\n${acTable(acOf(i))}`).join('\n\n');
  const n = top(c).flatMap(acOf).length;
  return `Planning for the **${c.project}** cycle (SDRPP-001 §1.2).${c.note ? `\n\n${c.note}` : ''}

Release: #${c.release} [RELEASE] ${c.project} on ${c.releaseDate}.

## Issues and commits (merge order on \`prototype-faqhrul\`)
${issueTable(c)}

## Acceptance criteria by issue (${n})
${groups}${c.planDates ? `\n\n${hidden(c.planDates[0], c.planDates[1] || c.planDates[0])}` : ''}`;
};

// Release: one checkbox per acceptance criterion, grouped by issue, ticked as each test row passes
const releaseBody = (c, ref, oldBody = '') => {
  // keep boxes already ticked, so a re-run never un-ticks a passed criterion
  const done = new Set([...(oldBody || '').matchAll(/^- \[x\] (?:\*\*(AC-\d+)\*\*.*|(.+))$/gim)].map((m) => m[1] || m[2].trim()));
  const box = (key) => (done.has(key) ? '[x]' : '[ ]');
  const rows = top(c);
  const acs = rows.flatMap(acOf);
  const checks = rows.map((i) => `### ${ref(i)}\n${acOf(i).map(([n, t]) => `- ${box(n)} **${n}** ${t}`).join('\n')}`).join('\n\n');
  return `Thursday test and release for **${c.project}** (SDRPP-001 §1.2 and §3). Plan: #${c.plan} [PLAN] ${c.project}.

## Test checklist (${acs.length} rows: ${acs[0][0]} to ${acs[acs.length - 1][0]})
Tick each criterion when its row in the test spreadsheet is marked Pass. Any Fail blocks the release.

${checks}

## Release steps
- ${box('Every criterion above has one row in the test spreadsheet, attached to its issue.')} Every criterion above has one row in the test spreadsheet, attached to its issue.
- ${box('Every row is marked Pass.')} Every row is marked Pass.
- ${box('The development lead has verified the spreadsheet and approved the release.')} The development lead has verified the spreadsheet and approved the release.
- ${box('The commits are merged to main in branch order and deployed to production.')} The commits are merged to main in branch order and deployed to production.
- ${box('A GitHub Release tag is created.')} A GitHub Release tag is created.

${hidden(c.releaseDate, c.releaseDate)}`;
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const SHOW = process.argv.includes('--show-bodies');
const failures = [];
const fail = (what, e) => { failures.push(`${what}: ${e.message}`); console.log(`    FAILED: ${e.message}`); };
const expected = [];

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');
console.log(WITH_DUE ? "Project Due will be set to each cycle's Thursday." : 'Project Due is NOT touched (add --with-due to set it).');

const P = await loadProject();
const dueFieldId = WITH_DUE ? await loadDateField('Project Due') : null;
const mine = await myIssuesByTitle();
const dueOf = (project) => CYCLES.find((c) => c.project === project)?.releaseDate;

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

async function update(n, { title, body, project, s, t, priority }) {
  let issue;
  try { issue = await getIssue(n); } catch (e) { return fail(`#${n} read`, e); }
  const cur = await readIssueFields(n).catch(() => ({}));
  const newTitle = title && title !== issue.title ? title : null;
  const newBody = body && body.trim() !== (issue.body || '').trim() ? body : null;
  console.log(`\n#${n} ${issue.title}${newTitle ? `\n  title -> "${newTitle}"` : ''}`);
  console.log(`  ${project} | ${show(cur['Start date'])} -> ${s}, ${show(cur['Target date'])} -> ${t}${priority ? ` | ${priority}` : ''}${newBody ? ' | body rewritten' : ''}${issue.state === 'closed' ? ' | CLOSED (left closed)' : ''}`);
  if (!APPLY) return issue;
  const patch = {};
  if (newTitle) patch.title = newTitle;
  if (newBody) patch.body = newBody;
  if (Object.keys(patch).length) await rest('PATCH', issuePath(n), patch).catch((e) => fail(`#${n} title/body`, e));
  await applyFields(n, issue.node_id, { project, fields: d(s, t), priority, due: dueOf(project) });
  return issue;
}

// 1. Coding issues, in branch order
console.log('\n--- Coding issues (branch order) ---');
const bodies = {};
for (const it of ISSUES) {
  const issue = await getIssue(it.n).catch((e) => (fail(`#${it.n} read`, e), null));
  if (!issue) continue;
  bodies[it.n] = issueBody(it, issue.body, it.n);
  if (SHOW) console.log('\n  --- new body of #' + it.n + ' ---\n' + bodies[it.n].split('\n').map((l) => '  ' + l).join('\n'));
  await update(it.n, { title: it.title, body: bodies[it.n], project: it.project, s: it.s, t: it.t || it.s, priority: it.priority });
}

// 2. New issue: Compliance Overview
console.log('\n--- New issue ---');
let coNum = mine.get(CO_TITLE)?.number || null;
const coBody = issueBody(CO, '', 'CO');
console.log(`\n${coNum ? `#${coNum} (already exists)` : 'NEW'} ${CO_TITLE}\n  ${CO.project} | ${CO.priority} | ${CO.s} -> ${CO.t} | assigned ${ME}`);
if (!APPLY) { console.log('\n  --- body ---\n' + coBody.split('\n').map((l) => '  ' + l).join('\n')); }
if (APPLY) {
  try {
    if (!coNum) {
      const created = await rest('POST', `/repos/${ORG}/${REPO}/issues`, { title: CO_TITLE, body: coBody, assignees: [ME] });
      coNum = created.number;
      console.log(`  created #${coNum}`);
      await applyFields(coNum, created.node_id, { project: CO.project, fields: d(CO.s, CO.t), priority: CO.priority, due: dueOf(CO.project) });
    } else {
      await update(coNum, { title: CO_TITLE, body: coBody, project: CO.project, s: CO.s, t: CO.t, priority: CO.priority });
    }
    const it = await getIssue(coNum);
    const itemId = await ensureOnBoard(P, it.node_id);
    await setBoardSelect(P, itemId, 'Status', 'Todo');
  } catch (e) { fail('create Compliance Overview', e); }
}
CO.n = coNum;

// 3. Plan and Release issues
console.log('\n--- Plan and Release issues ---');
for (const c of CYCLES) {
  const curPlan = await readIssueFields(c.plan).catch(() => ({}));
  const ps = c.planDates ? c.planDates[0] : curPlan['Start date'];
  const pt = c.planDates ? (c.planDates[1] || c.planDates[0]) : curPlan['Target date'];
  await update(c.plan, { title: `[PLAN] ${c.project}`, body: planBody(c, ref), project: c.project, s: ps, t: pt });
  const relOld = (await getIssue(c.release).catch(() => ({}))).body;
  await update(c.release, { title: `[RELEASE] ${c.project}`, body: releaseBody(c, ref, relOld), project: c.project, s: c.releaseDate, t: c.releaseDate });
}

// 4. Close
console.log('\n--- Close ---');
for (const x of CLOSE) {
  const issue = await getIssue(x.n).catch((e) => (fail(`#${x.n} read`, e), null));
  if (!issue) continue;
  if (issue.state === 'closed') { console.log(`#${x.n} ${issue.title}  (already closed)`); continue; }
  console.log(`#${x.n} ${issue.title}  -> close as ${x.reason.replace('_', ' ')}`);
  if (!APPLY) continue;
  try {
    await rest('POST', `${issuePath(x.n)}/comments`, { body: x.why });
    await rest('PATCH', issuePath(x.n), { state: 'closed', state_reason: x.reason });
  } catch (e) { fail(`#${x.n} close`, e); }
}

// 5. Verify
if (APPLY) {
  console.log('\n--- Verifying ---');
  let bad = 0;
  for (const [n, f] of expected) {
    const now = await readIssueFields(n).catch(() => ({}));
    for (const [k, v] of Object.entries(f)) if (now[k] !== v) { bad++; console.log(`  #${n} ${k}: expected ${v}, GitHub has ${show(now[k])}`); }
  }
  for (const it of ISSUES) {
    const now = await getIssue(it.n).catch(() => null);
    const want = AC[it.n][AC[it.n].length - 1][0];
    if (!now || now.title !== it.title || !(now.body || '').includes(`| ${want} |`)) { bad++; console.log(`  #${it.n}: title or AC table did not save`); }
  }
  for (const x of CLOSE) {
    const now = await getIssue(x.n).catch(() => null);
    if (now && now.state !== 'closed') { bad++; console.log(`  #${x.n} is still open`); }
  }
  console.log(bad ? `\n${bad} problem(s) (see above).` : `\nVerified: ${ISSUES.length} issues renamed with AC tables, dates set, ${CLOSE.length} closed or already closed.`);
}
console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nNo failures.');
process.exit(failures.length ? 1 : 0);

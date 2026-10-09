// scripts/apply-plan.mjs
// One-off: applies the agreed Dev Pipeline re-plan (Sales Recon V2, V3, APEX V1).
//
// Preview (changes nothing):   node scripts/apply-plan.mjs
// Write to GitHub:             node scripts/apply-plan.mjs --apply
//
// Needs GH_TOKEN with: repo (issues) + project (org Projects) scopes.
// Safe to re-run: new issues are matched by exact title and not created twice.

const ORG = 'onlineoms';
const REPO = 'devinfra';
const PROJECT_NUMBER = 2;
const ME = 'faqhrul-dev';
const MODULE = 'Accounts';

const APPLY = process.argv.includes('--apply');
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GH_TOKEN is not set. In PowerShell: $env:GH_TOKEN = "<your token>"');
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
// Descriptions
// ---------------------------------------------------------------------------
const hidden = (s, t) => `<!-- Start: ${s} Target: ${t} -->`;

const scroller = ({ list, file, extra = '', s, t }) => `Replace the scroll listener on the ${list} with the \`InfiniteScrollLoader\` sentinel pattern from PR #288 (see #292). Part of #155.

## Cause of the bug
Load-more reuses the initial \`loading\` flag, so the rows can unmount while the next page loads (the "reload" flash). The \`requestAnimationFrame\` scrollTop restore then races React's render. Chrome hides this with scroll anchoring; Safari doesn't, so the list jumps back to the top.

## What to do
- Add a separate \`loadingMore\` flag and keep rows mounted while the next page loads
- Use the shared \`InfiniteScrollLoader\` (IntersectionObserver, \`root: .content\`)
- Delete the \`savedScrollTop\` / \`requestAnimationFrame\` restore and the \`.content\` scroll listener
- Ignore stale responses with a request id (filter change while a page is loading)
${extra}
File: ${file}

## Acceptance criteria
- [ ] Safari (Mac and iPhone): scrolling to the end loads the next page with no jump to the top
- [ ] No loading flash while the next page loads
- [ ] Changing a filter resets the list to page 1
- [ ] No page is fetched twice

${hidden(s, t)}`;

const BODY = {
  297: `## Problem
\`POST /accounts/reconciliation/generate\` runs \`generateReconciliationSummary\` inside the HTTP request. With a large date range it runs past the gateway timeout and accounts staff get a **504 in production**.

## What to do
- Add an \`account-manual-recon\` job to the existing \`scheduled-accounts\` queue and worker in \`backend/src/api/accounts/workers/accountWorker.ts\` (BullMQ and Redis are already set up there for the 1pm/8pm scheduled recon)
- \`accountController.generateReconciliation\`: enqueue \`{ startDate, endDate, projectId, requestedBy }\` and return \`202 { jobId }\`
- Add \`GET /accounts/reconciliation/generate/:jobId\` returning the job state (waiting / active / completed / failed) and the error message on failure
- Frontend: \`generateReconciliation\` in \`accountApi.ts\` returns the jobId; \`useReconciliation\` polls the status endpoint until done, then refetches the summary. Disable the Generate button while a job is running

## Acceptance criteria
- [ ] Generating a 3-month range completes with no 504
- [ ] User sees that generation is running, and gets a clear message if it fails
- [ ] Summary refreshes automatically when the job completes
- [ ] Scheduled 1pm/8pm recon still runs as before

## Don't miss
- Dedupe: derive the jobId from the range and project so a double-click or two users don't run the same range twice
- Overlap with the scheduled job (worker concurrency is 1, so jobs queue; confirm that's acceptable)
- The job has no \`req.dbPool\` and runs as \`app_system\`, like the scheduled job: confirm its grants cover a manual date range and the \`projectId\` filter
- Keep \`checkPermission("sales_recon", "accounts_staff")\` on both the enqueue and status endpoints
- Set \`removeOnComplete\` / \`removeOnFail\` so Redis doesn't grow
- Log \`requestedBy\` for audit
- Must ship before #220 (the central axios client has a 30s timeout)

${hidden('2026-10-09', '2026-10-13')}`,

  220: `Move \`frontend-web/src/features/accounts/api/accountApi.ts\` from direct \`axios\` calls to the central client in \`frontend-web/src/lib/api.ts\`, following the task module refactor in PR #221 (#219).

## What to do
- Replace \`axios.get/post/put/patch/delete(...)\` with \`api.*\` and drop the repeated \`withCredentials: true\`
- Keep \`accountUrl\` as the base (the central client has no \`baseURL\`)
- Check for any other direct \`axios\` imports under \`features/accounts\`

## Acceptance criteria
- [ ] No direct \`axios\` import left in the accounts feature
- [ ] All accounts pages (bank transactions, sales, recon, cash dump, incomplete submissions, monthly summary, OCR) still load and save
- [ ] Large uploads and exports still work

## Don't miss
- The central client has \`timeout: 30000\`. Give a longer per-call timeout to \`uploadTransactionFile\`, \`uploadSalesFile\`, \`uploadProjectionFile\`, \`exportTransactionsCSV\` and \`scanBankSlip\`
- Do this **after #297**; otherwise large recon generations fail at 30s with a misleading "Connection lost" alert
- The interceptor \`alert()\`s on 401/403/413/network errors: check accounts pages don't also show their own error toast (double message)
- 401 now redirects to \`/login\`

${hidden('2026-10-21', '2026-10-21')}`,

  283: `Plan the Sales Recon V3 UI prototype before any redesign work (#346).

## What to do
- List the screens to improve: recon dashboard, cash dump form, incomplete submissions, shortage status, linked dumps
- Build a prototype of the proposed changes
- Review it with accounts staff and outlet leaders

## Acceptance criteria
- [ ] Prototype covers each listed screen
- [ ] Feedback collected from accounts staff and outlet leaders
- [ ] Agreed list of changes written down for #346

${hidden('2026-10-23', '2026-10-24')}`,

  346: `Implement the UI changes agreed in #283 on the current Sales Recon screens.

## Acceptance criteria
- [ ] Every change agreed in #283 is implemented
- [ ] No API or behaviour changes, UI only
- [ ] Outlet-leader screens checked on mobile, including Safari

## Don't miss
- Blocked by #283
- Re-check that the infinite scroll lists (#292–#295) still behave after layout changes

${hidden('2026-10-26', '2026-10-28')}`,

  155: `Paginated lists in Sales Recon show two symptoms of the same bug:
- **Safari:** while scrolling, the list jumps back to the top
- **All browsers:** the list briefly flashes a loading view while the next page loads

## Cause
On load-more, the hooks reuse the same \`loading\` flag as the first page load, so the list can unmount while the next page loads. The \`requestAnimationFrame\` scrollTop restore then races React's render. Chrome hides this with scroll anchoring; Safari doesn't.

## Fixed by
- #292 Recon dashboard (PR #288, not merged yet)
- #293 Manage linked dump
- #294 Incomplete submission
- #295 Shortage status`,

  292: scroller({
    list: 'recon dashboard',
    file: '`frontend-web/src/features/accounts/hooks/useReconciliation.ts`, `components/SummaryTable.jsx`',
    extra: `- The fix already exists in PR #288 (closed as a draft, never merged): reopen it or open a new PR from \`feat/infinite-scroll\`, mark it ready and get it reviewed
- Move \`features/tasks/components/InfiniteScrollLoader.tsx\` to a shared \`components/\` folder and use it from both tasks and accounts, instead of the second \`.jsx\` copy added in PR #288
`,
    s: '2026-10-15',
    t: '2026-10-15',
  }),
  293: scroller({
    list: 'manage linked dump list',
    file: '`frontend-web/src/features/accounts/hooks/useLinkedDumpList.ts`',
    s: '2026-10-15',
    t: '2026-10-15',
  }),
  294: scroller({
    list: 'incomplete submission list',
    file: 'the incomplete submission list hook (check `useCashDumpList.ts` / `useCashDumpListForAccounts.ts`). Do #315 in the same change: it edits the same query',
    s: '2026-10-16',
    t: '2026-10-16',
  }),
  295: scroller({
    list: 'shortage status list',
    file: 'the shortage status list hook',
    s: '2026-10-16',
    t: '2026-10-16',
  }),

  164: `OCR for bank slips runs on Qwen VL (\`qwen-vl-plus\`) in \`backend/src/api/agents/services/ocrServices.ts\`. Measure accuracy on real slips, try each improvement, and ship the best combination.

## Methods to try
- Change OCR model
- Raise image resolution
- SDK option \`enable_rotate\`
- Preprocess with sharp (EXIF rotate, grayscale, strip color, contrast)
- Denomination check & checksum on the result

## Acceptance criteria
- [ ] Field-level accuracy (amount, date, time, account number, transaction type) measured on the same test set before and after
- [ ] Shipped configuration beats the current baseline
- [ ] Results of every method recorded in this issue

## Don't miss
- Grayscale / strip color can remove the bank "Received" stamp, which the prompt uses to decide COUNTER DEPOSIT vs CASH DEPOSIT MACHINE: check \`transaction_type\` accuracy specifically
- \`currentDate\` uses \`toISOString()\` (UTC): between 00:00 and 08:00 Malaysia time the prompt is told it's yesterday
- Track token cost and latency per configuration, not only accuracy

${hidden('2026-10-29', '2026-11-04')}`,
};

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------
const d = (s, t = s) => ({ 'Start date': s, 'Target date': t });

// Existing issues: title / body / state / issue fields
const EDITS = [
  // Sales Recon V2
  { n: 297, title: 'Move manual recon generation to a background job', body: BODY[297], fields: { Priority: 'Urgent', ...d('2026-10-09', '2026-10-13') } },
  { n: 303, fields: d('2026-10-13') },
  { n: 156, fields: d('2026-10-14') },
  { n: 292, body: BODY[292], state: 'open', boardStatus: 'Todo', fields: d('2026-10-15') },
  { n: 293, body: BODY[293], fields: d('2026-10-15') },
  { n: 294, body: BODY[294], fields: d('2026-10-16') },
  { n: 315, fields: d('2026-10-16') },
  { n: 295, body: BODY[295], fields: d('2026-10-16') },
  { n: 155, body: BODY[155] }, // parent: dates follow sub-issues
  { n: 90, fields: d('2026-10-17') },
  { n: 213, fields: d('2026-10-19') },
  { n: 317, fields: d('2026-10-19') },
  { n: 91, fields: d('2026-10-20') },
  { n: 92, fields: d('2026-10-20') },
  { n: 220, title: 'Migrate accounts API to central axios client', body: BODY[220], fields: d('2026-10-21') },
  { n: 208, fields: d('2026-10-22') },

  // Sales Recon V3
  { n: 283, title: 'Plan Sales Recon V3 UI prototype', body: BODY[283], fields: d('2026-10-23', '2026-10-24') },
  { n: 346, title: 'Implement Sales Recon V3 UI redesign', body: BODY[346], fields: d('2026-10-26', '2026-10-28') },
  { n: 164, title: 'Improve bank slip OCR accuracy', body: BODY[164] }, // parent: dates follow sub-issues

  // APEX V1 (Option 1: built and tested before 30 Nov)
  { n: 98, fields: d('2026-11-05', '2026-11-06') },
  { n: 114, fields: d('2026-11-05') },
  { n: 115, fields: d('2026-11-06') },
  { n: 89, fields: d('2026-11-07', '2026-11-10') },
  { n: 93, fields: d('2026-11-10') },
  { n: 94, fields: d('2026-11-11', '2026-11-12') },
  { n: 99, fields: d('2026-11-12') },
  { n: 100, fields: d('2026-11-13', '2026-11-20') },
  { n: 110, fields: d('2026-11-13') },
  { n: 111, fields: d('2026-11-14', '2026-11-16') },
  { n: 112, fields: d('2026-11-16', '2026-11-17') },
  { n: 113, fields: d('2026-11-17', '2026-11-18') },
  { n: 116, fields: d('2026-11-19', '2026-11-20') },
  { n: 117, fields: d('2026-11-21', '2026-11-27') },
  { n: 118, title: 'Build ledger table UI', fields: d('2026-11-21', '2026-11-24') },
  { n: 119, title: 'Build expenses table UI', fields: d('2026-11-24', '2026-11-25') },
  { n: 120, fields: d('2026-11-26', '2026-11-27') },
  { n: 121, fields: d('2026-11-27', '2026-11-28') },
];

// New issues. parent: an issue number. children: existing issue numbers to put under this one.
const NEW = [
  {
    title: 'Build labelled OCR test set and accuracy harness',
    project: 'Sales Recon V3', priority: 'Medium', parent: 164, ...{ s: '2026-10-29', t: '2026-10-29' },
    body: `Part of #164. Every other OCR sub-issue is measured with this.

## What to do
- Collect real bank slips across the banks in use (Maybank, CIMB, Public Bank, RHB, AmBank, AFFIN), both CDM and counter deposits, including rotated, blurry and low-light photos
- Record the correct \`amount\`, \`transaction_date\`, \`transaction_time\`, \`account_number\` and \`transaction_type\` for each
- Write a script that runs \`extractOcrData\` over the set with a given config and reports per-field accuracy, token use and latency
- Run it on the current config to get the baseline

## Acceptance criteria
- [ ] Test set with expected values, stored outside the repo (slips contain account numbers)
- [ ] Script prints per-field accuracy for a given config
- [ ] Baseline recorded in #164`,
  },
  {
    title: 'Test OCR model, high-resolution and enable_rotate options',
    project: 'Sales Recon V3', priority: 'Medium', parent: 164, s: '2026-10-30', t: '2026-10-30',
    body: `Part of #164. These are request-level changes in \`extractOcrData\`, so each one is a config change in the harness.

## What to do
- Compare \`qwen-vl-plus\` against the other Qwen VL models available to us
- Test raising image resolution (high-resolution option on the request)
- Test the \`enable_rotate\` SDK option
- Run each alone, then the best combination

## Acceptance criteria
- [ ] Per-field accuracy, token cost and latency for each option recorded in #164
- [ ] Each option confirmed as supported by the model it was tested with`,
  },
  {
    title: 'Preprocess bank slips with sharp before OCR',
    project: 'Sales Recon V3', priority: 'Medium', parent: 164, s: '2026-10-31', t: '2026-11-02',
    body: `Part of #164. Clean the image before it is base64-encoded and sent to the model. \`sharp\` is already a backend dependency (\`backend/src/workers/imageWorker.ts\`).

## What to do
- Auto-rotate using EXIF
- Grayscale / strip color
- Increase contrast
- Measure each step alone and combined

## Acceptance criteria
- [ ] Per-field accuracy for each step recorded in #164
- [ ] \`transaction_type\` accuracy checked separately (stamp colour is a cue)
- [ ] Preprocessing time per image measured`,
  },
  {
    title: 'Add denomination check and checksum validation to OCR result',
    project: 'Sales Recon V3', priority: 'Medium', parent: 164, s: '2026-11-02', t: '2026-11-03',
    body: `Part of #164. Validate the OCR result after extraction so bad reads are caught instead of saved.

## What to do
- Denomination check on \`amount\` (catch RM/sen mix-ups and amounts that can't come from the notes deposited)
- Checksum / consistency checks (e.g. \`account_number\` matches a known bank account, date not in the future)
- Decide what happens on failure: flag the field for the user to confirm, or retry once

## Acceptance criteria
- [ ] Known bad reads from the test set are flagged
- [ ] Correct reads are not flagged (false alarms measured)
- [ ] Rules documented in #164`,
  },
  {
    title: 'Ship best OCR configuration',
    project: 'Sales Recon V3', priority: 'Medium', parent: 164, s: '2026-11-03', t: '2026-11-04',
    body: `Part of #164. Put the winning combination from the tests into production code.

## What to do
- Apply the chosen model, request options, preprocessing and validation in \`ocrServices.ts\`
- Keep a fallback to the current config if the new path errors
- Re-run the harness on the final code

## Acceptance criteria
- [ ] Final accuracy beats the baseline on the test set
- [ ] Latency and token cost acceptable
- [ ] Fallback tested`,
  },
  {
    title: 'Sales Recon V2 regression test and production deploy',
    project: 'Sales Recon V2', priority: 'High', s: '2026-10-22', t: '2026-10-22',
    body: `Final check and production release for Sales Recon V2.

## What to do
- Regression test on staging: recon generation (#297), baki image upload and edit (#298, #303), infinite scroll lists (#292–#295), running balance (#213, #317), bank transactions (#91, #92), cash dump form (#90), central axios client (#220)
- Run pending migrations
- Deploy to production and smoke test with accounts staff and an outlet leader

## Acceptance criteria
- [ ] All V2 issues merged and tested on staging
- [ ] Production deploy done and smoke test passed
- [ ] Rollback plan known before deploying`,
  },
  {
    title: 'Sales Recon V3 test and deploy',
    project: 'Sales Recon V3', priority: 'Medium', s: '2026-11-04', t: '2026-11-04',
    body: `Final check and production release for Sales Recon V3 (UI redesign #346, OCR #164).

## What to do
- Test the redesigned screens on desktop and mobile, including Safari
- Re-run the OCR harness against staging
- Deploy and smoke test

## Acceptance criteria
- [ ] Staging test passed
- [ ] Production deploy done and smoke test passed`,
  },
  {
    title: 'Pull other debits from SQL Accounting into OMS',
    project: 'APEX V1', priority: 'Medium', children: [89, 93, 94, 99], s: '2026-11-07', t: '2026-11-12',
    body: `Parent for pulling "other debits" from SQL Accounting through the middleware into OMS.

## Sub-issues
- #89 Create pulling endpoint in middleware for other debits
- #93 Test the middleware endpoint
- #94 Create pulling endpoint for other debits in OMS
- #99 Test the OMS endpoint

## Acceptance criteria
- [ ] Other debits from SQL Accounting appear in OMS for a chosen date range
- [ ] Both endpoints tested`,
  },
  {
    title: 'Deploy APEX V1 to production',
    project: 'APEX V1', priority: 'Medium', s: '2026-12-07', t: '2026-12-07',
    body: `Production release for APEX V1, scheduled so the release isn't left unattended.

## What to do
- Run the APEX migrations (#98: tradeline facility and expenses tables)
- Deploy backend, middleware endpoints and frontend
- Smoke test with the accounts team

## Acceptance criteria
- [ ] Manual testing (#121) passed
- [ ] Production deploy done and smoke test passed
- [ ] Rollback plan known before deploying`,
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = [];
const fail = (what, e) => {
  failures.push(`${what}: ${e.message}`);
  console.log(`    FAILED: ${e.message}`);
};
const show = (v) => (v == null || v === '' ? '(empty)' : v);

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');

const P = await loadProject();

// 1. Existing issues
console.log('\n--- Existing issues ---');
for (const e of EDITS) {
  let issue;
  let current = {};
  try {
    issue = await getIssue(e.n);
    current = await readIssueFields(e.n);
  } catch (err) {
    fail(`#${e.n} read`, err);
    continue;
  }
  console.log(`\n#${e.n} ${issue.title}`);
  if (e.title && e.title !== issue.title) console.log(`  title:  "${issue.title}" -> "${e.title}"`);
  if (e.body && e.body.trim() !== (issue.body || '').trim()) console.log('  body:   replaced');
  if (e.state && e.state !== issue.state) console.log(`  state:  ${issue.state} -> ${e.state}`);
  if (e.boardStatus) console.log(`  board Status -> ${e.boardStatus}`);
  for (const [k, v] of Object.entries(e.fields || {})) {
    if (current[k] !== v) console.log(`  ${k}: ${show(current[k])} -> ${v}`);
  }
  if (!APPLY) continue;

  try {
    const patch = {};
    if (e.title && e.title !== issue.title) patch.title = e.title;
    if (e.body && e.body.trim() !== (issue.body || '').trim()) patch.body = e.body;
    if (e.state && e.state !== issue.state) patch.state = e.state;
    if (Object.keys(patch).length) await rest('PATCH', issuePath(e.n), patch);
  } catch (err) {
    fail(`#${e.n} title/body/state`, err);
  }
  for (const [k, v] of Object.entries(e.fields || {})) {
    if (current[k] === v) continue;
    try {
      await writeIssueField(e.n, k, v);
    } catch (err) {
      fail(`#${e.n} ${k}`, err);
    }
  }
  if (e.boardStatus) {
    try {
      const itemId = await ensureOnBoard(P, issue.node_id);
      await setBoardSelect(P, itemId, 'Status', e.boardStatus);
    } catch (err) {
      fail(`#${e.n} board Status`, err);
    }
  }
}

// 2. New issues
console.log('\n--- New issues ---');
const existing = await myIssuesByTitle();
const created = [];
for (const it of NEW) {
  const body = `${it.body}\n\n${hidden(it.s, it.t)}`;
  const found = existing.get(it.title);
  console.log(`\n${found ? `#${found.number} (already exists)` : 'NEW'}: ${it.title}`);
  console.log(`  ${it.project} | Module ${MODULE} | ${it.priority} | ${it.s} -> ${it.t}${it.parent ? ` | under #${it.parent}` : ''}${it.children ? ` | parent of ${it.children.map((c) => `#${c}`).join(', ')}` : ''}`);
  if (!APPLY) continue;

  let issue = found;
  try {
    if (!issue) {
      issue = await rest('POST', `/repos/${ORG}/${REPO}/issues`, { title: it.title, body, assignees: [ME] });
      console.log(`  created #${issue.number}`);
    }
  } catch (err) {
    fail(`create "${it.title}"`, err);
    continue;
  }
  created.push({ ...it, number: issue.number });

  try {
    const itemId = await ensureOnBoard(P, issue.node_id);
    await setBoardSelect(P, itemId, 'Project', it.project);
    await setBoardSelect(P, itemId, 'Module', MODULE);
    if (!found) await setBoardSelect(P, itemId, 'Status', 'Todo');
  } catch (err) {
    fail(`#${issue.number} board fields`, err);
  }
  for (const [k, v] of Object.entries({ Priority: it.priority, ...d(it.s, it.t) })) {
    try {
      await writeIssueField(issue.number, k, v);
    } catch (err) {
      fail(`#${issue.number} ${k}`, err);
    }
  }
  try {
    if (it.parent) await addSubIssue(it.parent, issue.number);
    for (const c of it.children || []) await addSubIssue(issue.number, c);
  } catch (err) {
    fail(`#${issue.number} sub-issue link`, err);
  }
}

// 3. Verify: read everything back
if (APPLY) {
  console.log('\n--- Verifying ---');
  const checks = [
    ...EDITS.filter((e) => e.fields).map((e) => ({ n: e.n, fields: e.fields, title: e.title })),
    ...created.map((c) => ({ n: c.number, fields: { Priority: c.priority, ...d(c.s, c.t) }, title: c.title })),
  ];
  let mismatches = 0;
  for (const c of checks) {
    try {
      const now = await readIssueFields(c.n);
      for (const [k, v] of Object.entries(c.fields)) {
        if (now[k] !== v) {
          mismatches++;
          console.log(`  #${c.n} ${k}: expected ${v}, GitHub has ${show(now[k])}`);
        }
      }
      if (c.title) {
        const issue = await getIssue(c.n);
        if (issue.title !== c.title) {
          mismatches++;
          console.log(`  #${c.n} title: expected "${c.title}", GitHub has "${issue.title}"`);
        }
      }
    } catch (err) {
      fail(`#${c.n} verify`, err);
    }
  }
  console.log(mismatches ? `\n${mismatches} value(s) did not stick (see above).` : '\nAll titles and fields verified.');
}

console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nNo failures.');
process.exit(failures.length ? 1 : 0);

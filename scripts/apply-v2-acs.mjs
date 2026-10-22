// scripts/apply-v2-acs.mjs
// Sales Recon V2 cycle: acceptance criteria updated after the 19 Oct review.
//   #297  queue design (AC-22 reworded) + AC-33..AC-38 for what PR #390 builds
//   #155  AC-39..AC-42 (filter reset, no duplicate rows) for the V2 lists
//   #292, #293  old technical checklists removed, new ACs listed
//
// Preview:  node scripts/apply-v2-acs.mjs
// Apply:    node scripts/apply-v2-acs.mjs --apply

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


const table = (rows) => ['| No. | Acceptance Criteria |', '|---|---|', ...rows.map(([n, t]) => `| ${n} | ${t} |`)].join('\n');

const AC297 = [
  ['AC-21', 'Accounts staff can generate the reconciliation for a 3-month date range without an error.'],
  ['AC-22', 'Accounts staff see the progress of a running generation.'],
  ['AC-23', 'The reconciliation summary updates by itself when generation finishes.'],
  ['AC-24', 'Accounts staff see an error message when generation fails.'],
  ['AC-33', 'Accounts staff see an estimated time before a generation starts.'],
  ['AC-34', 'Accounts staff see every generation that is running or queued, including those started by other staff.'],
  ['AC-35', 'Accounts staff can remove a queued generation they started.'],
  ['AC-36', 'Accounts staff cannot remove a generation that has already started or that another staff member started.'],
  ['AC-37', 'Accounts staff see when the reconciliation was last generated and who generated it.'],
  ['AC-38', 'Accounts staff can start a new generation while another is running; it waits in the queue and runs after the earlier one finishes.'],
];

const AC155 = [
  ['AC-25', 'On the Recon Dashboard, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
  ['AC-26', 'On the Recon Dashboard, rows already shown stay visible while more rows load.'],
  ['AC-27', 'On Manage Linked Dump, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
  ['AC-28', 'On Manage Linked Dump, rows already shown stay visible while more rows load.'],
  ['AC-29', 'On Incomplete Submission, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
  ['AC-30', 'On Incomplete Submission, rows already shown stay visible while more rows load.'],
  ['AC-31', 'On Shortage Status, scrolling to the end of the list loads more rows without jumping back to the top, in Safari (Mac and iPhone) and Chrome.'],
  ['AC-32', 'On Shortage Status, rows already shown stay visible while more rows load.'],
  ['AC-39', 'On the Recon Dashboard, changing a filter shows the list from the first rows again.'],
  ['AC-40', 'On the Recon Dashboard, each row appears only once after more rows load.'],
  ['AC-41', 'On Manage Linked Dump, changing a filter shows the list from the first rows again.'],
  ['AC-42', 'On Manage Linked Dump, each row appears only once after more rows load.'],
];
const pick = (ids) => AC155.filter(([n]) => ids.includes(n));

const SCROLL_NOTES = `### Cause of the bug
Load-more reuses the initial \`loading\` flag, so the rows can unmount while the next page loads (the "reload" flash). The \`requestAnimationFrame\` scrollTop restore then races React's render. Chrome hides this with scroll anchoring; Safari doesn't, so the list jumps back to the top.

### What to do
- Add a separate \`loadingMore\` flag and keep rows mounted while the next page loads
- Use the shared \`InfiniteScrollLoader\` (IntersectionObserver, \`root: .content\`)
- Delete the \`savedScrollTop\` / \`requestAnimationFrame\` restore and the \`.content\` scroll listener
- Ignore stale responses with a request id (filter change while a page is loading)`;

const BODIES = {
  297: `Generating the reconciliation for a large date range runs inside the web request and times out, so accounts staff get a 504 error in production. Generation moves to a background queue.

Status: backend in PR #390 (merges to main directly, agreed exception until the test branch exists). Frontend is this cycle's work (Tue 20 Oct).

## Acceptance Criteria
${table(AC297)}

## Implementation notes
### Must fix before release
- \`POST /accounts/reconciliation/generate\` still calls \`generateReconciliationSummary(dto)\` and waits. It must call \`accountService.queueReconciliationJob(dto, { id: req.user.id, email: req.user.email })\` and return \`202 { jobId, estimateMs }\`, otherwise the 504 is not fixed (AC-21).

### Backend (PR #390)
- Queue job \`account-manual-recon\` on the existing \`scheduled-accounts\` queue/worker in \`accountWorker.ts\`, with progress updates
- \`GET /reconciliation/estimate\`, \`GET /reconciliation/jobs\`, \`DELETE /reconciliation/jobs/:id\` (own queued jobs only: 403 for others, 409 once started)
- \`regenerateReconciliationSummary\` now runs in one transaction

### Frontend (this cycle)
- \`generateReconciliation\` in \`accountApi.ts\` returns \`{ jobId, estimateMs }\`
- Show the estimate before starting (AC-33), the jobs list with progress (AC-22, AC-34), a remove button on own queued jobs (AC-35, AC-36), and the last run (AC-37)
- Poll \`/reconciliation/jobs\` while any job is running or queued; refetch the summary when a job finishes (AC-23); show \`failedReason\` on failure (AC-24)
- Generate stays enabled; new requests join the queue (AC-38)

### Don't miss
- Two users generating the same range creates two jobs (no dedupe yet); acceptable with the visible queue, but note it
- The job runs without \`req.dbPool\` (as \`app_system\`, like the scheduled job): confirm its grants cover a manual date range and \`projectId\`
- Set \`removeOnComplete\` / \`removeOnFail\` so Redis doesn't grow
- Ships before #220 (the central axios client has a 30s timeout)
- #292 also edits \`useReconciliation.ts\`: merge this first, then rebase #292

<!-- Start: 2026-10-20 Target: 2026-10-20 -->`,

  155: `Paginated lists in Sales Recon jump back to the top while scrolling in Safari, and briefly flash a loading view in every browser while the next page loads.

## Acceptance Criteria
${table(AC155)}

The filter-reset and no-duplicate criteria for Incomplete Submission and Shortage Status are added at Sales Recon V3 planning.

## Delivered by
- #292 Recon Dashboard: AC-25, AC-26, AC-39, AC-40 (Sales Recon V2)
- #293 Manage Linked Dump: AC-27, AC-28, AC-41, AC-42 (Sales Recon V2)
- #294 Incomplete Submission: AC-29, AC-30 (Sales Recon V3)
- #295 Shortage Status: AC-31, AC-32 (Sales Recon V3)

## Implementation notes
On load-more, the hooks reuse the same \`loading\` flag as the first page load, so the list can unmount while the next page loads. The \`requestAnimationFrame\` scrollTop restore then races React's render. Chrome hides this with scroll anchoring; Safari doesn't.`,

  292: `Part of #155. Delivers AC-25, AC-26, AC-39, AC-40.

## Acceptance Criteria
${table(pick(['AC-25', 'AC-26', 'AC-39', 'AC-40']))}

## Implementation notes
Replace the scroll listener on the Recon Dashboard with the \`InfiniteScrollLoader\` sentinel pattern.

${SCROLL_NOTES}
- Move \`features/tasks/components/InfiniteScrollLoader.tsx\` to a shared \`components/\` folder and use it from both tasks and accounts (PR #288 added a second \`.jsx\` copy; don't keep it)

### Before you start
- PR #288's branch \`feat/infinite-scroll\` is based on an old main. Don't reopen it as-is: start a fresh branch from main **after #297's frontend is merged** (both edit \`useReconciliation.ts\`) and reuse #288's changes

Files: \`frontend-web/src/features/accounts/hooks/useReconciliation.ts\`, \`components/SummaryTable.jsx\`

<!-- Start: 2026-10-21 Target: 2026-10-21 -->`,

  293: `Part of #155. Delivers AC-27, AC-28, AC-41, AC-42.

## Acceptance Criteria
${table(pick(['AC-27', 'AC-28', 'AC-41', 'AC-42']))}

## Implementation notes
Replace the scroll listener on Manage Linked Dump with the shared \`InfiniteScrollLoader\` (see #292).

${SCROLL_NOTES}

File: \`frontend-web/src/features/accounts/hooks/useLinkedDumpList.ts\`

<!-- Start: 2026-10-21 Target: 2026-10-21 -->`,
};

const MUST_CONTAIN = { 297: 'AC-38', 155: 'AC-42', 292: 'AC-40', 293: 'AC-42' };

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');
let failures = 0;
for (const [n, body] of Object.entries(BODIES)) {
  const issue = await getIssue(n);
  const same = (issue.body || '').trim() === body.trim();
  const acs = [...body.matchAll(/\| (AC-\d+) \|/g)].map((m) => m[1]);
  console.log(`\n#${n} ${issue.title}\n  ${same ? 'already up to date' : 'body replaced'} | ACs: ${acs.join(', ')}`);
  if (!APPLY || same) continue;
  try {
    await rest('PATCH', issuePath(n), { body });
    const after = await getIssue(n);
    if (!(after.body || '').includes(MUST_CONTAIN[n])) throw new Error('body did not save');
    console.log('  verified');
  } catch (e) {
    failures++;
    console.log(`  FAILED: ${e.message}`);
  }
}
console.log(failures ? `\n${failures} failure(s).` : '\nNo failures.');
process.exit(failures ? 1 : 0);

// scripts/apply-replan-oct14.mjs
// One-off (14 Oct): #297 first, then pagination (#155), #298 + #303 paused until after
// pagination, Low items + #220 moved to a post-APEX follow-up release (Sales Recon V4).
//
// Preview (changes nothing):   node scripts/apply-replan-oct14.mjs
// Write to GitHub:             node scripts/apply-replan-oct14.mjs --apply
//
// Token: put GH_TOKEN in the repo's .env file (see .env.example), or set it in the shell.
// Needs GH_TOKEN with: repo (issues) + project (org Projects) scopes. Safe to re-run.

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
// The plan
// ---------------------------------------------------------------------------
const d = (s, t = s) => ({ 'Start date': s, 'Target date': t });
const show = (v) => (v == null || v === '' ? '(empty)' : v);

// project: board "Project" field. boardStatus: board "Status" field.
const EDITS = [
  // 1. #297 first (Urgent, live 504)
  { n: 297, fields: d('2026-10-14', '2026-10-16'), boardStatus: 'In Progress' },

  // 2. Pagination (#155 follows its sub-issues)
  { n: 292, fields: d('2026-10-16'), boardStatus: 'Todo' },
  { n: 293, fields: d('2026-10-17'), boardStatus: 'Todo' },
  { n: 294, fields: d('2026-10-19') },
  { n: 315, fields: d('2026-10-19') },
  { n: 295, fields: d('2026-10-20') },

  // 3. #298 + #303 together, paused until pagination is done
  { n: 298, fields: d('2026-10-20', '2026-10-21') },
  { n: 303, fields: d('2026-10-20', '2026-10-21'), boardStatus: 'Todo' },

  // 4. Rest of V2, then deploy
  { n: 90, fields: d('2026-10-21') },
  { n: 213, fields: d('2026-10-22') },
  { n: 91, fields: d('2026-10-23') },
  { n: 356, fields: d('2026-10-23') },

  // 5. Moved out of V2 into a follow-up release after APEX (Sales Recon V4)
  { n: 220, project: 'Sales Recon V4', fields: d('2026-12-08') },
  { n: 156, project: 'Sales Recon V4', fields: d('2026-12-09') },
  { n: 317, project: 'Sales Recon V4', fields: d('2026-12-10') },
  { n: 92, project: 'Sales Recon V4', fields: d('2026-12-10') },
  { n: 208, project: 'Sales Recon V4', fields: d('2026-12-11') },

  // 6. V3 starts one day later; prototype trimmed so the rest of V3 and APEX keep their dates
  { n: 283, fields: d('2026-10-24', '2026-10-26') },
];

// Keep the hidden date line in the body in step with the fields, if the issue has one
const HIDDEN = /<!--\s*Start:\s*\d{4}-\d{2}-\d{2}\s+Target:\s*\d{4}-\d{2}-\d{2}\s*-->/i;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const failures = [];
const fail = (what, e) => {
  failures.push(`${what}: ${e.message}`);
  console.log(`    FAILED: ${e.message}`);
};

console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN: nothing will be changed. Re-run with --apply to write. ===');
const P = await loadProject();

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
  for (const [k, v] of Object.entries(e.fields)) {
    if (current[k] !== v) console.log(`  ${k}: ${show(current[k])} -> ${v}`);
  }
  if (e.project) console.log(`  board Project -> ${e.project}`);
  if (e.boardStatus) console.log(`  board Status -> ${e.boardStatus}`);
  const body = issue.body || '';
  const newHidden = `<!-- Start: ${e.fields['Start date']} Target: ${e.fields['Target date']} -->`;
  const bodyNeedsUpdate = HIDDEN.test(body) && !body.includes(newHidden);
  if (bodyNeedsUpdate) console.log('  hidden date line in body updated');
  if (!APPLY) continue;

  for (const [k, v] of Object.entries(e.fields)) {
    if (current[k] === v) continue;
    try {
      await writeIssueField(e.n, k, v);
    } catch (err) {
      fail(`#${e.n} ${k}`, err);
    }
  }
  if (bodyNeedsUpdate) {
    try {
      await rest('PATCH', issuePath(e.n), { body: body.replace(HIDDEN, newHidden) });
    } catch (err) {
      fail(`#${e.n} body`, err);
    }
  }
  if (e.project || e.boardStatus) {
    try {
      const itemId = await ensureOnBoard(P, issue.node_id);
      if (e.project) await setBoardSelect(P, itemId, 'Project', e.project);
      if (e.boardStatus) await setBoardSelect(P, itemId, 'Status', e.boardStatus);
    } catch (err) {
      fail(`#${e.n} board fields`, err);
    }
  }
}

if (APPLY) {
  console.log('\n--- Verifying ---');
  let mismatches = 0;
  for (const e of EDITS) {
    try {
      const now = await readIssueFields(e.n);
      for (const [k, v] of Object.entries(e.fields)) {
        if (now[k] !== v) {
          mismatches++;
          console.log(`  #${e.n} ${k}: expected ${v}, GitHub has ${show(now[k])}`);
        }
      }
    } catch (err) {
      fail(`#${e.n} verify`, err);
    }
  }
  console.log(mismatches ? `\n${mismatches} value(s) did not stick (see above).` : '\nAll dates verified.');
}

console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nNo failures.');
process.exit(failures.length ? 1 : 0);

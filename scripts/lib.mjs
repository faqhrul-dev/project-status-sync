// ---------- Config: edit here if names change ----------
export const ORG = 'onlineoms';
export const ME = 'faqhrul-dev';
export const PROJECT_NUMBER = 2;

export const F = {
  status: 'Status',
  stage: 'Stage',
  module: 'Module',
  project: 'Project',
  projectDue: 'Project Due',
  start: 'Start date',
  target: 'Target date',
  priority: 'Priority',
};
export const S = { todo: 'Todo', prog: 'In Progress', done: 'Done' };
export const DEFAULT_MODULE = 'Accounts';
export const STAGES = ['Plan', 'Code', 'Build', 'Test', 'Release', 'Deploy', 'Operate', 'Monitor'];
// --------------------------------------------------------

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error('GH_TOKEN is missing');

export async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'GraphQL-Features': 'sub_issues',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg = (json.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(msg.slice(0, 300));
  }
  return json.data;
}

// ---------- Dates (Malaysia time, UTC+8) ----------
export function mytDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
}
export const isWorkday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0; // Sunday off
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function shiftWorkdays(iso, n) {
  let d = iso;
  for (let left = n; left > 0; ) {
    d = addDays(d, 1);
    if (isWorkday(d)) left--;
  }
  return d;
}
export const nextWorkdayAfter = (iso) => shiftWorkdays(iso, 1);
export const nextWorkDay = () => nextWorkdayAfter(mytDate());
export function countWorkdays(from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkday(d)) n++;
  return n;
}
export function prettyDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------- Item helpers ----------
export const val = (item, field) => item.values[field]?.value ?? null;
export const isMine = (item) => item.author === ME || item.assignees.includes(ME);
export const label = (item) => `${item.repo}#${item.number}`;

const FIELD_VALUES = `
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldDateValue { date updatedAt field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldTextValue { text updatedAt field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number updatedAt field { ... on ProjectV2FieldCommon { name } } }
    }
  }`;

const CONTENT = `
  content {
    __typename
    ... on Issue {
      id number title body state closedAt
      repository { name }
      author { login }
      assignees(first: 10) { nodes { login } }
      parent { id }
      subIssues(first: 50) { nodes { id state } }
      timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } }
    }
    ... on PullRequest {
      id number title state closedAt createdAt
      repository { name }
      author { login }
      assignees(first: 10) { nodes { login } }
      closingIssuesReferences(first: 10) { nodes { id } }
    }
  }`;

function normalize(n) {
  const values = {};
  for (const v of n.fieldValues.nodes) {
    const name = v?.field?.name;
    if (!name) continue;
    values[name] = { value: v.name ?? v.date ?? v.text ?? v.number ?? null, updatedAt: v.updatedAt };
  }
  const c = n.content || {};
  return {
    itemId: n.id,
    type: c.__typename,
    contentId: c.id,
    number: c.number,
    title: c.title,
    state: c.state,
    body: c.body || '',
    parentId: c.parent?.id || null,
    closedAt: c.closedAt || null,
    repo: c.repository?.name,
    author: c.author?.login,
    assignees: (c.assignees?.nodes || []).map((a) => a.login),
    subIssues: c.subIssues?.nodes || [],
    reopenedAt: c.timelineItems?.nodes?.[0]?.createdAt || null,
    linkedIssueIds: (c.closingIssuesReferences?.nodes || []).map((i) => i.id),
    values,
  };
}

export async function loadProject() {
  const meta = await gql(
    `query($org: String!, $n: Int!) {
      organization(login: $org) {
        projectV2(number: $n) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
              ... on ProjectV2IterationField { id name dataType }
            }
          }
        }
      }
    }`,
    { org: ORG, n: PROJECT_NUMBER },
  );
  const project = meta.organization.projectV2;
  const fields = {};
  for (const f of project.fields.nodes) if (f?.name) fields[f.name] = f;

  const items = [];
  let after = null;
  do {
    const d = await gql(
      `query($id: ID!, $after: String) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id ${FIELD_VALUES} ${CONTENT} }
            }
          }
        }
      }`,
      { id: project.id, after },
    );
    const page = d.node.items;
    for (const n of page.nodes) items.push(normalize(n));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const kept = items.filter((i) => i.type === 'Issue' || i.type === 'PullRequest');

  // Read org issue fields (Start date, Target date...) straight from my recent issues
  const issueFields = await loadIssueFields();
  if (Object.keys(issueFields).length) {
    const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();
    const targets = kept.filter(
      (i) => i.type === 'Issue' && isMine(i) && (i.state === 'OPEN' || (i.closedAt || '') >= monthAgo),
    );
    let failed = 0;
    await pool(targets, 6, async (it) => {
      try {
        await readIssueFieldValues(it, issueFields);
      } catch {
        it.issueFieldsUnknown = true; // never write issue fields we could not read
        failed++;
      }
    });
    if (failed) console.log(`Could not read issue fields on ${failed} issue(s); they will not be changed`);
  }

  return { projectId: project.id, fields, items: kept };
}

// ---------- Dates hidden in the issue description ----------
// e.g. <!-- Start: 2026-10-09 Target: 2026-10-10 -->
export function bodyDates(body = '') {
  return {
    start: body.match(/Start:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null,
    target: body.match(/Target:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null,
  };
}

// ---------- State, kept in a repo variable (SYNC_STATE) ----------
const REPO = process.env.GITHUB_REPOSITORY;
const STATE_VAR = 'SYNC_STATE';
const restHeaders = {
  Authorization: `bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};
export async function loadState() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/variables/${STATE_VAR}`, { headers: restHeaders });
  if (res.status === 404) return { exists: false, data: {} };
  if (!res.ok) throw new Error(`Could not read state: HTTP ${res.status}`);
  const j = await res.json();
  return { exists: true, data: JSON.parse(j.value || '{}') };
}
export async function saveState(state) {
  const url = state.exists
    ? `https://api.github.com/repos/${REPO}/actions/variables/${STATE_VAR}`
    : `https://api.github.com/repos/${REPO}/actions/variables`;
  const res = await fetch(url, {
    method: state.exists ? 'PATCH' : 'POST',
    headers: restHeaders,
    body: JSON.stringify({ name: STATE_VAR, value: JSON.stringify(state.data) }),
  });
  if (!res.ok) throw new Error(`Could not save state: HTTP ${res.status}`);
  state.exists = true;
}

// ---------- WhatsApp (CallMeBot) ----------
export async function sendWhatsApp(text) {
  const { WA_PHONE, WA_APIKEY } = process.env;
  if (!WA_PHONE || !WA_APIKEY) return console.log('WhatsApp not configured, skipped');
  const url =
    'https://api.callmebot.com/whatsapp.php' +
    `?phone=${encodeURIComponent(WA_PHONE)}` +
    `&text=${encodeURIComponent(text)}` +
    `&apikey=${encodeURIComponent(WA_APIKEY)}`;
  const res = await fetch(url);
  console.log(`WhatsApp sent: HTTP ${res.status}`); // never log the message itself
  return res.ok;
}

// ---------- Org "issue fields" (e.g. Start date, Target date) ----------
// These live on the issue itself, not the board, so they are read and written with the REST API.
let issueFieldsCache;
export async function loadIssueFields() {
  if (issueFieldsCache) return issueFieldsCache;
  const res = await fetch(`https://api.github.com/orgs/${ORG}/issue-fields`, { headers: restHeaders });
  if (!res.ok) {
    console.log(`Issue fields not available (HTTP ${res.status})`);
    return (issueFieldsCache = {});
  }
  const list = await res.json();
  issueFieldsCache = Object.fromEntries(list.map((f) => [f.name.toLowerCase(), { id: f.id, name: f.name }]));
  return issueFieldsCache;
}
export async function setIssueFieldValue(repo, number, fieldId, value) {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${repo}/issues/${number}/issue-field-values`, {
    method: 'POST',
    headers: restHeaders,
    body: JSON.stringify({ issue_field_values: [{ field_id: fieldId, value: String(value) }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// Our names for fields (from F), so "Start Date" on GitHub still maps to F.start
const canonical = (name) => Object.values(F).find((n) => n.toLowerCase() === name.toLowerCase()) || name;

let warnedShape = false;
function parseIssueFieldValue(o, byId) {
  const id = o.issue_field_id ?? o.field_id ?? o.issue_field?.id ?? o.field?.id;
  const name = byId[id]?.name ?? o.issue_field?.name ?? o.field?.name ?? o.name;
  let v = o.value;
  if (v && typeof v === 'object') v = v.name ?? v.value ?? null;
  v ??= o.single_select_option?.name ?? o.date_value ?? o.text_value ?? o.number_value ?? null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) v = v.slice(0, 10);
  if (!name && !warnedShape) {
    warnedShape = true;
    console.log(`Unrecognised issue field value shape, keys: ${Object.keys(o).join(', ')}`);
  }
  return name ? { name: canonical(name), value: v, updatedAt: o.updated_at || o.updatedAt || '' } : null;
}

async function readIssueFieldValues(item, fields) {
  const byId = Object.fromEntries(Object.values(fields).map((f) => [f.id, f]));
  const res = await fetch(
    `https://api.github.com/repos/${ORG}/${item.repo}/issues/${item.number}/issue-field-values?per_page=100`,
    { headers: restHeaders },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j) ? j : j.issue_field_values || [];
  // Issue fields are the source of truth: clear whatever the board said, then fill from the issue
  for (const f of Object.values(fields)) delete item.values[canonical(f.name)];
  for (const o of list) {
    const p = parseIssueFieldValue(o, byId);
    if (p && p.value != null) item.values[p.name] = { value: p.value, updatedAt: p.updatedAt };
  }
}

async function pool(list, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

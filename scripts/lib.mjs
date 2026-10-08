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
export function nextWorkDay() {
  let d = 1;
  while (new Date(`${mytDate(d)}T00:00:00Z`).getUTCDay() === 0) d++; // skip Sunday
  return mytDate(d);
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
      id number title state closedAt
      repository { name }
      author { login }
      assignees(first: 10) { nodes { login } }
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

  return {
    projectId: project.id,
    fields,
    items: items.filter((i) => i.type === 'Issue' || i.type === 'PullRequest'),
  };
}

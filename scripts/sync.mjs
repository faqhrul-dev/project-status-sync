import { ORG, ME, F, S, DEFAULT_MODULE, STAGES, gql, mytDate, val, isMine, label, loadProject } from './lib.mjs';

const DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY = process.env.DRY_RUN === 'true';
const SINCE_DATE = mytDate(-DAYS);
const SINCE_ISO = new Date(Date.now() - DAYS * 86400e3).toISOString();
const TODAY = mytDate();

let P;
let changes = 0;
if (DRY) console.log('DRY RUN: nothing will be changed');

// ---------- Write helpers ----------
async function setField(item, fieldName, raw) {
  const f = P.fields[fieldName];
  if (!f) return console.log(`Field "${fieldName}" not found on board`), false;
  if (val(item, fieldName) === raw) return false;

  let value;
  if (f.dataType === 'SINGLE_SELECT') {
    const opt = f.options.find((o) => o.name === raw);
    if (!opt) return console.log(`Option "${raw}" not found in "${fieldName}"`), false;
    value = { singleSelectOptionId: opt.id };
  } else if (f.dataType === 'DATE') value = { date: raw };
  else if (f.dataType === 'NUMBER') value = { number: Number(raw) };
  else value = { text: String(raw) };

  const shown = f.dataType === 'TEXT' ? '(text)' : raw;
  if (!DRY) {
    try {
      await gql(
        `mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: $v }) { projectV2Item { id } }
        }`,
        { p: P.projectId, i: item.itemId, f: f.id, v: value },
      );
    } catch {
      console.log(`${label(item)}: ${fieldName} skipped (GitHub refused)`);
      return false;
    }
  }
  item.values[fieldName] = { value: raw, updatedAt: new Date().toISOString() };
  console.log(`${label(item)}: ${fieldName} -> ${shown}`);
  changes++;
  return true;
}

// ---------- 1. Make sure my recent issues/PRs are on the board ----------
async function ensureOnBoard() {
  let added = 0;
  for (const who of ['assignee', 'author']) {
    const d = await gql(
      `query($q: String!) {
        search(query: $q, type: ISSUE, first: 100) {
          nodes {
            ... on Issue { id number repository { name } projectItems(first: 20) { nodes { project { id } } } }
            ... on PullRequest { id number repository { name } projectItems(first: 20) { nodes { project { id } } } }
          }
        }
      }`,
      { q: `org:${ORG} ${who}:${ME} updated:>=${SINCE_DATE}` },
    );
    for (const n of d.search.nodes) {
      if (!n?.id) continue;
      if (n.projectItems.nodes.some((p) => p.project.id === P.projectId)) continue;
      console.log(`${n.repository.name}#${n.number}: added to board`);
      if (!DRY) {
        await gql(
          `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
          { p: P.projectId, c: n.id },
        );
      }
      added++;
    }
  }
  return added;
}

// ---------- Main ----------
P = await loadProject();
if ((await ensureOnBoard()) > 0 && !DRY) P = await loadProject();

const byContent = new Map(P.items.map((i) => [i.contentId, i]));
const isActive = (i) => i.state === 'OPEN' || (i.closedAt && i.closedAt >= SINCE_ISO);
const mine = P.items.filter((i) => isMine(i) && isActive(i));
const myPRs = mine.filter((i) => i.type === 'PullRequest');
const myIssues = mine.filter((i) => i.type === 'Issue');
const linkedIssues = (pr) => pr.linkedIssueIds.map((id) => byContent.get(id)).filter((i) => i && isMine(i));

// 2. Assign me to my open PRs
const meId = (await gql(`query($l: String!) { user(login: $l) { id } }`, { l: ME })).user.id;
for (const pr of myPRs) {
  if (pr.state !== 'OPEN' || pr.author !== ME || pr.assignees.includes(ME)) continue;
  console.log(`${label(pr)}: assigned to me`);
  if (!DRY) {
    await gql(
      `mutation($a: ID!, $u: [ID!]!) { addAssigneesToAssignable(input: { assignableId: $a, assigneeIds: $u }) { clientMutationId } }`,
      { a: pr.contentId, u: [meId] },
    );
  }
  pr.assignees.push(ME);
  changes++;
}

// 3. PR copies empty fields from its linked issue (no dates, GitHub blocks them on PRs)
for (const pr of myPRs) {
  const issue = linkedIssues(pr)[0];
  if (!issue) continue;
  for (const field of [F.module, F.project, F.projectDue, F.priority]) {
    if (!val(pr, field) && val(issue, field)) await setField(pr, field, val(issue, field));
  }
}

// 4. Default Module
for (const it of mine) if (!val(it, F.module)) await setField(it, F.module, DEFAULT_MODULE);

// 5. Project Due from other items in the same Project (most common date)
const dueByProject = {};
for (const it of P.items) {
  const proj = val(it, F.project);
  const due = val(it, F.projectDue);
  if (!proj || !due) continue;
  dueByProject[proj] ??= {};
  dueByProject[proj][due] = (dueByProject[proj][due] || 0) + 1;
}
for (const it of mine) {
  const proj = val(it, F.project);
  if (!proj || val(it, F.projectDue) || !dueByProject[proj]) continue;
  const best = Object.entries(dueByProject[proj]).sort((a, b) => b[1] - a[1])[0][0];
  await setField(it, F.projectDue, best);
}

// 6. Status: issues and PRs themselves
for (const it of mine) {
  const st = val(it, F.status);
  let target = null;
  if (it.type === 'Issue') {
    const statusEdit = it.values[F.status]?.updatedAt || '';
    if (it.state === 'CLOSED') target = st !== S.done ? S.done : null;
    else if (st === S.done && it.reopenedAt && it.reopenedAt > statusEdit) target = S.prog;
    else if (!st) target = S.todo;
  } else {
    if (it.state === 'MERGED') target = st !== S.done ? S.done : null;
    else if (it.state === 'OPEN' && (!st || st === S.todo)) target = S.prog;
  }
  if (target) await setField(it, F.status, target);
}

// 7. Issue follows its PR
for (const pr of myPRs) {
  for (const issue of linkedIssues(pr)) {
    const st = val(issue, F.status);
    if (pr.state === 'OPEN' && issue.state === 'OPEN' && (!st || st === S.todo)) await setField(issue, F.status, S.prog);
    if (pr.state === 'MERGED' && st !== S.done) await setField(issue, F.status, S.done);
  }
}

// 8. Parent follows sub-issues
for (const parent of myIssues) {
  if (!parent.subIssues.length) continue;
  const st = val(parent, F.status);
  const allClosed = parent.subIssues.every((s) => s.state === 'CLOSED');
  const anyInProgress = parent.subIssues.some((s) => {
    const child = byContent.get(s.id);
    return s.state === 'OPEN' && child && val(child, F.status) === S.prog;
  });
  if (allClosed && st !== S.done) await setField(parent, F.status, S.done);
  else if (!allClosed && parent.state === 'OPEN' && anyInProgress && st !== S.prog) await setField(parent, F.status, S.prog);
}

// 9. Sub-issue dates, both directions (newer edit wins)
async function syncDate(parent, children, field, mode) {
  const later = (a, b) => (mode === 'max' ? a > b : a < b);
  const pVal = val(parent, field);
  const dated = children.filter((c) => val(c, field));

  if (!dated.length) {
    // Parent has a date, no child does: give it to the last/first sub-issue
    const edge = mode === 'max' ? children.at(-1) : children[0];
    if (pVal && edge && isMine(edge)) await setField(edge, field, pVal);
    return;
  }
  let edge = dated[0];
  for (const c of dated) if (later(val(c, field), val(edge, field))) edge = c;
  const rolled = val(edge, field);

  if (!pVal) return void (await setField(parent, field, rolled));
  if (pVal === rolled) return;

  const parentEdit = parent.values[field].updatedAt || '';
  const childEdit = dated.map((c) => c.values[field].updatedAt || '').sort().at(-1);
  if (parentEdit > childEdit) {
    if (isMine(edge)) await setField(edge, field, pVal);
  } else {
    await setField(parent, field, rolled);
  }
}
for (const parent of myIssues) {
  const children = parent.subIssues.map((s) => byContent.get(s.id)).filter(Boolean);
  if (!children.length) continue;
  await syncDate(parent, children, F.target, 'max');
  await syncDate(parent, children, F.start, 'min');
}

// 10. Start date when work begins (issues only)
for (const it of myIssues) {
  if (val(it, F.status) === S.prog && !val(it, F.start)) await setField(it, F.start, TODAY);
}

// 11. Stage, forward only
const stageTarget = new Map();
const bump = (item, stage) => {
  const cur = stageTarget.get(item);
  if (!cur || STAGES.indexOf(stage) > STAGES.indexOf(cur)) stageTarget.set(item, stage);
};
for (const it of mine) {
  const st = val(it, F.status);
  if (it.type === 'PullRequest') {
    if (it.state === 'MERGED') {
      bump(it, 'Deploy');
      for (const issue of linkedIssues(it)) bump(issue, 'Deploy');
    } else if (it.state === 'OPEN') {
      bump(it, 'Code');
      for (const issue of linkedIssues(it)) bump(issue, 'Code');
    }
  } else if (st === S.prog) bump(it, 'Code');
  else if (st === S.todo) bump(it, 'Plan');
}
for (const [item, stage] of stageTarget) {
  const cur = val(item, F.stage);
  if (STAGES.indexOf(stage) > (cur ? STAGES.indexOf(cur) : -1)) await setField(item, F.stage, stage);
}

console.log(`Done. ${changes} change(s)${DRY ? ' (dry run)' : ''}.`);

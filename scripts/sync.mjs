import {
  ORG, ME, F, S, DEFAULT_MODULE, STAGES,
  gql, mytDate, prettyDate, isWorkday, addDays, shiftWorkdays, nextWorkdayAfter, countWorkdays,
  val, isMine, label, loadProject, bodyDates, loadState, saveState, sendWhatsApp,
  loadIssueFields, setIssueFieldValue,
} from './lib.mjs';

const DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const DRY = process.env.DRY_RUN === 'true';
const SINCE_DATE = mytDate(-DAYS);
const SINCE_ISO = new Date(Date.now() - DAYS * 86400e3).toISOString();
const TODAY = mytDate();
const URGENT = ['Urgent', 'High'];

let P;
let changes = 0;
const notices = [];
if (DRY) console.log('DRY RUN: nothing will be changed');

// ---------- State ----------
const state = await loadState();
const st8 = state.data;
const stateBefore = JSON.stringify(st8);
st8.goLive ??= new Date().toISOString(); // urgent rule ignores priorities set before this
st8.urgent ??= {}; // urgentContentId -> { number, at, paused: [contentId], resumed }
st8.slipped ??= {}; // contentId -> original Target date
st8.overdueRun ??= '';
st8.overnight ??= { date: '', moves: [] };

// ---------- Write helpers ----------
const ISSUE_FIELDS = await loadIssueFields(); // org-level fields such as Start date / Target date

async function setField(item, fieldName, raw) {
  if (raw == null || val(item, fieldName) === raw) return false;
  const issueField = ISSUE_FIELDS[fieldName.toLowerCase()];
  if (issueField && item.type !== 'Issue') return false; // issue fields don't exist on PRs

  let f;
  let value;
  if (!issueField) {
    f = P.fields[fieldName];
    if (!f) return console.log(`Field "${fieldName}" not found on board`), false;
    if (f.dataType === 'SINGLE_SELECT') {
      const opt = f.options.find((o) => o.name === raw);
      if (!opt) return console.log(`Option "${raw}" not found in "${fieldName}"`), false;
      value = { singleSelectOptionId: opt.id };
    } else if (f.dataType === 'DATE') value = { date: raw };
    else if (f.dataType === 'NUMBER') value = { number: Number(raw) };
    else value = { text: String(raw) };
  }

  if (!DRY) {
    try {
      if (issueField) {
        await setIssueFieldValue(item.repo, item.number, issueField.id, raw);
      } else {
        await gql(
          `mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) {
            updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: $v }) { projectV2Item { id } }
          }`,
          { p: P.projectId, i: item.itemId, f: f.id, v: value },
        );
      }
    } catch (e) {
      console.log(`${label(item)}: ${fieldName} skipped (${e.message})`);
      return false;
    }
  }
  item.values[fieldName] = { value: raw, updatedAt: new Date().toISOString() };
  console.log(`${label(item)}: ${fieldName} -> ${f?.dataType === 'TEXT' ? '(text)' : raw}`);
  changes++;
  return true;
}

async function closeIssue(item) {
  console.log(`${label(item)}: closed (Status is Done)`);
  if (!DRY) {
    await gql(
      `mutation($id: ID!) { closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { clientMutationId } }`,
      { id: item.contentId },
    );
  }
  item.state = 'CLOSED';
  changes++;
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
      if (!n?.id || n.projectItems.nodes.some((p) => p.project.id === P.projectId)) continue;
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

P = await loadProject();
if ((await ensureOnBoard()) > 0 && !DRY) P = await loadProject();

const byContent = new Map(P.items.map((i) => [i.contentId, i]));
const isActive = (i) => i.state === 'OPEN' || (i.closedAt && i.closedAt >= SINCE_ISO);
const mine = P.items.filter((i) => isMine(i) && isActive(i));
const myPRs = mine.filter((i) => i.type === 'PullRequest');
const myIssues = mine.filter((i) => i.type === 'Issue');
const linkedIssues = (pr) => pr.linkedIssueIds.map((id) => byContent.get(id)).filter((i) => i && isMine(i));
// Open issues of mine that are not parents (parents follow their sub-issues instead)
const plain = (i) => i.type === 'Issue' && i.state === 'OPEN' && isMine(i) && !i.subIssues.length;

// ---------- 2. Assign me: my open PRs, and issues I created with NO assignee ----------
const meId = (await gql(`query($l: String!) { user(login: $l) { id } }`, { l: ME })).user.id;
for (const it of mine) {
  if (it.state !== 'OPEN' || it.author !== ME) continue;
  if (it.type === 'PullRequest' && it.assignees.includes(ME)) continue;
  if (it.type === 'Issue' && it.assignees.length > 0) continue; // someone already assigned: leave it
  console.log(`${label(it)}: assigned to me`);
  if (!DRY) {
    await gql(
      `mutation($a: ID!, $u: [ID!]!) { addAssigneesToAssignable(input: { assignableId: $a, assigneeIds: $u }) { clientMutationId } }`,
      { a: it.contentId, u: [meId] },
    );
  }
  it.assignees.push(ME);
  changes++;
}

// ---------- 3. Dates hidden in the description fill empty fields ----------
for (const it of myIssues) {
  const d = bodyDates(it.body);
  if (d.start && !val(it, F.start)) await setField(it, F.start, d.start);
  if (d.target && !val(it, F.target)) await setField(it, F.target, d.target);
}

// ---------- 4. PR copies empty fields from its linked issue (no dates, GitHub blocks them on PRs) ----------
for (const pr of myPRs) {
  const issue = linkedIssues(pr)[0];
  if (!issue) continue;
  for (const field of [F.module, F.project, F.projectDue, F.priority]) {
    if (!val(pr, field) && val(issue, field)) await setField(pr, field, val(issue, field));
  }
}

// ---------- 5. Default Module ----------
for (const it of mine) if (!val(it, F.module)) await setField(it, F.module, DEFAULT_MODULE);

// ---------- 6. Status of issues and PRs themselves ----------
for (const it of mine) {
  const st = val(it, F.status);
  let target = null;
  if (it.type === 'Issue') {
    const statusEdit = it.values[F.status]?.updatedAt || '';
    if (it.state === 'CLOSED') target = st !== S.done ? S.done : null;
    else if (st === S.done && it.reopenedAt && it.reopenedAt > statusEdit) target = S.prog; // reopened
    else if (!st) target = S.todo;
  } else {
    if (it.state === 'MERGED') target = st !== S.done ? S.done : null;
    else if (it.state === 'OPEN' && (!st || st === S.todo)) target = S.prog;
  }
  if (target) await setField(it, F.status, target);
}

// ---------- 7. Resume work paused by an urgent issue, once that issue is finished ----------
for (const [uid, u] of Object.entries(st8.urgent)) {
  if (u.resumed) continue;
  const urg = byContent.get(uid);
  if (urg && urg.state === 'OPEN' && val(urg, F.status) !== S.done) continue;
  const resumed = [];
  for (const id of u.paused) {
    const it = byContent.get(id);
    if (it && it.state === 'OPEN' && val(it, F.status) === S.todo) {
      await setField(it, F.status, S.prog);
      resumed.push(`#${it.number}`);
    }
  }
  u.resumed = true;
  if (resumed.length) notices.push(`*#${u.number} finished.* Back to In Progress: ${resumed.join(', ')}`);
}
const paused = new Set(Object.values(st8.urgent).filter((u) => !u.resumed).flatMap((u) => u.paused));

// ---------- 8. Urgent/High issue: move other work in the same project ----------
for (const u of myIssues) {
  if (u.state !== 'OPEN' || !URGENT.includes(val(u, F.priority)) || st8.urgent[u.contentId]) continue;
  if ((u.values[F.priority]?.updatedAt || '') <= st8.goLive) continue; // set before this feature existed
  const start = val(u, F.start);
  const end = val(u, F.target);
  const proj = val(u, F.project);
  if (!start || !end || !proj) continue; // wait until dates and Project are filled

  const n = Math.max(1, countWorkdays(start, end));
  const related = new Set([u.parentId, ...u.subIssues.map((s) => s.id)]);
  const lines = [];
  const pausedNow = [];

  for (const it of P.items) {
    if (it === u || !plain(it) || val(it, F.project) !== proj || related.has(it.contentId)) continue;
    const st = val(it, F.status);
    const s = val(it, F.start);
    const t = val(it, F.target);
    if (st === S.prog) {
      // Pause: back to Todo, restart after the urgent issue, same length as before
      const len = s && t ? Math.max(1, countWorkdays(s, t)) : 1;
      const ns = nextWorkdayAfter(end);
      const nt = shiftWorkdays(ns, len - 1);
      await setField(it, F.status, S.todo);
      await setField(it, F.start, ns);
      await setField(it, F.target, nt);
      pausedNow.push(it.contentId);
      lines.push(`- #${it.number} paused, now ${prettyDate(ns)} to ${prettyDate(nt)}`);
    } else if (st === S.todo && t && t >= start) {
      const ns = s ? shiftWorkdays(s, n) : null;
      const nt = shiftWorkdays(t, n);
      if (ns) await setField(it, F.start, ns);
      await setField(it, F.target, nt);
      lines.push(`- #${it.number} now ${ns ? `${prettyDate(ns)} to ` : 'due '}${prettyDate(nt)}`);
    }
  }
  st8.urgent[u.contentId] = { number: u.number, at: new Date().toISOString(), paused: pausedNow, resumed: false };
  pausedNow.forEach((id) => paused.add(id));
  notices.push(
    `*#${u.number} is ${val(u, F.priority)}* (${n} working day${n > 1 ? 's' : ''}, ${proj})\n` +
      (lines.length ? lines.join('\n') : '- Nothing needed to move'),
  );
}

// ---------- 9. Issue follows its PR (paused issues stay paused) ----------
for (const pr of myPRs) {
  for (const issue of linkedIssues(pr)) {
    const st = val(issue, F.status);
    if (pr.state === 'OPEN' && issue.state === 'OPEN' && !paused.has(issue.contentId) && (!st || st === S.todo)) {
      await setField(issue, F.status, S.prog);
    }
    if (pr.state === 'MERGED' && st !== S.done) await setField(issue, F.status, S.done);
  }
}

// ---------- 10. Parent follows sub-issues ----------
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

// ---------- 11. Overdue: once a day, move Target to today and push later Todo work ----------
if (st8.overdueRun !== TODAY) {
  const T = isWorkday(TODAY) ? TODAY : nextWorkdayAfter(TODAY);
  const perProject = {};
  const moves = [];
  for (const it of P.items) {
    if (!plain(it) || val(it, F.status) === S.done) continue;
    const t = val(it, F.target);
    if (!t || t >= TODAY) continue;
    st8.slipped[it.contentId] ??= t; // remember the original date
    await setField(it, F.target, T);
    moves.push({ id: it.contentId, from: t, to: T });
    const proj = val(it, F.project);
    const n = countWorkdays(addDays(t, 1), T);
    if (proj && n > 0) {
      const p = (perProject[proj] ??= { n: 0, after: t, ids: new Set() });
      p.n = Math.max(p.n, n);
      if (t < p.after) p.after = t;
      p.ids.add(it.contentId);
    }
  }
  for (const [proj, p] of Object.entries(perProject)) {
    for (const it of P.items) {
      if (!plain(it) || val(it, F.project) !== proj || p.ids.has(it.contentId) || val(it, F.status) !== S.todo) continue;
      const s = val(it, F.start);
      const t = val(it, F.target);
      if (!s || s <= p.after) continue; // only work planned after the late issue
      await setField(it, F.start, shiftWorkdays(s, p.n));
      if (t) {
        const nt = shiftWorkdays(t, p.n);
        await setField(it, F.target, nt);
        moves.push({ id: it.contentId, from: t, to: nt });
      }
    }
  }
  st8.overdueRun = TODAY;
  st8.overnight = { date: TODAY, moves };
}

// ---------- 12. Sub-issue dates, both directions (newer edit wins) ----------
async function syncDate(parent, children, field, mode) {
  const later = (a, b) => (mode === 'max' ? a > b : a < b);
  const pVal = val(parent, field);
  const dated = children.filter((c) => val(c, field));
  if (!dated.length) {
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

// ---------- 13. Start date when work begins ----------
for (const it of myIssues) {
  if (val(it, F.status) === S.prog && !val(it, F.start)) await setField(it, F.start, TODAY);
}

// ---------- 14. Project Due: fill when empty, extend when work runs past it ----------
const dueCount = {};
const maxTarget = {};
for (const it of P.items) {
  const proj = val(it, F.project);
  if (!proj) continue;
  const due = val(it, F.projectDue);
  const t = val(it, F.target);
  if (due) (dueCount[proj] ??= {})[due] = (dueCount[proj][due] || 0) + 1;
  if (t && (!maxTarget[proj] || t > maxTarget[proj])) maxTarget[proj] = t;
}
for (const it of mine) {
  const proj = val(it, F.project);
  if (!proj || val(it, F.projectDue) || !dueCount[proj]) continue;
  await setField(it, F.projectDue, Object.entries(dueCount[proj]).sort((a, b) => b[1] - a[1])[0][0]);
}
const dueMoved = {};
for (const it of P.items.filter(isMine)) {
  const proj = val(it, F.project);
  const due = val(it, F.projectDue);
  if (!proj || !due || !maxTarget[proj] || maxTarget[proj] <= due) continue;
  await setField(it, F.projectDue, maxTarget[proj]);
  dueMoved[proj] = maxTarget[proj];
}
for (const [proj, d] of Object.entries(dueMoved)) notices.push(`*${proj}* Project Due is now ${prettyDate(d)}`);

// ---------- 15. Stage, forward only ----------
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

// ---------- 16. Status Done closes the issue ----------
for (const it of myIssues) {
  if (it.state === 'OPEN' && val(it, F.status) === S.done) await closeIssue(it);
}

// ---------- Save state, send notices ----------
for (const id of Object.keys(st8.slipped)) {
  const it = byContent.get(id);
  if (!it || it.state !== 'OPEN') delete st8.slipped[id];
}
const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();
for (const [id, u] of Object.entries(st8.urgent)) if (u.resumed && u.at < monthAgo) delete st8.urgent[id];

if (!DRY) {
  if (JSON.stringify(st8) !== stateBefore) await saveState(state);
  if (notices.length) await sendWhatsApp(notices.join('\n\n'));
} else if (notices.length) {
  console.log(`Would send ${notices.length} WhatsApp notice(s)`);
}
console.log(`Done. ${changes} change(s)${DRY ? ' (dry run)' : ''}.`);

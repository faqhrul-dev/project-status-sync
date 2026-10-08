import { F, S, mytDate, nextWorkDay, prettyDate, countWorkdays, addDays, val, isMine, loadProject, loadState, sendWhatsApp } from './lib.mjs';

const MODE = process.env.MODE || 'morning';
const DRY = process.env.DRY_RUN === 'true';
const MAX_PER_SECTION = 10;

const P = await loadProject();
const st8 = (await loadState()).data;
const today = mytDate();
const nwd = nextWorkDay();
const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
const byContent = new Map(P.items.map((i) => [i.contentId, i]));

// Issues, plus PRs that have no linked issue (avoids duplicates)
const mine = P.items.filter((i) => isMine(i) && (i.type === 'Issue' || i.linkedIssueIds.length === 0));
const open = mine.filter((i) => i.state === 'OPEN' && val(i, F.status) !== S.done);
const byTarget = (a, b) => (val(a, F.target) || '9999').localeCompare(val(b, F.target) || '9999');
const short = (t) => (t.length > 55 ? `${t.slice(0, 52)}...` : t);

function line(i, extra) {
  const due = val(i, F.target);
  return `- #${i.number} ${short(i.title)}${extra ?? (due ? ` (due ${prettyDate(due)})` : '')}`;
}
function section(name, list, extraFn) {
  if (!list.length) return '';
  const shown = [...list].sort(byTarget).slice(0, MAX_PER_SECTION).map((i) => line(i, extraFn?.(i))).join('\n');
  const more = list.length > MAX_PER_SECTION ? `\n...and ${list.length - MAX_PER_SECTION} more` : '';
  return `*${name} (${list.length})*\n${shown}${more}\n\n`;
}

const inProgress = open.filter((i) => val(i, F.status) === S.prog);
const todo = open.filter((i) => val(i, F.status) === S.todo);
const overdue = open.filter((i) => val(i, F.target) && val(i, F.target) < today);
const nextDue = open.filter((i) => val(i, F.target) === nwd);
const nextStart = open.filter((i) => val(i, F.start) === nwd && val(i, F.target) !== nwd);
const slipped = open.filter((i) => st8.slipped?.[i.contentId]);
const slipText = (i) => {
  const orig = st8.slipped[i.contentId];
  const late = countWorkdays(addDays(orig, 1), today);
  return ` (was due ${prettyDate(orig)}, ${late} day${late === 1 ? '' : 's'} late)`;
};

let text = '';
if (MODE === 'morning') {
  text = `*Good morning! Plan for ${prettyDate(today)}*\n\n`;
  const moves = st8.overnight?.date === today ? st8.overnight.moves : [];
  const moved = moves.map((m) => byContent.get(m.id)).filter(Boolean);
  const moveOf = Object.fromEntries(moves.map((m) => [m.id, m]));
  text += section('Moved overnight', moved, (i) => ` (${prettyDate(moveOf[i.contentId].from)} -> ${prettyDate(moveOf[i.contentId].to)})`);
  text += section('Slipped', slipped, slipText);
  text += section('Overdue', overdue);
  text += section('Due today', open.filter((i) => val(i, F.target) === today));
  text += section('In Progress', inProgress);
  text += section('Todo', todo);
} else if (MODE === 'evening') {
  text = `*End of day: next up ${prettyDate(nwd)}*\n\n`;
  text += section(`Due ${prettyDate(nwd)}`, nextDue);
  text += section(`Starting ${prettyDate(nwd)}`, nextStart);
  text += section('Still in progress', inProgress);
  text += section('Slipped', slipped, slipText);
} else {
  const doneThisWeek = mine.filter((i) => val(i, F.status) === S.done && (i.values[F.status]?.updatedAt || '') >= weekAgo);
  text = `*Weekly report: week ending ${prettyDate(today)}*\n\n`;
  text += section('Done this week', doneThisWeek, () => '');
  text += section('Still in progress', inProgress);
  text += section('Slipped', slipped, slipText);
  text += section(`Due ${prettyDate(nwd)}`, nextDue);
  text += section(`Starting ${prettyDate(nwd)}`, nextStart);
}
if (!text.includes('- #')) text += 'Nothing on your list. Enjoy!';
text = text.trim();

console.log(`Mode: ${MODE}, message length: ${text.length} chars`); // public logs: never print the message
if (DRY) {
  console.log('DRY RUN: message not sent');
} else if (!(await sendWhatsApp(text))) {
  process.exit(1);
}

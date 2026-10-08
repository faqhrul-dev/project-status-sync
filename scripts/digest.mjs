import { F, S, mytDate, nextWorkDay, prettyDate, val, isMine, loadProject } from './lib.mjs';

const MODE = process.env.MODE || 'morning';
const DRY = process.env.DRY_RUN === 'true';
const MAX_PER_SECTION = 10;

const P = await loadProject();
const today = mytDate();
const nwd = nextWorkDay();
const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();

// Issues, plus PRs that have no linked issue (avoids duplicates)
const mine = P.items.filter((i) => isMine(i) && (i.type === 'Issue' || i.linkedIssueIds.length === 0));
const open = mine.filter((i) => i.state === 'OPEN' && val(i, F.status) !== S.done);
const byTarget = (a, b) => (val(a, F.target) || '9999').localeCompare(val(b, F.target) || '9999');

function line(i) {
  const title = i.title.length > 60 ? `${i.title.slice(0, 57)}...` : i.title;
  const due = val(i, F.target);
  return `- #${i.number} ${title}${due ? ` (due ${prettyDate(due)})` : ''}`;
}
function section(name, list) {
  if (!list.length) return '';
  const shown = list.sort(byTarget).slice(0, MAX_PER_SECTION).map(line).join('\n');
  const more = list.length > MAX_PER_SECTION ? `\n...and ${list.length - MAX_PER_SECTION} more` : '';
  return `*${name} (${list.length})*\n${shown}${more}\n\n`;
}

const overdue = open.filter((i) => val(i, F.target) && val(i, F.target) < today);
const inProgress = open.filter((i) => val(i, F.status) === S.prog);
const todo = open.filter((i) => val(i, F.status) === S.todo);
const nextDue = open.filter((i) => val(i, F.target) === nwd);
const nextStart = open.filter((i) => val(i, F.start) === nwd && val(i, F.target) !== nwd);

let text = '';
if (MODE === 'morning') {
  text = `*Good morning! Plan for ${prettyDate(today)}*\n\n`;
  text += section('Overdue', overdue);
  text += section('Due today', open.filter((i) => val(i, F.target) === today));
  text += section('In Progress', inProgress);
  text += section('Todo', todo);
} else if (MODE === 'evening') {
  text = `*End of day: next up ${prettyDate(nwd)}*\n\n`;
  text += section(`Due ${prettyDate(nwd)}`, nextDue);
  text += section(`Starting ${prettyDate(nwd)}`, nextStart);
  text += section('Still in progress', inProgress);
  text += section('Overdue', overdue);
} else {
  const doneThisWeek = mine.filter(
    (i) => val(i, F.status) === S.done && (i.values[F.status]?.updatedAt || '') >= weekAgo,
  );
  text = `*Weekly report: week ending ${prettyDate(today)}*\n\n`;
  text += section('Done this week', doneThisWeek);
  text += section('Still in progress', inProgress);
  text += section('Overdue', overdue);
  text += section(`Due ${prettyDate(nwd)}`, nextDue);
  text += section(`Starting ${prettyDate(nwd)}`, nextStart);
}
if (!text.includes('- #')) text += 'Nothing on your list. Enjoy!';
text = text.trim();

// Public logs: never print the message itself
console.log(`Mode: ${MODE}, message length: ${text.length} chars`);
if (DRY) {
  console.log('DRY RUN: message not sent');
  process.exit(0);
}

const url =
  'https://api.callmebot.com/whatsapp.php' +
  `?phone=${encodeURIComponent(process.env.WA_PHONE)}` +
  `&text=${encodeURIComponent(text)}` +
  `&apikey=${encodeURIComponent(process.env.WA_APIKEY)}`;
const res = await fetch(url);
console.log(`WhatsApp sent: HTTP ${res.status}`);
if (!res.ok) process.exit(1);

// pattern: Functional Core
// TS port of server daily.py title helpers: Roam's ordinal daily-page
// titles ("July 13th, 2026"). Local daily auto-create offline needs the
// exact same format the server generates.

const MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November",
                "December"];

const TITLE_RE = new RegExp(
  `^(${MONTHS.join("|")}) (\\d{1,2})(st|nd|rd|th), (\\d{4})$`);

function suffix(day: number): string {
  if (day % 100 >= 10 && day % 100 <= 20) return "th";
  return { 1: "st", 2: "nd", 3: "rd" }[day % 10] ?? "th";
}

export function titleForDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${suffix(d.getDate())},` +
    ` ${d.getFullYear()}`;
}

export function dateForTitle(title: string): Date | null {
  const m = TITLE_RE.exec(title);
  if (!m) return null;
  const day = Number(m[2]);
  if (suffix(day) !== m[3]) return null;
  return new Date(Number(m[4]), MONTHS.indexOf(m[1]), day);
}

// TS port of daily.py select_journal_days (pkm-03x6): the dates a journal
// batch shows, newest first. No cursor: today leads — always, even when
// empty, so there is a page to compose into — then the most recent
// non-empty days before it. With a cursor: the most recent non-empty days
// strictly before it. All dates are local midnights.
export function selectJournalDays(nonempty: Date[], today: Date,
                                  before: Date | null, limit: number): Date[] {
  const pool = nonempty
    .filter((d) => d.getTime() < (before ?? today).getTime())
    .sort((a, b) => b.getTime() - a.getTime());
  if (before === null) {
    return [today, ...pool.slice(0, Math.max(0, limit - 1))];
  }
  return pool.slice(0, limit);
}

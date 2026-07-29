// pattern: Imperative Shell
// Inline month-grid picker for the /date slash command (pkm-rw6w).
// Mouse-only BY DESIGN: every interactive element handles onMouseDown +
// preventDefault (the AutocompletePopup row trick) so the block textarea
// never loses focus — BlockInput stays mounted and the insertion can ride
// the normal setText draft path, unlike /upload's focus-stealing native
// dialog. Keyboard access is Escape-to-close, handled by BlockInput.
import { useState } from "react";
import { calendarWeeks, monthLabel, WEEKDAY_HEADERS } from "../outline/calendar";

export function DatePickerPopup({ initial, onPick }: {
  initial: Date; onPick: (d: Date) => void;
}) {
  const [view, setView] = useState(
    { year: initial.getFullYear(), month: initial.getMonth() });
  const move = (delta: number) => {
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };
  const todayMs = new Date(initial.getFullYear(), initial.getMonth(),
                           initial.getDate()).getTime();
  return (
    <div className="date-picker" role="dialog" aria-label="pick a date">
      <div className="date-picker-header">
        <button type="button" aria-label="previous month"
                onMouseDown={(e) => { e.preventDefault(); move(-1); }}>‹</button>
        <span>{monthLabel(view.year, view.month)}</span>
        <button type="button" aria-label="next month"
                onMouseDown={(e) => { e.preventDefault(); move(1); }}>›</button>
      </div>
      <div className="date-picker-grid">
        {WEEKDAY_HEADERS.map((h) => (
          <span key={h} className="date-picker-dow">{h}</span>
        ))}
        {calendarWeeks(view.year, view.month).flat().map((cell) => (
          <button key={cell.date.getTime()} type="button"
                  className={"date-picker-day"
                    + (cell.inMonth ? "" : " outside")
                    + (cell.date.getTime() === todayMs ? " today" : "")}
                  onMouseDown={(e) => { e.preventDefault(); onPick(cell.date); }}>
            {cell.day}
          </button>
        ))}
      </div>
    </div>
  );
}

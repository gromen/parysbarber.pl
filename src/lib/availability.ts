import { WORKING_HOURS, BUFFER_MINUTES, MIN_LEAD_TIME_HOURS, BOOKING_WINDOW_DAYS, TIMEZONE } from '../config/hours';

const SLOT_STEP_MINUTES = 15;

export interface ExistingAppointment {
  startAtISO: string;
  endAtISO: string;
}

export interface ComputeAvailableSlotsArgs {
  date: string; // YYYY-MM-DD
  serviceDurationMinutes: number;
  existingAppointments: ExistingAppointment[];
  now: Date;
}

// Converts a local wall-clock date+time in `timezone` to a UTC ISO string, without
// assuming a fixed offset (Europe/Warsaw switches CET/CEST). We format a UTC guess
// through Intl in the target timezone and correct the guess by the observed drift.
export function zonedDateToUTCISO(dateStr: string, timeStr: string, timezone: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  // Initial guess: treat the wall-clock time as if it were UTC.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const parts = utcISOToZonedParts(guess.toISOString(), timezone);
  const asUTCIfLocalPartsWereUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0
  );

  // Drift between what we wanted (wall clock) and what the guess produced in the zone.
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  const drift = wanted - asUTCIfLocalPartsWereUTC;

  return new Date(guess.getTime() + drift).toISOString();
}

export function utcISOToZonedParts(iso: string, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
} {
  const date = new Date(iso);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const values: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    // Intl returns "24" for midnight with hour12:false in some environments; normalize.
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    weekday: weekdayMap[values.weekday],
  };
}

function dateStrWeekday(dateStr: string, timezone: string): number {
  // Noon UTC avoids DST-boundary edge cases when just determining the weekday.
  const parts = utcISOToZonedParts(`${dateStr}T12:00:00.000Z`, timezone);
  return parts.weekday;
}

// Today's date (YYYY-MM-DD) in the given timezone — do not use `new Date().toISOString()`
// for this, it's UTC and drifts a day off from Europe/Warsaw near midnight.
export function todayDateStrInZone(now: Date, timezone: string): string {
  const parts = utcISOToZonedParts(now.toISOString(), timezone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function computeAvailableSlots({
  date,
  serviceDurationMinutes,
  existingAppointments,
  now,
}: ComputeAvailableSlotsArgs): string[] {
  const timezone = TIMEZONE;

  const todayDateStr = todayDateStrInZone(now, timezone);
  const maxDate = new Date(now.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const maxDateStr = todayDateStrInZone(maxDate, timezone);

  if (date < todayDateStr || date > maxDateStr) return [];

  const weekday = dateStrWeekday(date, timezone);
  const hours = WORKING_HOURS[weekday];
  if (!hours) return [];

  const [openHour, openMinute] = hours.open.split(':').map(Number);
  const [closeHour, closeMinute] = hours.close.split(':').map(Number);
  const openTotalMinutes = openHour * 60 + openMinute;
  const closeTotalMinutes = closeHour * 60 + closeMinute;

  const minLeadMs = MIN_LEAD_TIME_HOURS * 60 * 60 * 1000;
  const earliestAllowed = now.getTime() + minLeadMs;

  const existing = existingAppointments.map((a) => ({
    start: new Date(a.startAtISO).getTime(),
    end: new Date(a.endAtISO).getTime(),
  }));

  const slots: string[] = [];

  for (
    let minutes = openTotalMinutes;
    minutes + serviceDurationMinutes <= closeTotalMinutes;
    minutes += SLOT_STEP_MINUTES
  ) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    const slotStartISO = zonedDateToUTCISO(date, timeStr, timezone);
    const slotStartMs = new Date(slotStartISO).getTime();
    const slotEndMs = slotStartMs + (serviceDurationMinutes + BUFFER_MINUTES) * 60 * 1000;

    if (slotStartMs < earliestAllowed) continue;

    // `a.end` is the stored appointment end with no trailing buffer, so add it here —
    // otherwise a new slot could start right when the previous appointment ends.
    const bufferMs = BUFFER_MINUTES * 60 * 1000;
    const overlaps = existing.some((a) => slotStartMs < a.end + bufferMs && slotEndMs > a.start);
    if (overlaps) continue;

    slots.push(timeStr);
  }

  return slots;
}

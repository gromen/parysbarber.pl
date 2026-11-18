import { getAvailableSlots } from './db';
import { listBusyIntervals, LIST_BUSY_BACKOFF_ERROR } from './googleCalendar';
import { isBookableDate, paddedDayWindowUTC, type ExistingAppointment } from './availability';

// Available slots for a service/date, treating events on the barber's Google
// Calendar as busy time on top of D1 appointments and blocks. The barber takes
// some bookings by phone and only adds them to his calendar — those are read
// live from Google on every computation (never written to D1, never shown in
// /panel) so the public form and the POST re-validation both respect them.
//
// Fails open: if Google is unreachable, slow or misconfigured we fall back to
// D1-only availability rather than taking the booking form down. The cost is a
// possible double-booking against a hand-added event during a Google outage,
// which the barber can resolve by phone — better than losing all online bookings.
export async function getSlotsWithCalendar(env: Env, serviceId: number, dateISO: string): Promise<string[]> {
  // Past, out-of-window and closed days have no slots regardless of the calendar,
  // so don't spend a Google round-trip (or rate-limit budget) on them.
  if (!isBookableDate(dateISO, new Date())) return [];

  // Same ±1 day window getAvailableSlots uses for D1, so events straddling local
  // midnight (relative to UTC) are still considered for overlap checks.
  const { startISO, endISO } = paddedDayWindowUTC(dateISO);

  let calendarBusy: ExistingAppointment[] = [];
  const result = await listBusyIntervals(env, startISO, endISO);
  if (result.ok) {
    calendarBusy = result.intervals;
  } else if (result.error !== 'not_configured' && result.error !== LIST_BUSY_BACKOFF_ERROR) {
    // Backoff results are skipped here so an outage is logged once per failed
    // lookup, not once per slot request served from the fallback.
    console.error(
      `Google Calendar busy-interval lookup failed for ${dateISO} (falling back to D1-only availability): ${result.error}`
    );
  }

  return getAvailableSlots(env.DB, serviceId, dateISO, calendarBusy);
}

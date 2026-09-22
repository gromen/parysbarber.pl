import type { Env } from './env';
import {
  findAppointmentsInReminderWindow,
  listBarberPushSubscriptions,
  markReminderSent,
  deletePushSubscriptionById,
} from './db';
import { sendPushNotification } from './push';

const MINUTE_MS = 60 * 1000;

function formatTimeForDisplay(iso: string): string {
  // Appointments are stored/queried in UTC ISO; render in the site's local
  // (Europe/Warsaw) wall-clock time for the notification text.
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

// Window logic: for a given offset (e.g. 15 minutes before the appointment),
// build a 1-minute-wide window [now+offset, now+offset+1min) so a once-a-minute cron
// tick catches each appointment exactly once as its start_at crosses the threshold.
// See zakres-prac.md section 3 for why the cron must be per-minute (a 5-minute cron
// with a 15-minute threshold could fire up to 10 minutes early).
function reminderWindow(now: Date, offsetMinutes: number): { startISO: string; endISO: string } {
  const start = new Date(now.getTime() + offsetMinutes * MINUTE_MS);
  const end = new Date(start.getTime() + MINUTE_MS);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

async function runBarberReminders(db: D1Database, env: Env, now: Date): Promise<void> {
  const { startISO, endISO } = reminderWindow(now, 15);
  const appointments = await findAppointmentsInReminderWindow(db, startISO, endISO, 'barber_15');

  for (const appointment of appointments) {
    try {
      // Mark sent once per appointment regardless of how many barber devices exist.
      // We insert the row unconditionally as soon as we've decided to process this
      // appointment — even before sending — since the window is only 1 minute wide
      // and start_at is fixed, so the appointment can't reappear in next minute's
      // query regardless. This guards against Cloudflare redelivering/overlapping a
      // cron trigger for the same minute rather than enabling any real retry.
      await markReminderSent(db, appointment.id, 'barber_15');

      const barberSubs = await listBarberPushSubscriptions(db);
      const payload = {
        title: 'Nadchodzący klient',
        body: `${appointment.client_name}, tel. ${appointment.client_phone}, ${formatTimeForDisplay(appointment.start_at)}, ${appointment.service_name}`,
        url: '/panel',
      };

      for (const sub of barberSubs) {
        try {
          const result = await sendPushNotification(env, sub, payload);
          if (!result.ok && result.deadSubscription) {
            await deletePushSubscriptionById(db, sub.id);
          }
        } catch (err) {
          console.error(`barber_15 push failed for subscription #${sub.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`barber_15 reminder failed for appointment #${appointment.id}:`, err);
    }
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    ctx.waitUntil(runBarberReminders(env.DB, env, now));
  },

  // No fetch traffic is expected — this Worker is cron-only. A minimal handler is
  // kept only because `wrangler dev` needs a fetch export to serve local requests
  // (e.g. for manually hitting /__scheduled during testing); Cloudflare itself does
  // not require a fetch handler for a scheduled-only Worker in production.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
};

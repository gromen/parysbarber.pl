import type { Env } from './env';
import {
  findAppointmentsInReminderWindow,
  getClientPushSubscriptionByAppointmentId,
  listBarberPushSubscriptions,
  markReminderSent,
  deletePushSubscriptionById,
  type UpcomingAppointmentRow,
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

function cancelUrlFor(cancelToken: string): string {
  return `https://parysbarber.pl/rezerwacja/anuluj/${cancelToken}`;
}

// Window logic: for a given offset (e.g. 30 or 15 minutes before the appointment),
// build a 1-minute-wide window [now+offset, now+offset+1min) so a once-a-minute cron
// tick catches each appointment exactly once as its start_at crosses the threshold.
// See zakres-prac.md section 3 for why the cron must be per-minute (a 5-minute cron
// with a 15-minute threshold could fire up to 10 minutes early).
function reminderWindow(now: Date, offsetMinutes: number): { startISO: string; endISO: string } {
  const start = new Date(now.getTime() + offsetMinutes * MINUTE_MS);
  const end = new Date(start.getTime() + MINUTE_MS);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// reminders_sent bookkeeping: we insert the row unconditionally once we've decided to
// process an appointment for this kind — even if no subscription was found to send to.
// Reasoning: because the window is only 1 minute wide and start_at is fixed, an
// appointment can only ever match a given reminder's window during that single tick
// (the window shifts forward each minute, so a later tick's window will already be
// past start_at). Skipping the insert when there's no subscription therefore buys no
// real retry opportunity — the appointment won't reappear in the query next minute
// regardless. What it WOULD do is leave the appointment reprocessable if Cloudflare
// ever redelivers/overlaps a cron trigger for the same minute, which is the failure
// mode we actually want to guard against. So: mark as sent as soon as we've looked up
// the subscription, before attempting the send.
async function processReminder(
  db: D1Database,
  env: Env,
  appointment: UpcomingAppointmentRow,
  kind: 'client_30' | 'barber_15',
  buildPayload: (appointment: UpcomingAppointmentRow) => { title: string; body: string; url?: string }
): Promise<void> {
  const sub = await getClientPushSubscriptionByAppointmentId(db, appointment.id);

  await markReminderSent(db, appointment.id, kind);

  if (!sub) {
    return;
  }

  const result = await sendPushNotification(env, sub, buildPayload(appointment));

  if (!result.ok && result.deadSubscription) {
    await deletePushSubscriptionById(db, sub.id);
  }
}

async function runClientReminders(db: D1Database, env: Env, now: Date): Promise<void> {
  const { startISO, endISO } = reminderWindow(now, 30);
  const appointments = await findAppointmentsInReminderWindow(db, startISO, endISO, 'client_30');

  for (const appointment of appointments) {
    try {
      await processReminder(db, env, appointment, 'client_30', (a) => ({
        title: 'Przypomnienie o wizycie',
        body: `${a.service_name} o ${formatTimeForDisplay(a.start_at)}. Odwołaj: ${cancelUrlFor(a.cancel_token)}`,
        url: cancelUrlFor(a.cancel_token),
      }));
    } catch (err) {
      console.error(`client_30 reminder failed for appointment #${appointment.id}:`, err);
    }
  }
}

async function runBarberReminders(db: D1Database, env: Env, now: Date): Promise<void> {
  const { startISO, endISO } = reminderWindow(now, 15);
  const appointments = await findAppointmentsInReminderWindow(db, startISO, endISO, 'barber_15');

  for (const appointment of appointments) {
    try {
      // Mark sent once per appointment regardless of how many barber devices exist —
      // same reasoning as processReminder, done here since barber_15 fans out to
      // multiple subscriptions rather than the single-subscription helper above.
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
    ctx.waitUntil(
      (async () => {
        await runClientReminders(env.DB, env, now);
        await runBarberReminders(env.DB, env, now);
      })()
    );
  },

  // No fetch traffic is expected — this Worker is cron-only. A minimal handler is
  // kept only because `wrangler dev` needs a fetch export to serve local requests
  // (e.g. for manually hitting /__scheduled during testing); Cloudflare itself does
  // not require a fetch handler for a scheduled-only Worker in production.
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
};

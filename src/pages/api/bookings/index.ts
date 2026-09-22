import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  createAppointment,
  getServiceById,
  getAvailableSlots,
  countFutureConfirmedAppointmentsByEmail,
  listBarberPushSubscriptions,
  deletePushSubscriptionById,
} from '../../../lib/db';
import { zonedDateToUTCISO } from '../../../lib/availability';
import { sendBookingConfirmationEmail, sendBarberNewBookingEmail } from '../../../lib/email';
import { sendPushNotification } from '../../../lib/push';
import { TIMEZONE } from '../../../config/hours';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d+\s()-]{7,20}$/;
const MAX_FUTURE_BOOKINGS_PER_EMAIL = 3;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface BookingBody {
  serviceId?: unknown;
  date?: unknown;
  time?: unknown;
  clientName?: unknown;
  clientPhone?: unknown;
  clientEmail?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  let body: BookingBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('invalid_json', 400);
  }

  const { serviceId, date, time, clientName, clientPhone, clientEmail } = body;

  if (typeof serviceId !== 'number' || !Number.isInteger(serviceId)) {
    return jsonError('invalid_service_id', 400);
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return jsonError('invalid_date', 400);
  }
  if (typeof time !== 'string' || !TIME_RE.test(time)) {
    return jsonError('invalid_time', 400);
  }
  if (typeof clientName !== 'string' || clientName.trim().length < 2) {
    return jsonError('invalid_client_name', 400);
  }
  if (typeof clientPhone !== 'string' || !PHONE_RE.test(clientPhone.trim())) {
    return jsonError('invalid_client_phone', 400);
  }
  if (typeof clientEmail !== 'string' || !EMAIL_RE.test(clientEmail.trim())) {
    return jsonError('invalid_client_email', 400);
  }

  const db = env.DB;

  const service = await getServiceById(db, serviceId);
  if (!service) {
    return jsonError('service_not_found', 400);
  }

  // Never trust client-submitted availability — recompute server-side.
  const availableSlots = await getAvailableSlots(db, serviceId, date);
  if (!availableSlots.includes(time)) {
    return jsonError('slot_taken', 409);
  }

  const normalizedEmail = clientEmail.trim().toLowerCase();
  const existingFutureCount = await countFutureConfirmedAppointmentsByEmail(db, normalizedEmail);
  if (existingFutureCount >= MAX_FUTURE_BOOKINGS_PER_EMAIL) {
    return jsonError('too_many_bookings', 429);
  }
  // NOTE: Cloudflare's dashboard/WAF rate limiting should also be configured for
  // POST /api/bookings to guard against abuse beyond this per-email check.

  const startAtISO = zonedDateToUTCISO(date, time, TIMEZONE);
  const endAtISO = new Date(
    new Date(startAtISO).getTime() + service.duration_minutes * 60 * 1000
  ).toISOString();

  const result = await createAppointment(db, {
    serviceId,
    startAtISO,
    endAtISO,
    clientName: clientName.trim(),
    clientPhone: clientPhone.trim(),
    clientEmail: normalizedEmail,
  });

  if (!result.ok) {
    return jsonError('slot_taken', 409);
  }

  const cancelUrl = new URL(`/rezerwacja/anuluj/${result.appointment.cancel_token}`, request.url).toString();

  const [confirmationResult, barberNotifyResult] = await Promise.all([
    sendBookingConfirmationEmail(env, {
      to: result.appointment.client_email,
      clientName: result.appointment.client_name,
      serviceName: service.name,
      startAtISO: result.appointment.start_at,
      cancelUrl,
    }),
    sendBarberNewBookingEmail(env, {
      clientName: result.appointment.client_name,
      clientPhone: result.appointment.client_phone,
      serviceName: service.name,
      startAtISO: result.appointment.start_at,
    }),
  ]);

  // The appointment is already committed at this point (cancelling it would be worse
  // than a missed email — the client would think they're booked when they're not).
  // If the barber notification fails, this is the one signal to catch it: surface it
  // loudly so it shows up in `wrangler tail` / the Cloudflare dashboard logs.
  if (!barberNotifyResult.sent) {
    console.error(
      `BARBER NOTIFICATION EMAIL FAILED for appointment #${result.appointment.id} ` +
        `(${result.appointment.client_name}, ${result.appointment.start_at}) — barber will not know about this booking unless they check the panel.`
    );
  }
  if (!confirmationResult.sent) {
    console.error(`Client confirmation email failed for appointment #${result.appointment.id}.`);
  }

  try {
    const barberSubs = await listBarberPushSubscriptions(db);
    const formattedDateTime = new Intl.DateTimeFormat('pl-PL', {
      timeZone: TIMEZONE,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(result.appointment.start_at));

    await Promise.allSettled(
      barberSubs.map(async (sub) => {
        const pushResult = await sendPushNotification(env, sub, {
          title: 'Nowa rezerwacja',
          body: `${result.appointment.client_name}, ${result.appointment.client_phone}, ${service.name}, ${formattedDateTime}`,
          url: '/panel',
        });
        if (!pushResult.ok && pushResult.deadSubscription) {
          await deletePushSubscriptionById(db, sub.id);
        }
      })
    );
  } catch (err) {
    console.error(`Barber push notification failed for appointment #${result.appointment.id}:`, err);
  }

  return new Response(
    JSON.stringify({
      cancelToken: result.appointment.cancel_token,
      startAtISO: result.appointment.start_at,
      serviceName: service.name,
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
};

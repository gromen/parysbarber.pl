import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { cancelAppointmentByToken, getAppointmentByCancelToken, getAnyServiceById } from '../../../../../lib/db';
import { sendBarberCancellationEmail } from '../../../../../lib/email';

export const prerender = false;

export const POST: APIRoute = async ({ params }) => {
  const token = params.token;
  if (!token) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = env.DB;

  const existing = await getAppointmentByCancelToken(db, token);
  if (!existing) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (existing.status === 'cancelled') {
    return new Response(JSON.stringify({ error: 'already_cancelled' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cancelled = await cancelAppointmentByToken(db, token);
  if (!cancelled) {
    return new Response(JSON.stringify({ error: 'already_cancelled' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const service = await getAnyServiceById(db, cancelled.service_id);
  const notifyResult = await sendBarberCancellationEmail(env, {
    clientName: cancelled.client_name,
    serviceName: service?.name ?? 'Usługa',
    startAtISO: cancelled.start_at,
  });
  if (!notifyResult.sent) {
    console.error(
      `BARBER CANCELLATION EMAIL FAILED for appointment #${cancelled.id} ` +
        `(${cancelled.client_name}, ${cancelled.start_at}) — barber will not know this was cancelled unless they check the panel.`
    );
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

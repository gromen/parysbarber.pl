import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAppointmentByCancelToken, getAnyServiceById } from '../../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const token = params.token;
  if (!token) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = env.DB;
  const appointment = await getAppointmentByCancelToken(db, token);
  if (!appointment) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const service = await getAnyServiceById(db, appointment.service_id);

  return new Response(
    JSON.stringify({
      clientName: appointment.client_name,
      serviceName: service?.name ?? null,
      startAtISO: appointment.start_at,
      status: appointment.status,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

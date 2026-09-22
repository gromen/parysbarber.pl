import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getAppointmentByCancelToken, getAnyServiceById } from '../../../../../lib/db';
import { buildIcsContent } from '../../../../../lib/calendar';
import { BUSINESS_ADDRESS } from '../../../../../config/hours';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const token = params.token;
  if (!token) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = env.DB;

  const appointment = await getAppointmentByCancelToken(db, token);
  if (!appointment || appointment.status !== 'confirmed') {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const service = await getAnyServiceById(db, appointment.service_id);
  const cancelUrl = new URL(`/rezerwacja/anuluj/${token}`, request.url).toString();

  const icsText = buildIcsContent({
    uid: `${appointment.cancel_token}@parysbarber.pl`,
    title: `${service?.name ?? 'Wizyta'} — Parys Saint-Barber`,
    description: `Wizyta w Parys Saint-Barber. Odwołaj: ${cancelUrl}`,
    location: BUSINESS_ADDRESS,
    startAtISO: appointment.start_at,
    endAtISO: appointment.end_at,
  });

  return new Response(icsText, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="wizyta-parys-barber.ics"',
    },
  });
};

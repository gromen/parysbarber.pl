import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getServiceById } from '../../../lib/db';
import { getSlotsWithCalendar } from '../../../lib/slotsWithCalendar';
import { todayDateStrInZone, isValidDateStr } from '../../../lib/availability';
import { TIMEZONE } from '../../../config/hours';

export const prerender = false;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const serviceIdParam = url.searchParams.get('serviceId');
  const dateParam = url.searchParams.get('date');

  if (!serviceIdParam || !/^\d+$/.test(serviceIdParam)) {
    return jsonError('invalid_service_id', 400);
  }
  if (!dateParam || !isValidDateStr(dateParam)) {
    return jsonError('invalid_date', 400);
  }

  const todayStr = todayDateStrInZone(new Date(), TIMEZONE);
  if (dateParam < todayStr) {
    return jsonError('date_in_past', 400);
  }

  const serviceId = Number(serviceIdParam);
  const db = env.DB;

  const service = await getServiceById(db, serviceId);
  if (!service) {
    return jsonError('service_not_found', 400);
  }

  const slots = await getSlotsWithCalendar(env, serviceId, dateParam);
  return new Response(JSON.stringify({ slots }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

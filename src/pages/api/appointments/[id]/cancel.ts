import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../../../../lib/auth';
import { cancelAppointmentById } from '../../../../lib/db';
import { deleteCalendarEvent } from '../../../../lib/googleCalendar';

export const prerender = false;

export const POST: APIRoute = async ({ params, cookies }) => {
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  const authed = await verifySessionToken(env, token);
  if (!authed) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const idParam = params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    return new Response(JSON.stringify({ error: 'invalid_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cancelled = await cancelAppointmentById(env.DB, Number(idParam));
  if (!cancelled) {
    return new Response(JSON.stringify({ error: 'not_found_or_already_cancelled' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (cancelled.google_calendar_event_id) {
    try {
      const deleteResult = await deleteCalendarEvent(env, cancelled.google_calendar_event_id);
      if (!deleteResult.ok) {
        console.error(
          `Google Calendar event deletion failed for appointment #${cancelled.id}: ${deleteResult.error}`
        );
      }
    } catch (err) {
      console.error(`Google Calendar event deletion threw for appointment #${cancelled.id}:`, err);
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

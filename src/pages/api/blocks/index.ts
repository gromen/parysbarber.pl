import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../../../lib/auth';
import { createBlock } from '../../../lib/db';
import { zonedDateToUTCISO } from '../../../lib/availability';
import { TIMEZONE } from '../../../config/hours';

export const prerender = false;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function nextDateStr(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  const authed = await verifySessionToken(env, token);
  if (!authed) {
    return jsonError('unauthorized', 401);
  }

  let body: { date?: unknown; startTime?: unknown; endTime?: unknown; allDay?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('invalid_body', 400);
  }

  const { date, startTime, endTime, allDay } = body;

  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return jsonError('invalid_date', 400);
  }
  if (allDay !== undefined && typeof allDay !== 'boolean') {
    return jsonError('invalid_all_day', 400);
  }

  let startAtISO: string;
  let endAtISO: string;

  if (allDay) {
    // Midnight to midnight in the salon's zone; clamp today's block to start now.
    startAtISO = zonedDateToUTCISO(date, '00:00', TIMEZONE);
    endAtISO = zonedDateToUTCISO(nextDateStr(date), '00:00', TIMEZONE);

    if (new Date(endAtISO).getTime() <= Date.now()) {
      return jsonError('start_in_past', 400);
    }
    if (new Date(startAtISO).getTime() < Date.now()) {
      startAtISO = new Date().toISOString();
    }
  } else {
    if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
      return jsonError('invalid_start_time', 400);
    }
    if (typeof endTime !== 'string' || !TIME_RE.test(endTime)) {
      return jsonError('invalid_end_time', 400);
    }

    startAtISO = zonedDateToUTCISO(date, startTime, TIMEZONE);
    endAtISO = zonedDateToUTCISO(date, endTime, TIMEZONE);

    if (new Date(endAtISO).getTime() <= new Date(startAtISO).getTime()) {
      return jsonError('invalid_range', 400);
    }
    if (new Date(startAtISO).getTime() < Date.now()) {
      return jsonError('start_in_past', 400);
    }
  }

  const result = await createBlock(env.DB, { startAtISO, endAtISO });

  if (!result.ok) {
    return jsonError(result.reason, 409);
  }

  return new Response(JSON.stringify({ block: result.block }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../../../../lib/auth';
import {
  cancelAppointmentById,
  getClientPushSubscriptionByAppointmentId,
  deletePushSubscriptionById,
} from '../../../../lib/db';

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

  try {
    const clientSub = await getClientPushSubscriptionByAppointmentId(env.DB, cancelled.id);
    if (clientSub) {
      await deletePushSubscriptionById(env.DB, clientSub.id);
    }
  } catch (err) {
    console.error(`Failed to delete client push subscription for cancelled appointment #${cancelled.id}:`, err);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

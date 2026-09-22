import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../../../lib/auth';
import {
  upsertPushSubscription,
  deletePushSubscriptionByEndpoint,
} from '../../../lib/db';

export const prerender = false;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface SubscriptionKeysBody {
  p256dh?: unknown;
  auth?: unknown;
}

interface SubscriptionBody {
  endpoint?: unknown;
  keys?: SubscriptionKeysBody;
}

interface SubscribeBody {
  role?: unknown;
  subscription?: SubscriptionBody;
}

function isValidSubscription(
  subscription: SubscriptionBody | undefined
): subscription is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!subscription || typeof subscription !== 'object') return false;
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.trim().length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(subscription.endpoint);
  } catch {
    return false;
  }
  const keys = subscription.keys;
  if (!keys || typeof keys !== 'object') return false;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.trim().length === 0) return false;
  if (typeof keys.auth !== 'string' || keys.auth.trim().length === 0) return false;
  return true;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: SubscribeBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('invalid_json', 400);
  }

  const { role, subscription } = body;

  if (role !== 'barber') {
    return jsonError('invalid_role', 400);
  }

  if (!isValidSubscription(subscription)) {
    return jsonError('invalid_subscription', 400);
  }

  const db = env.DB;

  // role === 'barber' — a single device-wide subscription (appointment_id NULL)
  // that gets notified for every new booking and every upcoming-appointment
  // reminder, not tied to one appointment.
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  const authed = await verifySessionToken(env, token);
  if (!authed) {
    return jsonError('unauthorized', 401);
  }

  const result = await upsertPushSubscription(db, {
    role: 'barber',
    appointmentId: null,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  });
  if (!result.ok) {
    return jsonError('endpoint_role_mismatch', 409);
  }

  return new Response(JSON.stringify({ success: true, id: result.row.id }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};

interface UnsubscribeBody {
  endpoint?: unknown;
}

export const DELETE: APIRoute = async ({ request }) => {
  let body: UnsubscribeBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('invalid_json', 400);
  }

  const { endpoint } = body;
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    return jsonError('invalid_endpoint', 400);
  }

  // No auth beyond the endpoint itself — it's an opaque, unguessable URL minted by
  // the push service, matching zakres-prac.md section 5 ("wypisanie po endpoint").
  await deletePushSubscriptionByEndpoint(env.DB, endpoint.trim());

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

import { buildPushPayload, type VapidKeys } from '@block65/webcrypto-web-push';

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export type SendPushResult = { ok: true } | { ok: false; deadSubscription: boolean; error: string };

function getVapidKeys(env: Env): VapidKeys {
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
}

// Sends a single push message to a subscription. The caller (reminders worker,
// or the bookings API for the barber "new booking" push) is responsible for
// deleting the subscription row when `deadSubscription` comes back true — this
// helper only reports it, per zakres-prac.md section 6.
export async function sendPushNotification(
  env: Env,
  sub: PushSubscriptionRow,
  payload: PushNotificationPayload
): Promise<SendPushResult> {
  try {
    const vapid = getVapidKeys(env);

    // buildPushPayload's `data` must satisfy `Jsonifiable` (a plain index-signature
    // object), which our typed `PushNotificationPayload` interface doesn't
    // structurally match — and `undefined` values (from omitted `url`/`tag`) aren't
    // valid JSON either. Rebuild as a clean plain object, dropping undefined keys.
    const data: Record<string, string> = { title: payload.title, body: payload.body };
    if (payload.url !== undefined) data.url = payload.url;
    if (payload.tag !== undefined) data.tag = payload.tag;

    const request = await buildPushPayload(
      {
        data,
        options: { ttl: 60 * 60, urgency: 'high' },
      },
      {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      vapid
    );

    const res = await fetch(sub.endpoint, request);

    if (res.ok) {
      return { ok: true };
    }

    if (res.status === 404 || res.status === 410) {
      return { ok: false, deadSubscription: true, error: `push service returned ${res.status}` };
    }

    return { ok: false, deadSubscription: false, error: `push service returned ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      deadSubscription: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

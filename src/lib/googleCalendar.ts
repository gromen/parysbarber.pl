import { TIMEZONE } from '../config/hours';

// Creates/deletes events on the barber's Google Calendar via a Google Service
// Account (JWT-based, no OAuth consent screen — the calendar is shared with the
// service account's client_email directly). Mirrors the defensive style of
// src/lib/push.ts: functions never throw, they return `{ok:false, error}`.

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Converts the PEM private key string (from GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)
// into raw PKCS8 DER bytes. The secret may be stored with literal `\n`
// two-character sequences instead of real newlines if pasted as a single-line
// env var — handle both by normalizing literal `\n` to real newlines first.
function pemToPkcs8Der(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, '\n');
  const base64 = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  return base64ToBytes(base64);
}

// Requests a short-lived OAuth2 access token from Google using a self-signed
// JWT (RFC 7523 JWT Bearer flow). Does not catch errors — callers
// (createCalendarEvent/deleteCalendarEvent) wrap this in try/catch.
async function getAccessToken(env: Env): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const headerB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(header)).buffer as ArrayBuffer);
  const claimsB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(claims)).buffer as ArrayBuffer);
  const signingInput = `${headerB64}.${claimsB64}`;

  const derBytes = pemToPkcs8Der(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    derBytes.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const signatureB64Url = bufferToBase64Url(signature);
  const jwt = `${signingInput}.${signatureB64Url}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(`Google token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface CreateCalendarEventOptions {
  summary: string;
  description: string;
  location: string;
  startAtISO: string;
  endAtISO: string;
}

export type CreateCalendarEventResult = { ok: true; eventId: string } | { ok: false; error: string };
export type DeleteCalendarEventResult = { ok: true } | { ok: false; error: string };

function checkConfigured(env: Env): { ok: true } | { ok: false; error: 'not_configured' } {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || !env.GOOGLE_CALENDAR_ID) {
    console.warn(
      'GOOGLE_SERVICE_ACCOUNT_* / GOOGLE_CALENDAR_ID is not set — skipping Google Calendar operation. ' +
        'Set it in .dev.vars locally, or via `wrangler secret put` in production.'
    );
    return { ok: false, error: 'not_configured' };
  }
  return { ok: true };
}

export async function createCalendarEvent(
  env: Env,
  opts: CreateCalendarEventOptions
): Promise<CreateCalendarEventResult> {
  const configured = checkConfigured(env);
  if (!configured.ok) return configured;

  try {
    const accessToken = await getAccessToken(env);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: opts.summary,
          description: opts.description,
          location: opts.location,
          start: { dateTime: opts.startAtISO, timeZone: TIMEZONE },
          end: { dateTime: opts.endAtISO, timeZone: TIMEZONE },
          // Popup reminder 15 min before, via the barber's own Google Calendar app —
          // replaces the separate workers/reminders/ cron+push worker entirely, since
          // this is the only thing that worker still did after client_30 was removed.
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
        }),
      }
    );

    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    }

    const data = (await res.json()) as { id: string };
    return { ok: true, eventId: data.id };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

export async function deleteCalendarEvent(env: Env, eventId: string): Promise<DeleteCalendarEventResult> {
  const configured = checkConfigured(env);
  if (!configured.ok) return configured;

  try {
    const accessToken = await getAccessToken(env);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (res.ok || res.status === 404 || res.status === 410) {
      return { ok: true };
    }

    return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

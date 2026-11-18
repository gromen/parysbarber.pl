import { TIMEZONE } from '../config/hours';
import { zonedDateToUTCISO } from './availability';

// Creates/deletes/lists events on the barber's Google Calendar via a Google Service
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

// Module-level access-token cache. Workers reuse an isolate across many requests,
// and the public slot list now hits Google on every date the client picks — minting
// a fresh JWT + token round-trip each time would add latency and risk the token
// endpoint's rate limits. Keyed by the service account email only: rotating the
// private key under the same email keeps using the already-minted token until it
// expires (≤1 h), which is fine — the old token stays valid at Google's end too.
let cachedToken: { email: string; token: string; expiresAtMs: number } | null = null;

// The mint currently in progress, shared by every request that finds the cache
// empty at the same time, so a burst of slot lookups after expiry triggers one
// token round-trip instead of one per request.
let tokenInFlight: { email: string; promise: Promise<string> } | null = null;

// Refresh this long before Google's stated expiry so an in-flight request never
// carries a token that expires mid-call.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

// The mint is shared across requests, so it can't use any one caller's
// AbortSignal (one caller giving up would abort it for everyone) — it gets its
// own fixed timeout instead.
const TOKEN_MINT_TIMEOUT_MS = 3000;

// Waiters race the shared mint against a local timer slightly longer than the
// mint's own timeout. Workers ties I/O to the request that started it, so if the
// originating request is cancelled mid-mint, other requests awaiting the shared
// promise must not hang until their own request deadline.
const TOKEN_WAIT_TIMEOUT_MS = TOKEN_MINT_TIMEOUT_MS + 500;

// Only drops the cache if it still holds `staleToken`, so a 401 seen on an old
// token can't discard a fresh one another request has minted in the meantime.
function invalidateAccessToken(staleToken: string): void {
  if (cachedToken?.token === staleToken) cachedToken = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns a valid OAuth2 access token, reusing the cached one while it's still
// valid and joining an in-progress mint instead of starting a second one.
// Does not catch errors — callers wrap this in try/catch.
async function getAccessToken(env: Env): Promise<string> {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (cachedToken && cachedToken.email === email && Date.now() < cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS) {
    return cachedToken.token;
  }

  if (!tokenInFlight || tokenInFlight.email !== email) {
    const entry: { email: string; promise: Promise<string> } = {
      email,
      promise: mintAccessToken(env).finally(() => {
        if (tokenInFlight === entry) tokenInFlight = null;
      }),
    };
    tokenInFlight = entry;
  }

  return withTimeout(tokenInFlight.promise, TOKEN_WAIT_TIMEOUT_MS, 'Google token mint');
}

// Requests a short-lived OAuth2 access token from Google using a self-signed
// JWT (RFC 7523 JWT Bearer flow) and stores it in the module cache.
async function mintAccessToken(env: Env): Promise<string> {
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
    signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Google token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  // Google normally returns expires_in=3600 (matching the JWT exp above); fall back
  // to that if it's ever missing.
  const expiresInSeconds = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  cachedToken = {
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    token: data.access_token,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
  return data.access_token;
}

// Runs a Calendar API request with the cached token and, on 401, retries it once
// with a freshly minted one. A cached token can be revoked or expire early at
// Google's end; without the retry the first request after that would fail —
// for deleteCalendarEvent that means a cancelled booking's event stays in the
// calendar and keeps blocking the slot on the public form.
async function fetchWithTokenRetry(env: Env, doFetch: (token: string) => Promise<Response>): Promise<Response> {
  const token = await getAccessToken(env);
  const res = await doFetch(token);
  if (res.status !== 401) return res;

  // Release the discarded response's body before retrying.
  await res.body?.cancel().catch(() => {});
  invalidateAccessToken(token);
  const freshToken = await getAccessToken(env);
  return doFetch(freshToken);
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

// Warn only once per isolate — the public slot list calls this on every date
// the client picks, so a per-call warning would flood the logs.
let warnedNotConfigured = false;

function checkConfigured(env: Env): { ok: true } | { ok: false; error: 'not_configured' } {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || !env.GOOGLE_CALENDAR_ID) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(
        'GOOGLE_SERVICE_ACCOUNT_* / GOOGLE_CALENDAR_ID is not set — skipping Google Calendar operations. ' +
          'Set it in .dev.vars locally, or via `wrangler secret put` in production.'
      );
    }
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
    // A 401 means Google rejected the request before creating anything, so
    // retrying the POST can't produce a duplicate event.
    const res = await fetchWithTokenRetry(env, (accessToken) =>
      fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`, {
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
      })
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
    const res = await fetchWithTokenRetry(env, (accessToken) =>
      fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
    );

    if (res.ok || res.status === 404 || res.status === 410) {
      return { ok: true };
    }

    return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

export interface BusyInterval {
  startAtISO: string;
  endAtISO: string;
}

// Returned instead of calling Google while a recent failure is still being
// backed off — callers should fail open without logging it again.
export const LIST_BUSY_BACKOFF_ERROR = 'backoff';

export type ListBusyIntervalsResult = { ok: true; intervals: BusyInterval[] } | { ok: false; error: string };

interface CalendarEventTime {
  date?: string; // all-day events: YYYY-MM-DD
  dateTime?: string; // timed events: RFC 3339 with offset
}

interface CalendarEventItem {
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
}

interface CalendarEventsPage {
  items?: CalendarEventItem[];
  nextPageToken?: string;
}

// Cap on followed pages — at maxResults=2500 per page this is far beyond what a
// 3-day window of a single barber's calendar can hold; it only guards against a
// runaway loop if Google ever kept returning a nextPageToken. Hitting it is
// reported as a failure rather than returning a silently partial list.
const MAX_EVENT_PAGES = 5;

// Per-request timeout for the events list call, started once the token is in
// hand (the token mint has its own TOKEN_MINT_TIMEOUT_MS). Keeps the public
// booking form responsive if Google is slow — callers fail open on any error.
const LIST_EVENTS_TIMEOUT_MS = 2500;

// After a failed lookup, skip Google for this long and return the failure
// immediately, so during an outage each slot request falls back to D1-only
// availability at once instead of waiting out the timeouts again.
const LIST_FAILURE_BACKOFF_MS = 30 * 1000;
let listBackoffUntilMs = 0;

// Event types that never represent the barber being busy. Google auto-adds
// contacts' birthdays as all-day events to the primary calendar — with the
// "all-day events always block" rule below they would wrongly close whole days.
// workingLocation events are just "working from X" markers.
const NON_BLOCKING_EVENT_TYPES = new Set(['birthday', 'workingLocation']);

// Lists the busy intervals on the barber's calendar overlapping [timeMin, timeMax),
// so bookings the barber added by hand (e.g. taken over the phone) block slots on
// the public form. Rules:
//   - cancelled events are ignored;
//   - `birthday` and `workingLocation` events are ignored (see
//     NON_BLOCKING_EVENT_TYPES); `default`, `outOfOffice`, `focusTime` and
//     `fromGmail` events block as usual;
//   - timed events marked "Free"/"Dostępny" (transparency=transparent) are ignored,
//     so the barber can keep personal notes in the calendar without blocking slots;
//   - all-day events ALWAYS block the whole local day(s), regardless of
//     transparency — Google defaults all-day events to Free, but the barber uses
//     them for days off / holidays and expects them to close the day.
// Events created by our own booking flow are returned too. That's harmless — they
// coincide with the D1 appointment that already blocks the slot — and even
// protective: if a cancellation's deleteCalendarEvent failed, the leftover event
// keeps the slot closed until the barber notices and removes it.
//
// After any failure other than `not_configured`, further calls return
// `{ok:false, error: LIST_BUSY_BACKOFF_ERROR}` for LIST_FAILURE_BACKOFF_MS
// without contacting Google.
export async function listBusyIntervals(
  env: Env,
  timeMinISO: string,
  timeMaxISO: string
): Promise<ListBusyIntervalsResult> {
  const configured = checkConfigured(env);
  if (!configured.ok) return configured;

  if (Date.now() < listBackoffUntilMs) {
    return { ok: false, error: LIST_BUSY_BACKOFF_ERROR };
  }

  const result = await fetchBusyIntervals(env, timeMinISO, timeMaxISO);
  if (!result.ok) listBackoffUntilMs = Date.now() + LIST_FAILURE_BACKOFF_MS;
  return result;
}

async function fetchBusyIntervals(env: Env, timeMinISO: string, timeMaxISO: string): Promise<ListBusyIntervalsResult> {
  try {
    const intervals: BusyInterval[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      if (pages >= MAX_EVENT_PAGES) {
        return { ok: false, error: 'too_many_pages' };
      }
      pages++;

      const params = new URLSearchParams({
        timeMin: timeMinISO,
        timeMax: timeMaxISO,
        singleEvents: 'true', // expand recurring events into individual instances
        orderBy: 'startTime',
        maxResults: '2500',
        showDeleted: 'false',
        fields: 'items(status,transparency,eventType,start,end),nextPageToken',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events?${params.toString()}`;

      // The timeout signal is created per attempt, after the token is obtained,
      // and also bounds reading the response body below.
      const res = await fetchWithTokenRetry(env, (accessToken) =>
        fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(LIST_EVENTS_TIMEOUT_MS),
        })
      );

      if (!res.ok) {
        return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
      }

      const data = (await res.json()) as CalendarEventsPage;

      for (const item of data.items ?? []) {
        if (item.status === 'cancelled') continue;
        if (item.eventType && NON_BLOCKING_EVENT_TYPES.has(item.eventType)) continue;

        if (item.start?.dateTime && item.end?.dateTime) {
          if (item.transparency === 'transparent') continue;
          intervals.push({
            startAtISO: new Date(item.start.dateTime).toISOString(),
            endAtISO: new Date(item.end.dateTime).toISOString(),
          });
        } else if (item.start?.date && item.end?.date) {
          // end.date is exclusive (the day after the last blocked day), so local
          // midnight of end.date is exactly the end of the blocked range.
          intervals.push({
            startAtISO: zonedDateToUTCISO(item.start.date, '00:00', TIMEZONE),
            endAtISO: zonedDateToUTCISO(item.end.date, '00:00', TIMEZONE),
          });
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return { ok: true, intervals };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

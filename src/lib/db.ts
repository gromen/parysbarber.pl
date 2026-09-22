import { computeAvailableSlots } from './availability';

export interface ServiceRow {
  id: number;
  name: string;
  duration_minutes: number;
  active: number;
  sort_order: number;
}

export interface AppointmentRow {
  id: number;
  service_id: number;
  client_name: string;
  client_phone: string;
  client_email: string;
  start_at: string;
  end_at: string;
  status: 'confirmed' | 'cancelled';
  cancel_token: string;
  created_at: string;
  cancelled_at: string | null;
}

export interface UpcomingAppointmentRow extends AppointmentRow {
  service_name: string;
}

export interface BlockRow {
  id: number;
  start_at: string;
  end_at: string;
  created_at: string;
}

export async function listActiveServices(db: D1Database): Promise<ServiceRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM services WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all<ServiceRow>();
  return results ?? [];
}

export async function getServiceById(db: D1Database, serviceId: number): Promise<ServiceRow | null> {
  const row = await db
    .prepare('SELECT * FROM services WHERE id = ? AND active = 1')
    .bind(serviceId)
    .first<ServiceRow>();
  return row ?? null;
}

export async function getAnyServiceById(db: D1Database, serviceId: number): Promise<ServiceRow | null> {
  const row = await db.prepare('SELECT * FROM services WHERE id = ?').bind(serviceId).first<ServiceRow>();
  return row ?? null;
}

export async function getAvailableSlots(
  db: D1Database,
  serviceId: number,
  dateISO: string
): Promise<string[]> {
  const service = await getServiceById(db, serviceId);
  if (!service) return [];

  const dayStart = `${dateISO}T00:00:00.000Z`;
  const dayEnd = `${dateISO}T23:59:59.999Z`;

  // Widen the window by a day on each side so appointments that straddle local
  // midnight (relative to UTC storage) are still considered for overlap checks.
  const { results } = await db
    .prepare(
      `SELECT start_at, end_at FROM appointments
       WHERE status = 'confirmed'
       AND start_at < ? AND end_at > ?
       ORDER BY start_at ASC`
    )
    .bind(
      new Date(new Date(dayEnd).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      new Date(new Date(dayStart).getTime() - 24 * 60 * 60 * 1000).toISOString()
    )
    .all<{ start_at: string; end_at: string }>();

  const existingAppointments = (results ?? []).map((r) => ({
    startAtISO: r.start_at,
    endAtISO: r.end_at,
  }));

  const { results: blockResults } = await db
    .prepare(
      `SELECT start_at, end_at FROM blocks
       WHERE start_at < ? AND end_at > ?
       ORDER BY start_at ASC`
    )
    .bind(
      new Date(new Date(dayEnd).getTime() + 24 * 60 * 60 * 1000).toISOString(),
      new Date(new Date(dayStart).getTime() - 24 * 60 * 60 * 1000).toISOString()
    )
    .all<{ start_at: string; end_at: string }>();

  const existingBlocks = (blockResults ?? []).map((r) => ({
    startAtISO: r.start_at,
    endAtISO: r.end_at,
  }));

  return computeAvailableSlots({
    date: dateISO,
    serviceDurationMinutes: service.duration_minutes,
    existingAppointments: [...existingAppointments, ...existingBlocks],
    now: new Date(),
  });
}

export interface CreateAppointmentInput {
  serviceId: number;
  startAtISO: string;
  endAtISO: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
}

export type CreateAppointmentResult =
  | { ok: true; appointment: AppointmentRow }
  | { ok: false; reason: 'slot_taken' };

function generateCancelToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// D1 has no true cross-statement transactions reachable from the Workers binding, so
// this overlap check + insert is not fully atomic — a race between the check and the
// insert is theoretically possible under concurrent requests for the exact same slot.
// We mitigate by keeping the check immediately before the insert (no awaits in between
// besides the two D1 calls) and by the UI re-fetching slots after a 409.
export async function createAppointment(
  db: D1Database,
  input: CreateAppointmentInput
): Promise<CreateAppointmentResult> {
  const overlap = await db
    .prepare(
      `SELECT id FROM appointments
       WHERE status = 'confirmed'
       AND start_at < ? AND end_at > ?
       LIMIT 1`
    )
    .bind(input.endAtISO, input.startAtISO)
    .first<{ id: number }>();

  if (overlap) {
    return { ok: false, reason: 'slot_taken' };
  }

  const blockOverlap = await db
    .prepare(
      `SELECT id FROM blocks
       WHERE start_at < ? AND end_at > ?
       LIMIT 1`
    )
    .bind(input.endAtISO, input.startAtISO)
    .first<{ id: number }>();

  if (blockOverlap) {
    return { ok: false, reason: 'slot_taken' };
  }

  const cancelToken = generateCancelToken();

  const inserted = await db
    .prepare(
      `INSERT INTO appointments
        (service_id, client_name, client_phone, client_email, start_at, end_at, status, cancel_token)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)
       RETURNING *`
    )
    .bind(
      input.serviceId,
      input.clientName,
      input.clientPhone,
      input.clientEmail,
      input.startAtISO,
      input.endAtISO,
      cancelToken
    )
    .first<AppointmentRow>();

  if (!inserted) {
    return { ok: false, reason: 'slot_taken' };
  }

  return { ok: true, appointment: inserted };
}

export async function countFutureConfirmedAppointmentsByEmail(
  db: D1Database,
  clientEmail: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as count FROM appointments
       WHERE status = 'confirmed' AND client_email = ? AND start_at >= ?`
    )
    .bind(clientEmail, new Date().toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getAppointmentByCancelToken(
  db: D1Database,
  token: string
): Promise<AppointmentRow | null> {
  const row = await db
    .prepare('SELECT * FROM appointments WHERE cancel_token = ?')
    .bind(token)
    .first<AppointmentRow>();
  return row ?? null;
}

export async function cancelAppointmentByToken(
  db: D1Database,
  token: string
): Promise<AppointmentRow | null> {
  const row = await db
    .prepare(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = ?
       WHERE cancel_token = ? AND status = 'confirmed'
       RETURNING *`
    )
    .bind(new Date().toISOString(), token)
    .first<AppointmentRow>();
  return row ?? null;
}

export async function cancelAppointmentById(
  db: D1Database,
  id: number
): Promise<AppointmentRow | null> {
  const row = await db
    .prepare(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = ?
       WHERE id = ? AND status = 'confirmed'
       RETURNING *`
    )
    .bind(new Date().toISOString(), id)
    .first<AppointmentRow>();
  return row ?? null;
}

export async function listUpcomingAppointments(
  db: D1Database
): Promise<UpcomingAppointmentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, s.name as service_name FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.status = 'confirmed' AND a.start_at >= ?
       ORDER BY a.start_at ASC`
    )
    .bind(new Date().toISOString())
    .all<UpcomingAppointmentRow>();
  return results ?? [];
}

export interface CreateBlockInput {
  startAtISO: string;
  endAtISO: string;
}

export type CreateBlockResult =
  | { ok: true; block: BlockRow }
  | { ok: false; reason: 'overlaps_appointment' };

export async function createBlock(
  db: D1Database,
  input: CreateBlockInput
): Promise<CreateBlockResult> {
  const overlap = await db
    .prepare(
      `SELECT id FROM appointments
       WHERE status = 'confirmed'
       AND start_at < ? AND end_at > ?
       LIMIT 1`
    )
    .bind(input.endAtISO, input.startAtISO)
    .first<{ id: number }>();

  if (overlap) {
    return { ok: false, reason: 'overlaps_appointment' };
  }

  const inserted = await db
    .prepare(
      `INSERT INTO blocks (start_at, end_at) VALUES (?, ?) RETURNING *`
    )
    .bind(input.startAtISO, input.endAtISO)
    .first<BlockRow>();

  if (!inserted) {
    return { ok: false, reason: 'overlaps_appointment' };
  }

  return { ok: true, block: inserted };
}

export async function deleteBlock(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM blocks WHERE id = ?').bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function listUpcomingBlocks(db: D1Database): Promise<BlockRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM blocks WHERE end_at >= ? ORDER BY start_at ASC')
    .bind(new Date().toISOString())
    .all<BlockRow>();
  return results ?? [];
}

export interface PushSubscriptionDbRow {
  id: number;
  role: 'client' | 'barber';
  appointment_id: number | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface UpsertPushSubscriptionInput {
  role: 'client' | 'barber';
  appointmentId: number | null;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type UpsertPushSubscriptionResult =
  | { ok: true; row: PushSubscriptionDbRow }
  | { ok: false; reason: 'role_mismatch' };

// Same endpoint re-subscribing under a different role (e.g. a barber's device
// re-registering as a client, or vice versa) is treated as a conflict rather than
// silently flipping the existing row's role — a role swap on an existing
// subscription would be unexpected behavior for whoever owns the other role.
export async function upsertPushSubscription(
  db: D1Database,
  input: UpsertPushSubscriptionInput
): Promise<UpsertPushSubscriptionResult> {
  const existing = await db
    .prepare('SELECT role FROM push_subscriptions WHERE endpoint = ?')
    .bind(input.endpoint)
    .first<{ role: 'client' | 'barber' }>();

  if (existing && existing.role !== input.role) {
    return { ok: false, reason: 'role_mismatch' };
  }

  const row = await db
    .prepare(
      `INSERT INTO push_subscriptions (role, appointment_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         role = excluded.role,
         appointment_id = excluded.appointment_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth
       RETURNING *`
    )
    .bind(input.role, input.appointmentId, input.endpoint, input.p256dh, input.auth)
    .first<PushSubscriptionDbRow>();

  if (!row) {
    throw new Error('upsertPushSubscription: insert did not return a row');
  }
  return { ok: true, row };
}

export async function deletePushSubscriptionByEndpoint(db: D1Database, endpoint: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deletePushSubscriptionById(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function listBarberPushSubscriptions(db: D1Database): Promise<PushSubscriptionDbRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM push_subscriptions WHERE role = 'barber'")
    .all<PushSubscriptionDbRow>();
  return results ?? [];
}

export async function countRemindersSentToday(db: D1Database): Promise<{ kind: string; count: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT kind, COUNT(*) as count FROM reminders_sent
       WHERE sent_at >= datetime('now', 'start of day')
       GROUP BY kind`
    )
    .all<{ kind: string; count: number }>();
  return results ?? [];
}

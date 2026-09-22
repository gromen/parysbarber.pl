// Minimal, self-contained query layer for this worker — ported from the relevant
// parts of src/lib/db.ts in the main Astro app (not imported directly, since that
// file pulls in Astro's own `Env` type and lives in a different bundle/project).

export interface UpcomingAppointmentRow {
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
  service_name: string;
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

// Appointments whose start_at falls in [windowStartISO, windowEndISO) and that don't
// already have a reminders_sent row for `kind`. Window is expected to be ~1 minute
// wide, matching the worker's per-minute cron (see zakres-prac.md section 3).
export async function findAppointmentsInReminderWindow(
  db: D1Database,
  windowStartISO: string,
  windowEndISO: string,
  kind: 'client_30' | 'barber_15'
): Promise<UpcomingAppointmentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, s.name as service_name FROM appointments a
       JOIN services s ON s.id = a.service_id
       WHERE a.status = 'confirmed'
       AND a.start_at >= ? AND a.start_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM reminders_sent r WHERE r.appointment_id = a.id AND r.kind = ?
       )
       ORDER BY a.start_at ASC`
    )
    .bind(windowStartISO, windowEndISO, kind)
    .all<UpcomingAppointmentRow>();
  return results ?? [];
}

export async function getClientPushSubscriptionByAppointmentId(
  db: D1Database,
  appointmentId: number
): Promise<PushSubscriptionDbRow | null> {
  const row = await db
    .prepare("SELECT * FROM push_subscriptions WHERE role = 'client' AND appointment_id = ?")
    .bind(appointmentId)
    .first<PushSubscriptionDbRow>();
  return row ?? null;
}

export async function listBarberPushSubscriptions(db: D1Database): Promise<PushSubscriptionDbRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM push_subscriptions WHERE role = 'barber'")
    .all<PushSubscriptionDbRow>();
  return results ?? [];
}

export async function markReminderSent(
  db: D1Database,
  appointmentId: number,
  kind: 'client_30' | 'barber_15'
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reminders_sent (appointment_id, kind) VALUES (?, ?)
       ON CONFLICT(appointment_id, kind) DO NOTHING`
    )
    .bind(appointmentId, kind)
    .run();
}

export async function deletePushSubscriptionById(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run();
}

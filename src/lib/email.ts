import { Resend } from 'resend';
import { BARBER_NOTIFICATION_EMAIL, BOOKING_FROM_EMAIL, BUSINESS_ADDRESS, TIMEZONE } from '../config/hours';
import { buildGoogleCalendarUrl, buildIcsContent } from './calendar';

function formatPolishDateTime(iso: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat('pl-PL', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const timePart = new Intl.DateTimeFormat('pl-PL', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${datePart}, ${timePart}`;
}

interface SendResult {
  sent: boolean;
}

async function safeSend(env: Env, payload: Parameters<Resend['emails']['send']>[0]): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      `RESEND_API_KEY is not set — skipping email "${payload.subject}". ` +
        'Set it in .dev.vars locally, or via `wrangler secret put RESEND_API_KEY` in production.'
    );
    return { sent: false };
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { error } = await resend.emails.send(payload);
    if (error) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        console.error(
          `Resend rejected the API key (${error.statusCode}: ${error.message}) — the booking was saved but ` +
            'no email went out. Check RESEND_API_KEY in .dev.vars / wrangler secrets.'
        );
      } else {
        console.error('Resend send error:', error);
      }
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('Resend send threw:', err);
    return { sent: false };
  }
}

export async function sendBookingConfirmationEmail(
  env: Env,
  opts: {
    to: string;
    clientName: string;
    serviceName: string;
    startAtISO: string;
    endAtISO: string;
    cancelUrl: string;
    icsUrl: string;
  }
): Promise<SendResult> {
  const when = formatPolishDateTime(opts.startAtISO);

  const googleCalendarUrl = buildGoogleCalendarUrl({
    title: `${opts.serviceName} — Parys Saint-Barber`,
    description: 'Wizyta w Parys Saint-Barber',
    location: BUSINESS_ADDRESS,
    startAtISO: opts.startAtISO,
    endAtISO: opts.endAtISO,
  });

  // The cancel URL ends with the appointment's cancel_token — reuse it as the ICS
  // UID so the same event is referenced consistently across the direct .ics link,
  // the attachment below, and repeated sends for the same appointment.
  const cancelToken = opts.cancelUrl.split('/').filter(Boolean).pop() ?? opts.cancelUrl;
  const icsContent = buildIcsContent({
    uid: `${cancelToken}@parysbarber.pl`,
    title: `${opts.serviceName} — Parys Saint-Barber`,
    description: 'Wizyta w Parys Saint-Barber',
    location: BUSINESS_ADDRESS,
    startAtISO: opts.startAtISO,
    endAtISO: opts.endAtISO,
  });

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="color: #111;">Rezerwacja potwierdzona</h2>
      <p>Cześć ${opts.clientName},</p>
      <p>Twoja wizyta w <strong>Parys Saint-Barber</strong> została zarezerwowana.</p>
      <table style="width: 100%; margin: 16px 0; border-collapse: collapse;">
        <tr><td style="padding: 4px 0; color: #555;">Usługa:</td><td style="padding: 4px 0; font-weight: 600;">${opts.serviceName}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Termin:</td><td style="padding: 4px 0; font-weight: 600;">${when}</td></tr>
      </table>
      <p>Jeśli nie możesz przyjść, odwołaj wizytę korzystając z poniższego linku:</p>
      <p><a href="${opts.cancelUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 4px; text-decoration: none;">Odwołaj wizytę</a></p>
      <p style="margin-top: 20px;">Dodaj wizytę do kalendarza:</p>
      <p>
        <a href="${googleCalendarUrl}" target="_blank" rel="noopener" style="display: inline-block; background: #fff; color: #1a1a1a; border: 1px solid #1a1a1a; padding: 9px 19px; border-radius: 4px; text-decoration: none; margin-right: 8px; margin-bottom: 8px;">Dodaj do Google Kalendarz</a>
        <a href="${opts.icsUrl}" target="_blank" rel="noopener" style="display: inline-block; background: #fff; color: #1a1a1a; border: 1px solid #1a1a1a; padding: 9px 19px; border-radius: 4px; text-decoration: none; margin-bottom: 8px;">Dodaj do Apple Calendar / Outlook</a>
      </p>
      <p style="color: #777; font-size: 13px; margin-top: 24px;">Do zobaczenia w barbershopie!<br>Parys Saint-Barber</p>
    </div>
  `;
  return safeSend(env, {
    from: BOOKING_FROM_EMAIL,
    to: opts.to,
    subject: 'Potwierdzenie rezerwacji — Parys Saint-Barber',
    html,
    attachments: [
      {
        filename: 'wizyta-parys-barber.ics',
        content: Buffer.from(icsContent, 'utf-8').toString('base64'),
        contentType: 'text/calendar',
      },
    ],
  });
}

export async function sendBarberNewBookingEmail(
  env: Env,
  opts: { clientName: string; clientPhone: string; serviceName: string; startAtISO: string }
): Promise<SendResult> {
  const when = formatPolishDateTime(opts.startAtISO);
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="color: #111;">Nowa rezerwacja</h2>
      <table style="width: 100%; margin: 16px 0; border-collapse: collapse;">
        <tr><td style="padding: 4px 0; color: #555;">Klient:</td><td style="padding: 4px 0; font-weight: 600;">${opts.clientName}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Telefon:</td><td style="padding: 4px 0; font-weight: 600;">${opts.clientPhone}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Usługa:</td><td style="padding: 4px 0; font-weight: 600;">${opts.serviceName}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Termin:</td><td style="padding: 4px 0; font-weight: 600;">${when}</td></tr>
      </table>
    </div>
  `;
  return safeSend(env, {
    from: BOOKING_FROM_EMAIL,
    to: BARBER_NOTIFICATION_EMAIL,
    subject: 'Nowa rezerwacja — Parys Saint-Barber',
    html,
  });
}

export async function sendBarberCancellationEmail(
  env: Env,
  opts: { clientName: string; serviceName: string; startAtISO: string }
): Promise<SendResult> {
  const when = formatPolishDateTime(opts.startAtISO);
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <h2 style="color: #111;">Wizyta odwołana</h2>
      <table style="width: 100%; margin: 16px 0; border-collapse: collapse;">
        <tr><td style="padding: 4px 0; color: #555;">Klient:</td><td style="padding: 4px 0; font-weight: 600;">${opts.clientName}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Usługa:</td><td style="padding: 4px 0; font-weight: 600;">${opts.serviceName}</td></tr>
        <tr><td style="padding: 4px 0; color: #555;">Termin:</td><td style="padding: 4px 0; font-weight: 600;">${when}</td></tr>
      </table>
    </div>
  `;
  return safeSend(env, {
    from: BOOKING_FROM_EMAIL,
    to: BARBER_NOTIFICATION_EMAIL,
    subject: 'Wizyta odwołana — Parys Saint-Barber',
    html,
  });
}

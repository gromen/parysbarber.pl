// Format an ISO date string as UTC in the `YYYYMMDDTHHMMSSZ` shape required by both
// the Google Calendar "add event" URL and RFC 5545 ICS DATE-TIME values.
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

export function buildGoogleCalendarUrl(opts: {
  title: string;
  description: string;
  location: string;
  startAtISO: string;
  endAtISO: string;
}): string {
  const start = toIcsUtc(opts.startAtISO);
  const end = toIcsUtc(opts.endAtISO);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: opts.title,
    dates: `${start}/${end}`,
    details: opts.description,
    location: opts.location,
    ctz: 'Europe/Warsaw',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export function buildIcsContent(opts: {
  uid: string;
  title: string;
  description: string;
  location: string;
  startAtISO: string;
  endAtISO: string;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Parys Saint-Barber//Booking//PL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsEscape(opts.uid)}`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    `DTSTART:${toIcsUtc(opts.startAtISO)}`,
    `DTEND:${toIcsUtc(opts.endAtISO)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(opts.description)}`,
    `LOCATION:${icsEscape(opts.location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

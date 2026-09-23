// Working hours per weekday (0 = Sunday ... 6 = Saturday), 24h format, Europe/Warsaw.
export const WORKING_HOURS: Record<number, { open: string; close: string } | null> = {
  0: null, // Niedziela — zamknięte
  1: { open: '09:00', close: '20:00' },
  2: { open: '09:00', close: '20:00' },
  3: { open: '09:00', close: '20:00' },
  4: { open: '09:00', close: '20:00' },
  5: { open: '09:00', close: '20:00' },
  6: { open: '08:00', close: '14:00' },
};

// Bufor sprzątania/przerwy między wizytami.
export const BUFFER_MINUTES = 5;

// Minimalne wyprzedzenie rezerwacji.
export const MIN_LEAD_TIME_HOURS = 2;

// Ile dni w przód klient może przeglądać dostępne terminy.
export const BOOKING_WINDOW_DAYS = 30;

export const TIMEZONE = 'Europe/Warsaw';

export const BARBER_NOTIFICATION_EMAIL = 'parysbarber@gmail.com';

// Adres nadawcy dla Resend — wymaga zweryfikowanej domeny parysbarber.pl w Resend.
export const BOOKING_FROM_EMAIL = 'Parys Saint-Barber <rezerwacje@parysbarber.pl>';

export const BUSINESS_ADDRESS = 'ul. Tadeusza Kościuszki 38E/5U, 07-300 Ostrów Mazowiecka';

// Stable production origin — used where a value must be an absolute URL that
// resolves outside of the current request (e.g. images embedded in emails,
// fetched by the recipient's mail client, not from within our own session).
export const SITE_URL = 'https://parysbarber.pl';

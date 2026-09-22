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

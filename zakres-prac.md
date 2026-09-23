# Zakres prac — PWA offline + powiadomienia push

Ustalenia z 2026-09-22. Dotyczy projektu `parysbarber.pl` (Astro 6 + Cloudflare Workers + D1).

## 1. Cel

1. Strona ma działać offline jako PWA (instalowalna, z cache'owanym shellem).
2. Klient ma dostawać powiadomienie push przed wizytą.
3. Barber ma dostawać powiadomienie push o nadchodzącym kliencie oraz o każdej nowej rezerwacji.

## 2. Matryca powiadomień

| Odbiorca | Kiedy | Treść |
|---|---|---|
| Klient | 30 min przed wizytą | usługa, godzina, link do odwołania |
| Barber | 15 min przed wizytą | imię i nazwisko klienta, telefon, godzina, usługa |
| Barber | natychmiast po nowej rezerwacji | jw. + data wizyty |

Klient dostaje **jedno** powiadomienie (30 min). Progu 60 min nie realizujemy.

Deduplikacja: `reminders_sent.kind` przyjmuje `client_30` i `barber_15`. Push „po nowej rezerwacji"
wychodzi bezpośrednio z endpointu `/api/bookings` i nie podlega dedupowi.

Pełne dane klienta (imię, nazwisko, telefon) mogą pojawić się na ekranie blokady telefonu barbera —
zaakceptowane. Payload push jest szyfrowany end-to-end (RFC 8291), więc serwis push nie widzi treści.

## 3. Decyzje techniczne

**Cron w osobnym Workerze.** Adapter `@astrojs/cloudflare` eksportuje wyłącznie `fetch`
(`node_modules/@astrojs/cloudflare/dist/entrypoints/server.js`), więc dodanie handlera `scheduled`
do głównego workera wymagałoby własnego entry pointu i łatania builda przy każdej aktualizacji
adaptera. Osobny worker w `workers/reminders/` to kilkanaście linii configu i brak sprzężenia
z frameworkiem.

**Cron co minutę** (`* * * * *`), nie co 5 minut. Przy progu 15 min okno 5-minutowe dawałoby
powiadomienie nawet 10 min przed wizytą.

**Biblioteka push:** `@block65/webcrypto-web-push` (Web Crypto, RFC 8291). Pakiet `web-push` z npm
nie działa na workerd, bo opiera się na `node:crypto`.

**Service worker:** `@vite-pwa/astro` w trybie `injectManifest` — własny plik SW, bo potrzebne są
handlery `push` i `notificationclick`.

**Ikony PWA:** generowane z `public/parys_logo_final.svg`.

## 4. Faza 1 — PWA / offline

- [ ] `@vite-pwa/astro` w trybie `injectManifest`.
- [ ] `manifest.webmanifest` + ikony 192/512 + maskable, kolory z brandu.
- [ ] Precache: CSS, JS, fonty, logo.
- [ ] `stale-while-revalidate` dla `/`, `/cennik`, `/kontakt`.
- [ ] `NetworkOnly` dla `/api/*` i `/panel/*`.
- [ ] Strona fallback `/offline`.
- [ ] `reelparys.mp4` wykluczony z precache (waga pliku).
- [ ] Rejestracja SW w `BaseLayout.astro`.

## 5. Faza 2 — infrastruktura push

- [ ] Migracja `0005`:
      `push_subscriptions(id, role TEXT, appointment_id NULL, endpoint UNIQUE, p256dh, auth, created_at)`
      z `CHECK`: `role='client'` wymaga `appointment_id`, `role='barber'` wymaga `NULL`.
- [ ] Migracja `0005`: `reminders_sent(appointment_id, kind, sent_at, PRIMARY KEY(appointment_id, kind))`.
- [ ] Sekrety: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- [ ] `POST /api/push/subscribe` — autoryzacja klienta przez `cancelToken`, barbera przez sesję
      panelu (`requireAuth`, `src/lib/auth.ts`).
- [ ] `DELETE /api/push/subscribe` — wypisanie po `endpoint`.
- [ ] Klient: przycisk „Przypomnij mi" na ekranie potwierdzenia rezerwacji
      (`Notification.requestPermission()` tylko w geście użytkownika).
- [ ] Barber: przełącznik „Powiadomienia na tym urządzeniu" w `/panel` + widoczny stan
      (włączone / brak zgody / nieobsługiwane).
- [ ] Handlery w SW: `push` → `showNotification`, `notificationclick` → link odwołania (klient)
      lub `/panel` (barber), akcja `tel:` do klienta tam, gdzie przeglądarka wspiera `actions`.

## 6. Faza 3 — wysyłka

- [ ] `workers/reminders/` z własnym `wrangler.toml`, bindingiem tej samej bazy D1 i sekretami VAPID.
- [ ] `crons = ["* * * * *"]`.
- [ ] Logika: wizyty `confirmed` ze `start_at` w oknie `[now+X, now+X+1min]` bez wpisu
      w `reminders_sent` → wyślij → zapisz wpis.
- [ ] Odpowiedź `404`/`410` z push service → usunięcie martwej subskrypcji.
- [ ] Push do barbera z `/api/bookings` po udanej rezerwacji.
- [ ] Test lokalny: `wrangler dev --test-scheduled`.

## 7. Faza 4 — domknięcie

- [ ] Kasowanie subskrypcji klienta przy odwołaniu wizyty.
- [ ] Stan/licznik wysyłek widoczny w panelu.

## 8. Ograniczenia przyjęte do wiadomości

- **iOS/Safari:** push działa dopiero po dodaniu strony do ekranu głównego (iOS 16.4+);
  odinstalowanie kasuje subskrypcję. Dla barbera to jednorazowa czynność, dla klientów oznacza,
  że **e-mail pozostaje kanałem podstawowym**, a push jest dodatkiem.
- Subskrypcja jest per przeglądarka i urządzenie — zmiana urządzenia oznacza brak powiadomienia.
- Strony są renderowane serwerowo (`output: 'server'`), więc offline obejmuje shell i treści
  statyczne. Złożenie rezerwacji offline nie będzie możliwe — pokażemy komunikat.
- Powiadomienie może przyjść z opóźnieniem do ~1 min względem progu (okno crona).

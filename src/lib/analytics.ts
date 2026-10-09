// Client-side GA4 events pushed to the GTM dataLayer. The Google tag loaded
// through GTM (BaseLayout.astro) does not forward gtag('event') commands, so
// GTM needs a Custom Event trigger + GA4 Event tag (event name {{Event}},
// params read via Data Layer Variables) for these to reach GA4.
// Nothing is sent on localhost or without cookie consent — mirrors the GTM
// loading condition.

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

function isLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function hasConsent(): boolean {
  try {
    return localStorage.getItem('cookieConsent') === 'accepted';
  } catch {
    return false;
  }
}

export function trackEvent(name: string, params: Record<string, string | number> = {}): void {
  if (isLocalhost() || !hasConsent()) return;
  window.dataLayer = window.dataLayer || [];
  // GTM's data model keeps pushed keys until overwritten — reset every known
  // param so e.g. service_name from a booking doesn't leak into a later click.
  window.dataLayer.push({ link_location: undefined, service_name: undefined, ...params, event: name });
}

/** Tracks clicks on tel: and mailto: links anywhere on the page. */
export function initContactLinkTracking(): void {
  document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="tel:"], a[href^="mailto:"]');
    if (!link) return;

    const href = link.getAttribute('href') ?? '';
    const isPhone = href.startsWith('tel:');
    trackEvent(isPhone ? 'click_phone' : 'click_email', {
      link_location: window.location.pathname,
    });
  });
}

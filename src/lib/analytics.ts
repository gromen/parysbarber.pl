// Client-side GA4 events sent via the gtag() command queue. The Google tag
// itself is loaded through GTM (BaseLayout.astro) and reads gtag() commands
// from the shared dataLayer, so no extra GTM tags are needed for these events.
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
  // gtag.js only recognises commands pushed as an `arguments` object, not a plain array.
  function gtag(..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  }
  gtag('event', name, params);
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

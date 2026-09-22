import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// Public by design — the VAPID public key is meant to be handed to any
// browser that wants to create a push subscription, no auth needed.
export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

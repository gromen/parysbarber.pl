import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listActiveServices } from '../../lib/db';

export const prerender = false;

export const GET: APIRoute = async () => {
  const services = await listActiveServices(env.DB);
  return new Response(
    JSON.stringify({
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.duration_minutes,
      })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

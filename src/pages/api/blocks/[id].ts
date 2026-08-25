import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../../../lib/auth';
import { deleteBlock } from '../../../lib/db';

export const prerender = false;

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const token = cookies.get(SESSION_COOKIE_NAME)?.value;
  const authed = await verifySessionToken(env, token);
  if (!authed) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const idParam = params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    return new Response(JSON.stringify({ error: 'invalid_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const deleted = await deleteBlock(env.DB, Number(idParam));
  if (!deleted) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

import { env } from 'cloudflare:workers';

export const SESSION_COOKIE_NAME = 'barber_session';

const PBKDF2_ITERATIONS = 100_000;

function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// To generate ADMIN_PASSWORD_HASH for the Cloudflare secret, run this in a Node
// REPL (or any JS runtime with Web Crypto) and copy the printed string:
//
//   const { hashPassword } = await import('./src/lib/auth.ts');
//   console.log(await hashPassword('the-admin-password'));
//
// then: wrangler secret put ADMIN_PASSWORD_HASH
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `${bufferToBase64(salt.buffer as ArrayBuffer)}$${bufferToBase64(derivedBits)}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [saltB64, hashB64] = hash.split('$');
  if (!saltB64 || !hashB64) return false;

  const salt = base64ToBuffer(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const computedB64 = bufferToBase64(derivedBits);

  if (computedB64.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < computedB64.length; i++) {
    diff |= computedB64.charCodeAt(i) ^ hashB64.charCodeAt(i);
  }
  return diff === 0;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function createSessionToken(env: Env, opts?: { ttlSeconds?: number }): Promise<string> {
  const ttlSeconds = opts?.ttlSeconds ?? 60 * 60 * 24 * 7; // 7 days
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const payload = `${issuedAt}.${expiresAt}`;

  const key = await getHmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const signatureB64 = bufferToBase64(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${payload}.${signatureB64}`;
}

export async function verifySessionToken(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issuedAtStr, expiresAtStr, signatureB64] = parts;
  const payload = `${issuedAtStr}.${expiresAtStr}`;

  const key = await getHmacKey(env.SESSION_SECRET);
  const normalizedB64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalizedB64 + '='.repeat((4 - (normalizedB64.length % 4)) % 4);

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64ToBuffer(padded);
  } catch {
    return false;
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes.buffer as ArrayBuffer,
    new TextEncoder().encode(payload)
  );
  if (!valid) return false;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;

  return true;
}

// Usage in a protected .astro page's frontmatter:
//
//   const authed = await requireAuth(Astro);
//   if (!authed) return Astro.redirect('/panel/login');
//
// (Astro allows an early `return Astro.redirect(...)` from page frontmatter.)
export async function requireAuth(context: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<boolean> {
  const token = context.cookies.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(env, token);
}

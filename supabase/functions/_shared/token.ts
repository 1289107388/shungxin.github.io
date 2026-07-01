// ============================
// HMAC-SHA256 Token 工具
// 用于 admin-api / auth-api / upload-image 的 Bearer Token 签发与校验
// ============================

let AUTH_SECRET_CACHE: string | null = null;

export function getAuthSecret(): string {
  if (AUTH_SECRET_CACHE === null) {
    const raw = Deno.env.get('AUTH_SECRET');
    if (!raw || raw.length < 32) {
      throw new Error('AUTH_SECRET 环境变量未设置或长度不足 32 字符');
    }
    AUTH_SECRET_CACHE = raw;
  }
  return AUTH_SECRET_CACHE;
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function base64urlEncode(bytes: Uint8Array): string {
  const str = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function hmacSha256(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? utf8ToBytes(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', keyMaterial, utf8ToBytes(data)));
}

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  const payloadB64 = base64urlEncode(utf8ToBytes(JSON.stringify(payload)));
  const signature = await hmacSha256(getAuthSecret(), payloadB64);
  return `${payloadB64}.${base64urlEncode(signature)}`;
}

export interface TokenPayload {
  sub: string | number;
  exp?: number;
  [key: string]: unknown;
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const expectedSig = await hmacSha256(getAuthSecret(), payloadB64);
  const providedSig = base64urlDecode(sigB64);
  if (expectedSig.length !== providedSig.length) return null;

  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ providedSig[i];
  if (diff !== 0) return null;

  try {
    const payload = JSON.parse(bytesToUtf8(base64urlDecode(payloadB64))) as TokenPayload;
    if (!payload.sub) return null;
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', utf8ToBytes(token));
  return base64urlEncode(new Uint8Array(hash));
}

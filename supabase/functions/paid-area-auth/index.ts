// ============================
// paid-area-auth Edge Function
// 付费区（里站）密码验证与访问令牌签发
//   POST /paid-area-auth/verify   { password } -> { token, expires_in }
//   POST /paid-area-auth/refresh  { token }    -> { token, expires_in }
//   GET  /paid-area-auth/status                -> { configured: bool }
//
// 安全:
//   - 密码哈希存储在 site_settings.paid_area_password_hash（bcrypt）
//   - 验证成功后签发 HMAC-SHA256 签名 token，有效期 1 小时
//   - token 需配合 public-gallery?area=paid 使用
//   - 依赖环境变量 PAID_AREA_JWT_SECRET（>=32 字符）
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { verifyOrigin } from '../_shared/originGuard.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const JWT_SECRET_RAW = Deno.env.get('PAID_AREA_JWT_SECRET');
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 32) {
  throw new Error('PAID_AREA_JWT_SECRET 环境变量未设置或长度不足 32 字符');
}
const JWT_SECRET = JWT_SECRET_RAW;

const TOKEN_TTL_SECONDS = 60 * 60; // 1 小时
const PASSWORD_RATE_LIMIT_PER_MIN = 10; // 每个 IP 每分钟最多 10 次密码尝试

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info, X-Paid-Area-Token',
  'Access-Control-Max-Age': '86400',
};

function cors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------- Web Crypto helpers ----------
function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const km = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', km, new TextEncoder().encode(data)));
}

async function signToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'PAID-AREA' };
  const payload = {
    sub: 'paid-area',
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const hb = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const pb = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256(JWT_SECRET, `${hb}.${pb}`);
  return `${hb}.${pb}.${base64urlEncode(sig)}`;
}

export async function verifyPaidAreaToken(token: string): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [hb, pb, sb] = parts;
  const expected = await hmacSha256(JWT_SECRET, `${hb}.${pb}`);
  const provided = base64urlDecode(sb);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(pb)));
    if (payload.sub !== 'paid-area') return false;
    if (!payload.exp || Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- Password verification ----------
async function getPasswordHash(supabase: ReturnType<typeof createServiceClient>): Promise<string | null> {
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', 'paid_area_password_hash')
    .maybeSingle();
  if (error) {
    console.error('读取付费区密码哈希失败:', error);
    return null;
  }
  return data?.value || null;
}

async function checkPassword(supabase: ReturnType<typeof createServiceClient>, password: string): Promise<boolean> {
  const hash = await getPasswordHash(supabase);
  if (!hash) return false;
  // bcryptjs.compareSync 是同步的，避免回调地狱
  return bcrypt.compareSync(password, hash);
}

// ---------- Handlers ----------
async function handleVerify(req: Request, supabase: ReturnType<typeof createServiceClient>) {
  let body: { password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors({ error: '请求体必须是 JSON' }, 400);
  }
  const password = (body.password || '').toString();
  if (!password) return cors({ error: '请输入密码' }, 400);

  const hash = await getPasswordHash(supabase);
  if (!hash) return cors({ error: '付费区尚未配置密码，请联系管理员' }, 503);

  const ok = await checkPassword(supabase, password);
  if (!ok) {
    return cors({ error: '密码错误' }, 401);
  }

  const token = await signToken();
  return cors({ success: true, token, expires_in: TOKEN_TTL_SECONDS });
}

async function handleRefresh(req: Request) {
  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors({ error: '请求体必须是 JSON' }, 400);
  }
  const token = (body.token || '').toString();
  if (!token) return cors({ error: '缺少 token' }, 400);
  const valid = await verifyPaidAreaToken(token);
  if (!valid) return cors({ error: 'token 无效或已过期' }, 401);
  const newToken = await signToken();
  return cors({ success: true, token: newToken, expires_in: TOKEN_TTL_SECONDS });
}

async function handleStatus(supabase: ReturnType<typeof createServiceClient>) {
  const hash = await getPasswordHash(supabase);
  return cors({ success: true, configured: !!hash });
}

// ---------- Main ----------
Deno.serve(async (req) => {
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return cors({ error: '仅支持 GET/POST' }, 405);
  }

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';

  // 密码尝试限流（比通用限流更严格）
  const rl = checkRateLimit(`paid-area-auth:${clientIp}`, PASSWORD_RATE_LIMIT_PER_MIN, 60_000);
  if (!rl.allowed) {
    return cors({ error: '尝试次数过多，请稍后再试' }, 429);
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/.*\/paid-area-auth\/?/, '').split('/').filter(Boolean);
  const supabase = createServiceClient();

  try {
    if (req.method === 'POST' && parts[0] === 'verify') {
      return await handleVerify(req, supabase);
    }
    if (req.method === 'POST' && parts[0] === 'refresh') {
      return await handleRefresh(req);
    }
    if (req.method === 'GET' && (parts[0] === 'status' || parts.length === 0)) {
      return await handleStatus(supabase);
    }
    return cors({ error: '未知接口' }, 404);
  } catch (err) {
    console.error('paid-area-auth 错误:', err);
    return cors({ error: '服务器内部错误' }, 500);
  }
});

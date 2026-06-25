// ============================
// auth-api Edge Function
// 控制层：路由分发、参数校验、限流
// 业务层：注册、登录、查询当前用户、修改密码、退出登录
// 数据层：通过 Service Role 操作 PostgreSQL users / auth_sessions
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info, X-Client-Token',
  'Access-Control-Max-Age': '86400',
};
function createCorsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
function createErrorResponse(message, status = 400) {
  return createCorsResponse({ error: message }, status);
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const AUTH_SECRET = Deno.env.get('AUTH_SECRET') || 'shungxin_auth_secret_2024_change_in_prod';
const TOKEN_TTL_DAYS = 7;

function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ============================
// 工具：密码哈希 (PBKDF2-SHA256)
// ============================
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================
// 工具：Token 签发/校验 (HMAC-SHA256)
// ============================
function base64urlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8ToBytes(s) { return new TextEncoder().encode(s); }
function bytesToUtf8(b) { return new TextDecoder().decode(b); }

async function hmacSha256(key, data) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? utf8ToBytes(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, utf8ToBytes(data));
  return new Uint8Array(sig);
}

async function signToken(payload) {
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(utf8ToBytes(json));
  const signature = await hmacSha256(AUTH_SECRET, payloadB64);
  const sigB64 = base64urlEncode(signature);
  return `${payloadB64}.${sigB64}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const expectedSig = await hmacSha256(AUTH_SECRET, payloadB64);
  const providedSig = base64urlDecode(sigB64);
  if (expectedSig.length !== providedSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ providedSig[i];
  if (diff !== 0) return null;

  let payload;
  try { payload = JSON.parse(bytesToUtf8(base64urlDecode(payloadB64))); }
  catch { return null; }

  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

async function hashToken(token) {
  const bytes = utf8ToBytes(token);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return base64urlEncode(new Uint8Array(hash));
}

// ============================
// 限流
// ============================
const rateLimitStore = new Map();
function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxRequests - 1, resetAt };
  }
  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

// ============================
// 验证：用户名/密码
// ============================
function validateUsername(u) {
  if (!u || typeof u !== 'string') return '用户名不能为空';
  if (u.length < 3) return '用户名至少3个字符';
  if (u.length > 32) return '用户名最多32个字符';
  if (!/^[a-zA-Z0-9_\-.\u4e00-\u9fa5]+$/.test(u)) return '用户名仅支持字母/数字/_-. 或中文';
  return null;
}
function validatePassword(p) {
  if (!p || typeof p !== 'string') return '密码不能为空';
  if (p.length < 6) return '密码至少6个字符';
  if (p.length > 128) return '密码最多128个字符';
  return null;
}

// ============================
// 入口
// ============================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/auth-api\/?/, '') || 'me';

  try {
    switch (path) {
      case 'register': return await handleRegister(req);
      case 'login':    return await handleLogin(req);
      case 'logout':   return await handleLogout(req);
      case 'me':       return await handleMe(req);
      case 'change-password': return await handleChangePassword(req);
      case 'check-username':  return await handleCheckUsername(url);
      default: return createErrorResponse('未知接口', 404);
    }
  } catch (err) {
    console.error('auth-api 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

async function handleRegister(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { username, password, display_name } = body;
  const ue = validateUsername(username);
  if (ue) return createErrorResponse(ue, 400);
  const pe = validatePassword(password);
  if (pe) return createErrorResponse(pe, 400);

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateCheck = checkRateLimit(`register:${clientIp}`, 5, 60_000);
  if (!rateCheck.allowed) {
    return createErrorResponse(`注册过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  const supabase = createServiceClient();
  const { data: existing } = await supabase
    .from('users').select('id').eq('username', username).maybeSingle();
  if (existing) return createErrorResponse('用户名已被占用', 409);

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const { data: user, error } = await supabase.from('users').insert({
    username,
    password_hash: passwordHash,
    salt,
    display_name: display_name || username,
    role: 'user',
  }).select('id, username, display_name, avatar, role, created_at').single();
  if (error) {
    console.error('创建用户失败:', error);
    return createErrorResponse('注册失败，请稍后重试', 500);
  }

  const token = await issueToken(supabase, user, req);
  return createCorsResponse({
    success: true, message: '注册成功',
    user, token,
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  }, 201);
}

async function handleLogin(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { username, password } = body;
  if (!username || !password) return createErrorResponse('用户名和密码不能为空', 400);

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateCheck = checkRateLimit(`login:${clientIp}:${username}`, 10, 60_000);
  if (!rateCheck.allowed) {
    return createErrorResponse(`登录过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  const supabase = createServiceClient();
  const { data: row, error } = await supabase
    .from('users')
    .select('id, username, display_name, avatar, role, password_hash, salt, is_active')
    .eq('username', username).maybeSingle();
  if (error) { console.error('查询用户失败:', error); return createErrorResponse('登录失败', 500); }
  if (!row) return createErrorResponse('用户名或密码错误', 401);
  if (!row.is_active) return createErrorResponse('账号已被禁用', 403);

  const expected = await hashPassword(password, row.salt);
  if (expected !== row.password_hash) return createErrorResponse('用户名或密码错误', 401);

  await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', row.id);

  const user = {
    id: row.id, username: row.username, display_name: row.display_name,
    avatar: row.avatar, role: row.role,
  };
  const token = await issueToken(supabase, user, req);
  return createCorsResponse({
    success: true, message: '登录成功',
    user, token,
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  });
}

async function handleLogout(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (token) {
    const tokenHash = await hashToken(token);
    const supabase = createServiceClient();
    await supabase.from('auth_sessions').delete().eq('token_hash', tokenHash);
  }
  return createCorsResponse({ success: true, message: '已退出登录' });
}

async function handleMe(req) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  return createCorsResponse({ success: true, user: auth.user });
}

async function handleChangePassword(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }
  const { old_password, new_password } = body;
  const pe = validatePassword(new_password);
  if (pe) return createErrorResponse(pe, 400);
  if (!old_password) return createErrorResponse('原密码不能为空', 400);

  const supabase = createServiceClient();
  const { data: row, error } = await supabase
    .from('users').select('id, password_hash, salt')
    .eq('id', auth.user.id).maybeSingle();
  if (error || !row) return createErrorResponse('用户不存在', 404);

  const expected = await hashPassword(old_password, row.salt);
  if (expected !== row.password_hash) return createErrorResponse('原密码错误', 401);

  const newSalt = generateSalt();
  const newHash = await hashPassword(new_password, newSalt);
  const { error: updErr } = await supabase.from('users')
    .update({ password_hash: newHash, salt: newSalt }).eq('id', row.id);
  if (updErr) { console.error('更新密码失败:', updErr); return createErrorResponse('更新失败', 500); }

  // 吊销该用户所有 token
  await supabase.from('auth_sessions').delete().eq('user_id', row.id);

  return createCorsResponse({ success: true, message: '密码已更新，请重新登录' });
}

async function handleCheckUsername(url) {
  const username = url.searchParams.get('username') || '';
  const ue = validateUsername(username);
  if (ue) return createCorsResponse({ success: true, available: false, reason: ue });

  const supabase = createServiceClient();
  const { data } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  return createCorsResponse({ success: true, available: !data });
}

// ============================
// Token 签发 + 验证工具
// ============================
async function issueToken(supabase, user, req) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_DAYS * 24 * 60 * 60;
  const token = await signToken({
    sub: user.id, username: user.username, role: user.role,
    iat: now, exp, v: 1,
  });
  const tokenHash = await hashToken(token);
  await supabase.from('auth_sessions').insert({
    user_id: user.id, token_hash: tokenHash,
    expires_at: new Date(exp * 1000).toISOString(),
    ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null,
    user_agent: req.headers.get('user-agent') || null,
  }).then(() => {}).catch((e) => console.warn('记录 session 失败:', e));
  return token;
}

async function requireAuth(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: createErrorResponse('未登录', 401) };

  const payload = await verifyToken(token);
  if (!payload) return { error: createErrorResponse('Token 无效或已过期', 401) };

  const supabase = createServiceClient();
  const tokenHash = await hashToken(token);
  const { data: session } = await supabase
    .from('auth_sessions').select('id, expires_at')
    .eq('token_hash', tokenHash).maybeSingle();
  if (!session) return { error: createErrorResponse('Token 已失效', 401) };
  if (new Date(session.expires_at) < new Date()) {
    await supabase.from('auth_sessions').delete().eq('id', session.id);
    return { error: createErrorResponse('Token 已过期', 401) };
  }

  const { data: row } = await supabase
    .from('users').select('id, username, display_name, avatar, role, is_active')
    .eq('id', payload.sub).maybeSingle();
  if (!row || !row.is_active) return { error: createErrorResponse('账号已被禁用', 403) };

  return { user: {
    id: row.id, username: row.username, display_name: row.display_name,
    avatar: row.avatar, role: row.role,
  }};
}

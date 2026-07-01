// ============================
// auth-api Edge Function
// 控制层：路由分发、参数校验、限流
// 业务层：注册、登录、查询当前用户、修改密码、退出登录
// 数据层：通过 Service Role 操作 PostgreSQL users / auth_sessions
// ============================

import { verifyOrigin } from '../_shared/originGuard.ts';
import { getSiteSettings, parseBool } from '../_shared/siteSettings.ts';
import { sendNotificationEmail } from '../_shared/emailNotifier.ts';
import { CORS_HEADERS, createCorsResponse, createErrorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabaseClient.ts';
import { signToken, verifyToken, hashToken } from '../_shared/token.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';

const TOKEN_TTL_DAYS = 7;

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
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

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
  }).select('id, uid, username, display_name, avatar, role, created_at').single();
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
    .select('id, uid, username, display_name, avatar, role, password_hash, salt, is_active')
    .eq('username', username).maybeSingle();
  if (error) { console.error('查询用户失败:', error); return createErrorResponse('登录失败', 500); }
  if (!row) return createErrorResponse('用户名或密码错误', 401);
  if (!row.is_active) return createErrorResponse('账号已被禁用', 403);

  const expected = await hashPassword(password, row.salt);
  if (expected !== row.password_hash) return createErrorResponse('用户名或密码错误', 401);

  await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', row.id);

  const user = {
    id: row.id, uid: row.uid, username: row.username, display_name: row.display_name,
    avatar: row.avatar, role: row.role,
  };
  const token = await issueToken(supabase, user, req);

  // 异常登录检测与邮件通知
  try {
    await detectAbnormalLoginAndNotify(supabase, row, req);
  } catch (e) {
    console.warn('异常登录检测失败:', e);
  }

  return createCorsResponse({
    success: true, message: '登录成功',
    user, token,
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  });
}

async function detectAbnormalLoginAndNotify(supabase, user, req) {
  const settings = await getSiteSettings(supabase, [
    'site_name',
    'notify_on_abnormal_login',
  ]);
  if (!parseBool(settings.notify_on_abnormal_login)) return;

  const currentIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  // 取该用户最近一次成功登录的 session IP 做对比(排除当前这次)
  const { data: lastSessions } = await supabase
    .from('auth_sessions')
    .select('ip, user_agent, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(1, 2);

  let abnormal = false;
  let reason = '';
  if (!lastSessions || lastSessions.length === 0) {
    // 首次登录不告警
    return;
  }
  const last = lastSessions[0];
  if (last.ip && last.ip !== currentIp) {
    abnormal = true;
    reason = `IP 发生变化(上次: ${last.ip}, 本次: ${currentIp})`;
  }

  if (abnormal) {
    await sendNotificationEmail(supabase, {
      subject: `[${settings.site_name || '站点'}] 账号异常登录提醒`,
      text: `用户: ${user.username}\n时间: ${new Date().toISOString()}\n${reason}\nUA: ${userAgent}\n如非本人操作,请尽快修改密码并检查账号安全。`,
      tags: ['abnormal_login'],
    });
  }
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
    sub: user.id, uid: user.uid, username: user.username, role: user.role,
    iat: now, exp, v: 1,
  });
  const tokenHash = await hashToken(token);
  // 修复: 不能再用 .then().catch() 吞掉错误,
  // 否则 session 没写入但 token 已返回,前端拿到的 token 立刻 requireAuth 401
  const { error: sessError } = await supabase.from('auth_sessions').insert({
    user_id: user.id, token_hash: tokenHash,
    expires_at: new Date(exp * 1000).toISOString(),
    ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null,
    user_agent: req.headers.get('user-agent') || null,
  });
  if (sessError) {
    console.error('记录 session 失败:', sessError);
    throw new Error('服务端 session 持久化失败,无法签发 token');
  }
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
    .from('users').select('id, uid, username, display_name, avatar, role, is_active')
    .eq('id', payload.sub).maybeSingle();
  if (!row || !row.is_active) return { error: createErrorResponse('账号已被禁用', 403) };

  return { user: {
    id: row.id, uid: row.uid, username: row.username, display_name: row.display_name,
    avatar: row.avatar, role: row.role,
  }};
}

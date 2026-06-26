// ============================
// admin-api Edge Function
// 控制层：路由分发、参数校验、限流、admin 鉴权
// 业务层：仪表板统计、用户管理、评论管理、图片管理、审计日志
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { verifyOrigin } from '../_shared/originGuard.ts';
import { safeParseInt } from '../_shared/safeParams.ts';

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
const AUTH_SECRET_RAW = Deno.env.get('AUTH_SECRET');
if (!AUTH_SECRET_RAW || AUTH_SECRET_RAW.length < 32) {
  throw new Error('AUTH_SECRET 环境变量未设置或长度不足 32 字符');
}
const AUTH_SECRET = AUTH_SECRET_RAW;
const TOKEN_TTL_DAYS = 7;

function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ============================
// Token 工具(复用 auth-api 的 HMAC-SHA256 签发)
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
  return new Uint8Array(await crypto.subtle.sign('HMAC', keyMaterial, utf8ToBytes(data)));
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
// 鉴权：要求 Bearer Token + role=admin
// ============================
async function requireAdmin(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: createErrorResponse('未登录', 401) };

  const payload = await verifyToken(token);
  if (!payload) return { error: createErrorResponse('Token 无效或已过期', 401) };

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('users')
    .select('id, username, display_name, role, is_active')
    .eq('id', payload.sub)
    .maybeSingle();

  if (!row) return { error: createErrorResponse('用户不存在', 401) };
  if (!row.is_active) return { error: createErrorResponse('账号已被禁用', 403) };
  if (row.role !== 'admin') return { error: createErrorResponse('需要管理员权限', 403) };

  return { user: row, token };
}

// ============================
// 审计日志
// ============================
async function logAudit(supabase, ctx, action, targetType, targetId, details) {
  try {
    await supabase.from('admin_audit_logs').insert({
      admin_id: ctx.user.id,
      admin_name: ctx.user.display_name || ctx.user.username,
      action, target_type: targetType, target_id: String(targetId),
      details: details || null,
      ip: ctx.ip || null,
      user_agent: ctx.userAgent || null,
    });
  } catch (e) { console.warn('审计日志写入失败:', e); }
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
  // 路径解析: /admin-api/<section>/<id>[/<action>]
  const parts = url.pathname.replace(/.*\/admin-api\/?/, '').split('/').filter(Boolean);

  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';
  const ctx = { ip, userAgent };

  try {
    // 健康检查(免鉴权,便于监控)
    if (parts[0] === 'health' && req.method === 'GET') {
      return createCorsResponse({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
    }

    // 路由分发
    const section = parts[0];
    const id = parts[1];
    const subAction = parts[2];

    // 所有管理接口都需要 admin 鉴权
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    ctx.user = auth.user;

    // 接口级限流 (每 IP 60 次/分钟)
    const rl = checkRateLimit(`admin:${ip}`, 60, 60_000);
    if (!rl.allowed) return createErrorResponse('请求过于频繁', 429);

    const supabase = createServiceClient();

    switch (section) {
      case 'dashboard':
        if (req.method !== 'GET') return createErrorResponse('仅支持 GET', 405);
        return await handleDashboard(supabase);

      case 'users':
        if (req.method === 'GET' && !id) return await handleListUsers(supabase, url);
        if (req.method === 'GET' && id)  return await handleGetUser(supabase, id);
        if (req.method === 'POST' && id === 'batch') return await handleBatchUsers(supabase, ctx, req);
        if (req.method === 'PUT' && id && subAction === 'status') return await handleUpdateUserStatus(supabase, ctx, req, id);
        if (req.method === 'PUT' && id && subAction === 'role')   return await handleUpdateUserRole(supabase, ctx, req, id);
        if (req.method === 'DELETE' && id) return await handleDeleteUser(supabase, ctx, id);
        return createErrorResponse('未知接口', 404);

      case 'comments':
        if (req.method === 'GET' && !id) return await handleListComments(supabase, url);
        if (req.method === 'POST' && id === 'batch') return await handleBatchComments(supabase, ctx, req);
        if (req.method === 'DELETE' && id) return await handleDeleteComment(supabase, ctx, id);
        return createErrorResponse('未知接口', 404);

      case 'images':
        if (req.method === 'GET' && !id) return await handleListImages(supabase);
        if (req.method === 'POST' && id === 'batch') return await handleBatchImages(supabase, ctx, req);
        if (req.method === 'PUT' && id && subAction === 'visibility') return await handleToggleImageVisibility(supabase, ctx, req, id);
        if (req.method === 'PUT' && id && subAction === 'meta')        return await handleUpdateImageMeta(supabase, ctx, req, id);
        if (req.method === 'DELETE' && id) return await handleDeleteImage(supabase, ctx, id);
        return createErrorResponse('未知接口', 404);

      case 'audit-logs':
        if (req.method !== 'GET') return createErrorResponse('仅支持 GET', 405);
        return await handleListAuditLogs(supabase, url);

      default:
        return createErrorResponse('未知接口', 404);
    }
  } catch (err) {
    console.error('admin-api 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

// ============================
// 仪表板
// ============================
async function handleDashboard(supabase) {
  // 并行查询
  const [usersR, activeUsersR, newUsersTodayR, newUsersWeekR,
         commentsR, pendingCommentsR, commentsTodayR,
         imagesR, visibleImagesR,
         likesR, likesTodayR, viewsR, viewsTodayR] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('users').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
    supabase.from('users').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from('comments').select('id', { count: 'exact', head: true }),
    supabase.from('comments').select('id', { count: 'exact', head: true }).neq('status', 'approved'),
    supabase.from('comments').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
    supabase.from('gallery_images').select('id', { count: 'exact', head: true }),
    supabase.from('gallery_images').select('id', { count: 'exact', head: true }).eq('is_visible', true),
    supabase.from('likes').select('id', { count: 'exact', head: true }),
    supabase.from('likes').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
    supabase.from('image_views').select('count'),
    supabase.from('image_views').select('image_id, count')
      .gte('updated_at', new Date(new Date().setHours(0,0,0,0)).toISOString()),
  ]);

  // 浏览量合计(从每张图的 count 字段求和)
  const totalViews = (viewsR.data || []).reduce((s, r) => s + (r.count || 0), 0);
  const todayViews = (viewsTodayR.data || []).reduce((s, r) => s + (r.count || 0), 0);

  // 7 天用户增长趋势
  const trendStart = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  trendStart.setHours(0, 0, 0, 0);
  const { data: rawTrend } = await supabase
    .from('users')
    .select('created_at')
    .gte('created_at', trendStart.toISOString());
  const dayBuckets = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(trendStart);
    d.setDate(d.getDate() + i);
    dayBuckets[d.toISOString().slice(0, 10)] = 0;
  }
  (rawTrend || []).forEach((r) => {
    const k = r.created_at.slice(0, 10);
    if (k in dayBuckets) dayBuckets[k]++;
  });
  const userGrowth7d = Object.entries(dayBuckets).map(([date, count]) => ({ date, count }));

  return createCorsResponse({
    success: true,
    data: {
      users: {
        total: usersR.count || 0,
        active: activeUsersR.count || 0,
        new_today: newUsersTodayR.count || 0,
        new_7d: newUsersWeekR.count || 0,
      },
      comments: {
        total: commentsR.count || 0,
        pending: pendingCommentsR.count || 0,
        today: commentsTodayR.count || 0,
      },
      images: {
        total: imagesR.count || 0,
        visible: visibleImagesR.count || 0,
      },
      likes: {
        total: likesR.count || 0,
        today: likesTodayR.count || 0,
      },
      views: {
        total: totalViews,
        today: todayViews,
      },
      user_growth_7d: userGrowth7d,
      generated_at: new Date().toISOString(),
    },
  });
}

// ============================
// 用户管理
// ============================
async function handleListUsers(supabase, url) {
  // 修复: 防御 NaN 攻击
  const page = safeParseInt(url.searchParams.get('page'), 1, 1);
  const pageSize = safeParseInt(url.searchParams.get('pageSize'), 20, 1, 100);
  const search = (url.searchParams.get('search') || '').trim();
  const role = url.searchParams.get('role') || '';
  const status = url.searchParams.get('status') || '';  // active | inactive | ''

  // 修复: 防御 PostgREST .or() 注入
  // 用户可在 search 里塞 `%,is_active.eq.true` 等字符,改变过滤范围
  // 需要转义 PostgREST 特殊字符: `,`、`.`、`(`、`)`
  const safeSearch = search
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/\./g, '\\.')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // ilike 通配符也需转义,避免 %foo% 行为异常
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');

  let q = supabase.from('users')
    .select('id, username, display_name, avatar, role, is_active, created_at, last_login_at', { count: 'exact' })
    .order('created_at', { ascending: false });
  if (safeSearch) q = q.or(`username.ilike.%${safeSearch}%,display_name.ilike.%${safeSearch}%`);
  if (role)   q = q.eq('role', role);
  if (status === 'active')   q = q.eq('is_active', true);
  if (status === 'inactive') q = q.eq('is_active', false);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  q = q.range(from, to);

  const { data, count, error } = await q;
  if (error) { console.error('查询用户失败:', error); return createErrorResponse('查询失败', 500); }

  return createCorsResponse({
    success: true,
    data: { users: data || [], total: count || 0, page, pageSize },
  });
}

async function handleGetUser(supabase, id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name, avatar, role, is_active, created_at, last_login_at')
    .eq('id', id).maybeSingle();
  if (error) return createErrorResponse('查询失败', 500);
  if (!data) return createErrorResponse('用户不存在', 404);
  return createCorsResponse({ success: true, data });
}

async function handleUpdateUserStatus(supabase, ctx, req, id) {
  const { is_active } = await req.json();
  if (typeof is_active !== 'boolean') return createErrorResponse('is_active 必须是 boolean', 400);

  // 防止管理员禁用自己
  if (String(ctx.user.id) === String(id) && is_active === false) {
    return createErrorResponse('不能禁用自己的账号', 400);
  }

  const { data, error } = await supabase
    .from('users').update({ is_active })
    .eq('id', id)
    .select('id, username, is_active').maybeSingle();
  if (error) return createErrorResponse('更新失败', 500);
  if (!data) return createErrorResponse('用户不存在', 404);

  await logAudit(supabase, ctx, is_active ? 'users.enable' : 'users.disable', 'user', id,
    { username: data.username });

  return createCorsResponse({ success: true, data });
}

async function handleUpdateUserRole(supabase, ctx, req, id) {
  const { role } = await req.json();
  if (!['user', 'admin'].includes(role)) return createErrorResponse('role 必须为 user 或 admin', 400);

  // 防止管理员降级自己
  if (String(ctx.user.id) === String(id) && role === 'user') {
    return createErrorResponse('不能降级自己的管理员权限', 400);
  }

  const { data, error } = await supabase
    .from('users').update({ role })
    .eq('id', id)
    .select('id, username, role').maybeSingle();
  if (error) return createErrorResponse('更新失败', 500);
  if (!data) return createErrorResponse('用户不存在', 404);

  await logAudit(supabase, ctx, role === 'admin' ? 'users.promote' : 'users.demote', 'user', id,
    { username: data.username, new_role: role });

  return createCorsResponse({ success: true, data });
}

async function handleDeleteUser(supabase, ctx, id) {
  if (String(ctx.user.id) === String(id)) {
    return createErrorResponse('不能删除自己的账号', 400);
  }
  const { data: target } = await supabase
    .from('users').select('id, username').eq('id', id).maybeSingle();
  if (!target) return createErrorResponse('用户不存在', 404);

  // 先吊销其所有 session
  await supabase.from('auth_sessions').delete().eq('user_id', id);
  const { error } = await supabase.from('users').delete().eq('id', id);
  if (error) return createErrorResponse('删除失败', 500);

  await logAudit(supabase, ctx, 'users.delete', 'user', id,
    { username: target.username });

  return createCorsResponse({ success: true, message: '用户已删除' });
}

// ============================
// 评论管理
// ============================
async function handleListComments(supabase, url) {
  // 修复: 防御 NaN
  const page = safeParseInt(url.searchParams.get('page'), 1, 1);
  const pageSize = safeParseInt(url.searchParams.get('pageSize'), 20, 1, 100);
  const status = url.searchParams.get('status') || '';
  const search = (url.searchParams.get('search') || '').trim();

  let q = supabase.from('comments')
    .select('id, content, github_username, github_avatar, status, source, image_id, created_at, user_id, parent_id, rating',
      { count: 'exact' })
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (search) q = q.ilike('content', `%${search}%`);
  const from = (page - 1) * pageSize;
  q = q.range(from, from + pageSize - 1);

  const { data, count, error } = await q;
  if (error) { console.error('查询评论失败:', error); return createCorsResponse({ error: '查询失败', detail: error.message || String(error) }, 500); }

  // 关联用户名
  const userIds = [...new Set((data || []).map(c => c.user_id).filter(Boolean))];
  let userMap = {};
  if (userIds.length > 0) {
    const { data: users, error: uerr } = await supabase
      .from('users')
      .select('id, username, display_name, avatar')
      .in('id', userIds);
    if (uerr) { console.error('关联 users 失败:', uerr); return createCorsResponse({ error: '关联用户失败', detail: uerr.message || String(uerr) }, 500); }
    (users || []).forEach(u => { userMap[u.id] = u; });
  }
  const enriched = (data || []).map(c => ({
    ...c,
    user: c.user_id ? userMap[c.user_id] : null,
  }));

  return createCorsResponse({
    success: true,
    data: { comments: enriched, total: count || 0, page, pageSize },
  });
}

async function handleDeleteComment(supabase, ctx, id) {
  const { data: target } = await supabase
    .from('comments').select('id, content, github_username').eq('id', id).maybeSingle();
  if (!target) return createErrorResponse('评论不存在', 404);

  const { error } = await supabase.from('comments').delete().eq('id', id);
  if (error) return createErrorResponse('删除失败', 500);

  await logAudit(supabase, ctx, 'comments.delete', 'comment', id,
    { author: target.github_username, preview: (target.content || '').slice(0, 50) });

  return createCorsResponse({ success: true, message: '评论已删除' });
}

// ============================
// 图片管理
// ============================
async function handleListImages(supabase) {
  // 主列表
  // 兼容老 schema: 用 * 查询,代码里做 null 处理
  const { data: images, error } = await supabase
    .from('gallery_images')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) { console.error('查询图片失败:', error); return createErrorResponse('查询失败', 500); }

  // 关联点赞数
  const { data: likes } = await supabase.from('image_likes').select('image_id, count');
  const { data: views } = await supabase.from('image_views').select('image_id, count');
  const likeMap = {}; (likes || []).forEach(l => { likeMap[l.image_id] = l.count; });
  const viewMap = {}; (views || []).forEach(v => { viewMap[v.image_id] = v.count; });

  const enriched = (images || []).map(img => ({
    ...img,
    like_count: likeMap[img.id] || 0,
    view_count: viewMap[img.id] || 0,
    // 新图(有 storage_path)用 Supabase 公开 URL
    // 老图(无 storage_path)继续用本地 images/<filename>
    src: img.storage_path
      ? `${SUPABASE_URL}/storage/v1/object/public/${img.storage_bucket || 'gallery-images'}/${img.storage_path}`
      : 'images/' + img.filename,
  }));

  return createCorsResponse({ success: true, data: { images: enriched } });
}

async function handleToggleImageVisibility(supabase, ctx, req, id) {
  const { is_visible } = await req.json();
  if (typeof is_visible !== 'boolean') return createErrorResponse('is_visible 必须是 boolean', 400);

  const { data, error } = await supabase
    .from('gallery_images').update({ is_visible, updated_at: new Date().toISOString() })
    .eq('id', id).select('id, filename, is_visible').maybeSingle();
  if (error) return createErrorResponse('更新失败', 500);
  if (!data) return createErrorResponse('图片不存在', 404);

  await logAudit(supabase, ctx, is_visible ? 'images.show' : 'images.hide', 'image', id,
    { filename: data.filename });

  return createCorsResponse({ success: true, data });
}

async function handleUpdateImageMeta(supabase, ctx, req, id) {
  const { title, category, is_new, sort_order, description } = await req.json();
  const update = { updated_at: new Date().toISOString() };
  if (typeof title === 'string')        update.title = title.slice(0, 128);
  if (typeof category === 'string')     update.category = category.slice(0, 32);
  if (typeof is_new === 'boolean')      update.is_new = is_new;
  if (Number.isInteger(sort_order))     update.sort_order = sort_order;
  if (typeof description === 'string')  update.description = description;

  const { data, error } = await supabase
    .from('gallery_images').update(update)
    .eq('id', id).select('*').maybeSingle();
  if (error) return createErrorResponse('更新失败', 500);
  if (!data) return createErrorResponse('图片不存在', 404);

  await logAudit(supabase, ctx, 'images.update', 'image', id,
    { filename: data.filename, changes: Object.keys(update).filter(k => k !== 'updated_at') });

  return createCorsResponse({ success: true, data });
}

// ============================
// 删除图片(单图) - 同时删除数据库记录和 storage 文件
// ============================
async function handleDeleteImage(supabase, ctx, id) {
  // 1. 先查询拿到 storage_path(用于删除 storage 文件)
  const { data: target, error: fetchErr } = await supabase
    .from('gallery_images')
    .select('id, filename, storage_path, storage_bucket, is_visible, uploaded_by')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) { console.error('查询图片失败:', fetchErr); return createErrorResponse('查询失败', 500); }
  if (!target) return createErrorResponse('图片不存在', 404);

  // 2. 删数据库记录(级联: likes/views/comments 是手动级联 - 见下方)
  // 先删依赖表(likes / views / comments),避免外键引用
  const tblAndCol = {
    image_likes: 'image_id',
    image_views: 'image_id',
  };
  for (const [tbl, col] of Object.entries(tblAndCol)) {
    const { error: delErr } = await supabase.from(tbl).delete().eq(col, id);
    if (delErr) console.warn(`删除 ${tbl} 时警告(可忽略):`, delErr.message);
  }
  // comments 表有 image_id 字段,但可能没 ON DELETE CASCADE,需手动清理
  // (comment-api 的 image_id 是普通整数,无外键,直接删)
  const { error: cmtErr } = await supabase.from('comments').delete().eq('image_id', id);
  if (cmtErr) console.warn('删除关联评论警告(可忽略):', cmtErr.message);

  // 3. 删主表
  const { error: delRowErr } = await supabase.from('gallery_images').delete().eq('id', id);
  if (delRowErr) { console.error('删除图片记录失败:', delRowErr); return createErrorResponse('删除失败: ' + delRowErr.message, 500); }

  // 4. 删 storage 文件(如果是 storage 上传的新图)
  // 老图(没 storage_path)这一步跳过
  if (target.storage_path) {
    const { error: stoErr } = await supabase.storage
      .from(target.storage_bucket || 'gallery-images')
      .remove([target.storage_path]);
    if (stoErr) console.warn('删除 storage 文件警告(可忽略):', stoErr.message);
  }

  // 5. 审计
  await logAudit(supabase, ctx, 'images.delete', 'image', id, {
    filename: target.filename,
    storage_path: target.storage_path || null,
    was_visible: target.is_visible,
    was_user_upload: target.uploaded_by != null,
  });

  return createCorsResponse({ success: true, message: '图片已删除' });
}

// ============================
// 审计日志
// ============================
async function handleListAuditLogs(supabase, url) {
  // 修复: 防御 NaN
  const page = safeParseInt(url.searchParams.get('page'), 1, 1);
  const pageSize = safeParseInt(url.searchParams.get('pageSize'), 20, 1, 100);
  const action = url.searchParams.get('action') || '';
  const adminId = url.searchParams.get('admin_id') || '';

  let q = supabase.from('admin_audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });
  // 支持 "users.batch_" 这种前缀匹配(以前只能完全等值)
  if (action) {
    if (action.endsWith('*')) {
      q = q.like('action', action.slice(0, -1) + '%');
    } else {
      q = q.eq('action', action);
    }
  }
  if (adminId) q = q.eq('admin_id', adminId);
  const from = (page - 1) * pageSize;
  q = q.range(from, from + pageSize - 1);

  const { data, count, error } = await q;
  if (error) return createErrorResponse('查询失败', 500);
  return createCorsResponse({
    success: true,
    data: { logs: data || [], total: count || 0, page, pageSize },
  });
}

// ============================
// 批量操作
// ============================
//
// 通用结构：POST /admin-api/<section>/batch
// body: { action: string, ids: (string|number)[] }
//
// action 取值：
//   users:    enable | disable | set_role_user | set_role_admin | delete
//   images:   show | hide | set_new | unset_new | set_category | delete
//   comments: delete | approve | reject
//
// 返回：
//   { success: true, data: { affected: number, skipped: string[] } }
//

// 单次批量上限(防止请求过大 / RPC 超时)
const BATCH_LIMIT = 200;

async function handleBatchUsers(supabase, ctx, req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST', 405);
  const body = await req.json().catch(() => null);
  if (!body) return createErrorResponse('请求体必须是 JSON', 400);
  const { action, ids, role } = body;
  if (!Array.isArray(ids) || ids.length === 0) return createErrorResponse('ids 必须是非空数组', 400);
  if (ids.length > BATCH_LIMIT) return createErrorResponse(`单次最多 ${BATCH_LIMIT} 个`, 400);
  if (!ids.every(x => Number.isInteger(x) || /^\d+$/.test(String(x)))) return createErrorResponse('ids 必须为数字', 400);
  const idList = ids.map(x => Number(x));

  // 保护: 防止操作自己
  const selfId = Number(ctx.user.id);
  const skipped = [];
  const targets = idList.filter(id => {
    if (id === selfId && (action === 'disable' || action === 'set_role_user' || action === 'delete')) {
      skipped.push(String(id));
      return false;
    }
    return true;
  });
  if (targets.length === 0) {
    return createCorsResponse({ success: true, data: { affected: 0, skipped, reason: '无可操作目标' } });
  }

  const validActions = ['enable', 'disable', 'set_role_user', 'set_role_admin', 'delete'];
  if (!validActions.includes(action)) return createErrorResponse('不支持的 action', 400);

  let update = null;
  let doDelete = false;
  if (action === 'enable')  update = { is_active: true };
  if (action === 'disable') update = { is_active: false };
  if (action === 'set_role_user')   update = { role: 'user' };
  if (action === 'set_role_admin')  update = { role: 'admin' };
  if (action === 'delete') doDelete = true;

  let affectedCount = 0;
  if (doDelete) {
    // 先吊销其所有 session
    await supabase.from('auth_sessions').delete().in('user_id', targets);
    const res = await supabase.from('users').delete().in('id', targets).select('id');
    if (res.error) { console.error('批量删除用户失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  } else {
    const res = await supabase.from('users').update(update).in('id', targets).select('id');
    if (res.error) { console.error('批量更新用户失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  }

  // 写一条总览审计(便于审计查询)
  await logAudit(supabase, ctx, 'users.batch_' + action, 'user', 'batch', {
    action, count: affectedCount, target_ids: targets, skipped,
  });

  return createCorsResponse({
    success: true,
    data: { affected: affectedCount, skipped, requested: idList.length },
  });
}

async function handleBatchImages(supabase, ctx, req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST', 405);
  const body = await req.json().catch(() => null);
  if (!body) return createErrorResponse('请求体必须是 JSON', 400);
  const { action, ids, category } = body;
  if (!Array.isArray(ids) || ids.length === 0) return createErrorResponse('ids 必须是非空数组', 400);
  if (ids.length > BATCH_LIMIT) return createErrorResponse(`单次最多 ${BATCH_LIMIT} 个`, 400);
  if (!ids.every(x => Number.isInteger(x) || /^\d+$/.test(String(x)))) return createErrorResponse('ids 必须为数字', 400);
  const idList = ids.map(x => Number(x));

  const validActions = ['show', 'hide', 'set_new', 'unset_new', 'set_category', 'delete'];
  if (!validActions.includes(action)) return createErrorResponse('不支持的 action', 400);

  let update = null;
  let doDelete = false;
  if (action === 'show')       update = { is_visible: true,  updated_at: new Date().toISOString() };
  if (action === 'hide')       update = { is_visible: false, updated_at: new Date().toISOString() };
  if (action === 'set_new')    update = { is_new: true,      updated_at: new Date().toISOString() };
  if (action === 'unset_new')  update = { is_new: false,     updated_at: new Date().toISOString() };
  if (action === 'set_category') {
    if (typeof category !== 'string' || !category) return createErrorResponse('set_category 必须传 category', 400);
    update = { category: category.slice(0, 32), updated_at: new Date().toISOString() };
  }
  if (action === 'delete') doDelete = true;

  let affectedCount = 0;
  if (doDelete) {
    const res = await supabase.from('gallery_images').delete().in('id', idList).select('id');
    if (res.error) { console.error('批量删除图片失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  } else {
    const res = await supabase.from('gallery_images').update(update).in('id', idList).select('id');
    if (res.error) { console.error('批量更新图片失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  }

  await logAudit(supabase, ctx, 'images.batch_' + action, 'image', 'batch', {
    action, count: affectedCount, target_ids: idList,
    ...(category ? { category } : {}),
  });

  return createCorsResponse({
    success: true,
    data: { affected: affectedCount, requested: idList.length },
  });
}

async function handleBatchComments(supabase, ctx, req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST', 405);
  const body = await req.json().catch(() => null);
  if (!body) return createErrorResponse('请求体必须是 JSON', 400);
  const { action, ids } = body;
  if (!Array.isArray(ids) || ids.length === 0) return createErrorResponse('ids 必须是非空数组', 400);
  if (ids.length > BATCH_LIMIT) return createErrorResponse(`单次最多 ${BATCH_LIMIT} 个`, 400);
  if (!ids.every(x => Number.isInteger(x) || /^\d+$/.test(String(x)))) return createErrorResponse('ids 必须为数字', 400);
  const idList = ids.map(x => Number(x));

  const validActions = ['delete', 'approve', 'reject'];
  if (!validActions.includes(action)) return createErrorResponse('不支持的 action', 400);

  let update = null;
  let doDelete = false;
  if (action === 'approve') update = { status: 'approved' };
  if (action === 'reject')  update = { status: 'rejected' };
  if (action === 'delete')  doDelete = true;

  let affectedCount = 0;
  if (doDelete) {
    const res = await supabase.from('comments').delete().in('id', idList).select('id');
    if (res.error) { console.error('批量删除评论失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  } else {
    const res = await supabase.from('comments').update(update).in('id', idList).select('id');
    if (res.error) { console.error('批量更新评论失败:', res.error); return createErrorResponse('批量操作失败', 500); }
    affectedCount = (res.data || []).length;
  }

  await logAudit(supabase, ctx, 'comments.batch_' + action, 'comment', 'batch', {
    action, count: affectedCount, target_ids: idList,
  });

  return createCorsResponse({
    success: true,
    data: { affected: affectedCount, requested: idList.length },
  });
}

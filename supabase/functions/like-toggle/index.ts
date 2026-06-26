// ============================
// like-toggle Edge Function
// 控制层：接收请求、参数校验、限流检查
// 业务层：点赞/取消点赞逻辑
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { verifyOrigin } from '../_shared/originGuard.ts';

// === 共享：CORS 配置 ===
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info',
  'Access-Control-Max-Age': '86400',
};

function createCorsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function createErrorResponse(message, status = 400) {
  return createCorsResponse({ error: message }, status);
}

// === 共享：Supabase 客户端 ===
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// === 共享：Token 校验（通过 auth_sessions 表，与 auth-api 保持一致） ===
function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return base64urlEncode(new Uint8Array(hash));
}
async function verifyToken(token: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = await hashToken(token);
  const supabase = createServiceClient();
  const { data: session } = await supabase
    .from('auth_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await supabase.from('auth_sessions').delete().eq('token_hash', tokenHash);
    return null;
  }
  const { data: row } = await supabase
    .from('users')
    .select('id, is_active')
    .eq('id', session.user_id)
    .maybeSingle();
  if (!row || !row.is_active) return null;
  return { sub: String(row.id) };
}
function getBearerToken(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// === 共享：限流器 ===
const rateLimitStore = new Map();
function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
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

// 业务常量
const LIKE_MAX_PER_MINUTE = 10;
const LIKE_WINDOW_MS = 60000;

Deno.serve(async (req) => {
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/like-toggle\/?/, '') || 'toggle';

  try {
    if (path === 'counts') {
      return await handleGetLikeCounts();
    }

    if (path === 'my-likes') {
      return await handleGetMyLikes(req);
    }

    if (req.method !== 'POST') {
      return createErrorResponse('仅支持 POST 请求', 405);
    }

    // 点赞/取消点赞必须登录
    const token = getBearerToken(req);
    if (!token) return createErrorResponse('请先登录', 401);
    const payload = await verifyToken(token);
    if (!payload) return createErrorResponse('Token 无效或已过期', 401);
    const userId = payload.sub;
    if (!userId) return createErrorResponse('Token 中无用户 ID', 401);

    let body;
    try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

    const { image_id, action } = body;

    if (!image_id || typeof image_id !== 'number' || image_id <= 0) {
      return createErrorResponse('image_id 必须是正整数', 400);
    }
    if (!action || (action !== 'like' && action !== 'unlike')) {
      return createErrorResponse('action 必须是 like 或 unlike', 400);
    }

    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const rateKey = `like:${clientIp}:${userId}`;
    const rateCheck = checkRateLimit(rateKey, LIKE_MAX_PER_MINUTE, LIKE_WINDOW_MS);

    if (!rateCheck.allowed) {
      return createErrorResponse(
        `操作过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429
      );
    }

    const supabase = createServiceClient();
    const result = await handleLikeToggle(supabase, image_id, action, userId);

    if (!result.success) {
      return createErrorResponse(result.message, 400);
    }

    return createCorsResponse({
      success: true, message: result.message,
      data: { image_id, action, count: result.count },
      rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
    }, 200);

  } catch (err) {
    console.error('like-toggle 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

async function handleGetLikeCounts() {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('image_likes').select('image_id, count');
  if (error) { console.error('查询点赞计数失败:', error); return createErrorResponse('查询点赞计数失败', 500); }

  const counts = {};
  if (data) data.forEach((item) => { counts[item.image_id] = item.count; });
  return createCorsResponse({ success: true, data: counts });
}

async function handleGetMyLikes(req: Request) {
  const token = getBearerToken(req);
  if (!token) return createErrorResponse('请先登录', 401);
  const payload = await verifyToken(token);
  if (!payload) return createErrorResponse('Token 无效或已过期', 401);
  const userId = payload.sub;
  if (!userId) return createErrorResponse('Token 中无用户 ID', 401);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('likes')
    .select('image_id')
    .eq('user_id', userId);
  if (error) { console.error('查询我的点赞失败:', error); return createErrorResponse('查询我的点赞失败', 500); }

  const ids = (data || []).map((item) => item.image_id);
  return createCorsResponse({ success: true, data: ids });
}

async function handleLikeToggle(supabase, imageId, action, userId) {
  // 修复: TOCTOU 竞态 (并发点赞场景)
  // - 旧实现: 先 SELECT 再 INSERT/DELETE,两个并发"like"都看到 existing=null,
  //   都尝试 INSERT,要么产生重复记录(无唯一约束),要么 23505 错误
  // - 新实现: 用 upsert(like)/delete(unlike),依赖 likes 表的
  //   (image_id, user_id) 唯一约束保证幂等

  if (action === 'like') {
    // upsert: 已存在则 no-op,不存在则插入
    const { data: upsertData, error: upsertError } = await supabase
      .from('likes')
      .upsert(
        { image_id: imageId, user_id: userId },
        { onConflict: 'image_id,user_id', ignoreDuplicates: true }
      )
      .select('id');

    if (upsertError) {
      console.error('点赞 upsert 失败:', upsertError);
      throw new Error('点赞失败');
    }

    // 如果 upsert 返回空数组,说明记录已存在(被并发请求抢先)
    const isNewLike = Array.isArray(upsertData) && upsertData.length > 0;

    if (isNewLike) {
      await logOperation(supabase, 'like', imageId, userId);
    }

    const { data: countData } = await supabase.from('image_likes').select('count').eq('image_id', imageId).single();
    return {
      success: true,
      message: isNewLike ? '点赞成功' : '已经点赞过了',
      count: countData?.count || 0,
      isNewLike,
    };
  } else {
    // unlike: 直接 delete,删除 0 行也不报错
    const { error: deleteError, count: deletedCount } = await supabase
      .from('likes')
      .delete({ count: 'exact' })
      .eq('image_id', imageId)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('取消点赞 delete 失败:', deleteError);
      throw new Error('取消点赞失败');
    }

    if (deletedCount > 0) {
      await logOperation(supabase, 'unlike', imageId, userId);
    }

    const { data: countData } = await supabase.from('image_likes').select('count').eq('image_id', imageId).single();
    return {
      success: true,
      message: deletedCount > 0 ? '已取消点赞' : '尚未点赞',
      count: countData?.count || 0,
    };
  }
}

async function logOperation(supabase, action, imageId, userId) {
  try {
    await supabase.from('like_logs').insert({ action, image_id: imageId, user_id: userId, created_at: new Date().toISOString() });
  } catch (e) { console.warn('操作日志记录失败:', e); }
}

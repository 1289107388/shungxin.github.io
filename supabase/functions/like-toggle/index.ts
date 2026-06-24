// ============================
// like-toggle Edge Function
// 控制层：接收请求、参数校验、限流检查
// 业务层：点赞/取消点赞逻辑
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// === 共享：CORS 配置 ===
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info',
  'Access-Control-Max-Age': '86400',
};

function createCorsResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function createErrorResponse(message: string, status: number = 400): Response {
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

// === 共享：限流器 ===
interface RateLimitEntry { count: number; resetAt: number; }
const rateLimitStore = new Map<string, RateLimitEntry>();

function checkRateLimit(key: string, maxRequests: number = 10, windowMs: number = 60000) {
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

interface LikeRequest {
  image_id: number;
  action: 'like' | 'unlike';
  user_id: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return createCorsResponse({}, 204);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/like-toggle\/?/, '') || 'toggle';

  try {
    if (path === 'counts') {
      return await handleGetLikeCounts();
    }

    if (req.method !== 'POST') {
      return createErrorResponse('仅支持 POST 请求', 405);
    }

    let body: LikeRequest;
    try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

    const { image_id, action, user_id } = body;

    if (!image_id || typeof image_id !== 'number' || image_id <= 0) {
      return createErrorResponse('image_id 必须是正整数', 400);
    }
    if (!action || (action !== 'like' && action !== 'unlike')) {
      return createErrorResponse('action 必须是 like 或 unlike', 400);
    }
    if (!user_id || typeof user_id !== 'string' || user_id.length < 3) {
      return createErrorResponse('user_id 无效', 400);
    }

    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    const rateKey = `like:${clientIp}:${user_id}`;
    const rateCheck = checkRateLimit(rateKey, LIKE_MAX_PER_MINUTE, LIKE_WINDOW_MS);

    if (!rateCheck.allowed) {
      return createErrorResponse(
        `操作过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429
      );
    }

    const supabase = createServiceClient();
    const result = await handleLikeToggle(supabase, image_id, action, user_id);

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

async function handleGetLikeCounts(): Promise<Response> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('image_likes').select('image_id, count');
  if (error) { console.error('查询点赞计数失败:', error); return createErrorResponse('查询点赞计数失败', 500); }

  const counts: Record<number, number> = {};
  data?.forEach((item: { image_id: number; count: number }) => { counts[item.image_id] = item.count; });
  return createCorsResponse({ success: true, data: counts });
}

interface LikeResult { success: boolean; message: string; count: number; }

async function handleLikeToggle(supabase: ReturnType<typeof createServiceClient>, imageId: number, action: 'like' | 'unlike', userId: string): Promise<LikeResult> {
  const { data: existing, error: queryError } = await supabase.from('likes').select('id').eq('image_id', imageId).eq('user_id', userId).maybeSingle();
  if (queryError) { console.error('查询点赞记录失败:', queryError); throw new Error('数据库查询失败'); }

  if (action === 'like') {
    if (existing) return { success: false, message: '已经点赞过了', count: 0 };

    const { error: insertError } = await supabase.from('likes').insert({ image_id: imageId, user_id: userId });
    if (insertError) { console.error('插入点赞记录失败:', insertError); throw new Error('点赞失败'); }

    await logOperation(supabase, 'like', imageId, userId);
    const { data: countData } = await supabase.from('image_likes').select('count').eq('image_id', imageId).single();
    return { success: true, message: '点赞成功', count: countData?.count || 0 };

  } else {
    if (!existing) return { success: false, message: '尚未点赞', count: 0 };

    const { error: deleteError } = await supabase.from('likes').delete().eq('id', existing.id);
    if (deleteError) { console.error('删除点赞记录失败:', deleteError); throw new Error('取消点赞失败'); }

    await logOperation(supabase, 'unlike', imageId, userId);
    const { data: countData } = await supabase.from('image_likes').select('count').eq('image_id', imageId).single();
    return { success: true, message: '已取消点赞', count: countData?.count || 0 };
  }
}

async function logOperation(supabase: ReturnType<typeof createServiceClient>, action: string, imageId: number, userId: string): Promise<void> {
  try {
    await supabase.from('like_logs').insert({ action, image_id: imageId, user_id: userId, created_at: new Date().toISOString() });
  } catch (e) { console.warn('操作日志记录失败:', e); }
}

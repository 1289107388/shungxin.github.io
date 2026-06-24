// ============================
// view-count Edge Function
// 控制层：接收请求、参数校验
// 业务层：浏览量查询、递增
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info',
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
function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const rateLimitStore = new Map();
function checkRateLimit(key, maxRequests = 30, windowMs = 60000) {
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

const VIEW_MAX_PER_MINUTE = 30;
const VIEW_WINDOW_MS = 60000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/view-count\/?/, '') || 'list';

  try {
    switch (path) {
      case 'list':
        return await handleListViews();
      case 'increment':
        return await handleIncrementView(req);
      default:
        return createErrorResponse('未知接口', 404);
    }
  } catch (err) {
    console.error('view-count 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

async function handleListViews() {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from('image_views').select('image_id, count');
  if (error) {
    console.error('查询浏览量失败:', error);
    return createErrorResponse('查询浏览量失败', 500);
  }
  const counts = {};
  if (data) data.forEach((item) => { counts[item.image_id] = item.count; });
  return createCorsResponse({ success: true, data: counts });
}

async function handleIncrementView(req) {
  if (req.method !== 'POST') {
    return createErrorResponse('仅支持 POST 请求', 405);
  }

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }
  const { image_id, viewer_id } = body;

  if (!image_id || typeof image_id !== 'number' || image_id <= 0) {
    return createErrorResponse('image_id 无效', 400);
  }

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateKey = `view:${clientIp}:${viewer_id || 'anon'}`;
  const rateCheck = checkRateLimit(rateKey, VIEW_MAX_PER_MINUTE, VIEW_WINDOW_MS);

  if (!rateCheck.allowed) {
    return createErrorResponse(`操作过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  const supabase = createServiceClient();
  try {
    const { data: existing, error: queryError } = await supabase
      .from('image_views')
      .select('id, count')
      .eq('image_id', image_id)
      .maybeSingle();
    if (queryError) {
      console.error('查询浏览量记录失败:', queryError);
      return createErrorResponse('查询失败', 500);
    }

    let newCount;
    if (existing) {
      newCount = existing.count + 1;
      const { error: updateError } = await supabase
        .from('image_views')
        .update({ count: newCount, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (updateError) {
        console.error('更新浏览量失败:', updateError);
        return createErrorResponse('更新浏览量失败', 500);
      }
    } else {
      newCount = 1;
      const { error: insertError } = await supabase
        .from('image_views')
        .insert({ image_id, count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      if (insertError) {
        console.error('创建浏览量记录失败:', insertError);
        return createErrorResponse('创建浏览量记录失败', 500);
      }
    }
    return createCorsResponse({
      success: true, message: '浏览量增加成功',
      data: { image_id, count: newCount },
      rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
    });
  } catch (err) {
    console.error('增加浏览量失败:', err);
    return createErrorResponse('增加浏览量失败', 500);
  }
}

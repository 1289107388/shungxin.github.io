// view-count Edge Function - 自包含版本
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function createCorsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type',
      'Content-Type': 'application/json'
    }
  });
}

function createErrorResponse(message, status = 400) {
  return createCorsResponse({ error: message }, status);
}

const rateLimitStore = new Map();

function checkRateLimit(key, maxRequests = 30, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }
  if (entry.count >= maxRequests) return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return createCorsResponse({}, 204);

  const url = new URL(req.url);
  const parts = url.pathname.split('/');
  const path = parts[parts.length - 1] || 'list';

  try {
    if (path === 'list') {
      const supabase = createServiceClient();
      const { data, error } = await supabase.from('image_views').select('image_id, count');
      if (error) return createErrorResponse('查询浏览量失败', 500);
      const counts = {};
      if (data) data.forEach(item => { counts[item.image_id] = item.count; });
      return createCorsResponse({ success: true, data: counts });
    }

    if (path === 'increment') {
      if (req.method !== 'POST') return createErrorResponse('仅支持 POST', 405);

      let body;
      try { body = await req.json(); } catch { return createErrorResponse('无效JSON'); }
      const { image_id, viewer_id } = body;

      if (!image_id || image_id <= 0) return createErrorResponse('image_id无效');

      const clientIp = req.headers.get('x-forwarded-for') || 'unknown';
      const rateKey = 'view:' + clientIp + ':' + (viewer_id || 'anon');
      const rateCheck = checkRateLimit(rateKey, 30, 60000);
      if (!rateCheck.allowed) return createErrorResponse('操作过于频繁', 429);

      const supabase = createServiceClient();
      const { data: existing } = await supabase.from('image_views').select('id, count').eq('image_id', image_id).maybeSingle();

      let newCount;
      if (existing) {
        newCount = (existing.count || 0) + 1;
        await supabase.from('image_views').update({ count: newCount, updated_at: new Date().toISOString() }).eq('id', existing.id);
      } else {
        newCount = 1;
        await supabase.from('image_views').insert({ image_id, count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }

      return createCorsResponse({ success: true, data: { image_id, count: newCount } });
    }

    return createErrorResponse('未知接口', 404);
  } catch (err) {
    console.error('view-count 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

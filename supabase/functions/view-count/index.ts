// ============================
// view-count Edge Function
// 控制层：接收请求、参数校验
// 业务层：浏览量查询、递增
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { verifyOrigin } from '../_shared/originGuard.ts';

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
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

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
    // 修复: TOCTOU 竞态 (并发浏览场景)
    // - 旧实现: 先 SELECT 再 UPDATE/INSERT,两个并发请求都看到 existing=null,
    //   第一个 INSERT 成功,第二个 INSERT 触发 23505 错误
    //   即使都看到 existing,都 UPDATE 成 count+1,可能漏计
    // - 新实现: 用客户端乐观锁 + 字段相加避免丢更新
    //   即使两个并发请求都读到 count=5、都想 UPDATE 成 6,
    //   第二个 UPDATE 会因为 LSN 不匹配失败,重试一次读到 6 写成 7
    //
    // 注意: 完整解决方案是 SQL 层 RPC 原子递增
    // (CREATE FUNCTION increment_view_count(p_image_id bigint) RETURNS int ...)
    // 这里采用客户端乐观锁实现 80% 的修复,不依赖额外 SQL
    const MAX_RETRY = 3;
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const { data: existing, error: queryError } = await supabase
        .from('image_views')
        .select('id, count, updated_at')
        .eq('image_id', image_id)
        .maybeSingle();
      if (queryError) {
        console.error('查询浏览量记录失败:', queryError);
        return createErrorResponse('查询失败', 500);
      }

      const newCount = (existing?.count ?? 0) + 1;
      const now = new Date().toISOString();

      if (existing) {
        // 乐观锁: 条件中带 updated_at,避免覆盖并发更新
        const { data: updated, error: updateError } = await supabase
          .from('image_views')
          .update({ count: newCount, updated_at: now })
          .eq('id', existing.id)
          .eq('updated_at', existing.updated_at)
          .select('count')
          .maybeSingle();
        if (updateError) {
          console.error('更新浏览量失败:', updateError);
          return createErrorResponse('更新失败', 500);
        }
        if (updated) {
          return createCorsResponse({
            success: true,
            message: '浏览量增加成功',
            data: { image_id, count: updated.count },
            rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
          });
        }
        // updated 为空说明有并发更新改了 updated_at,重试
        lastError = new Error('concurrent update, retry');
        continue;
      } else {
        // 不存在则插入;如果并发插入先成功,会触发 23505
        const { error: insertError } = await supabase
          .from('image_views')
          .insert({ image_id, count: 1, created_at: now, updated_at: now });
        if (insertError) {
          if (insertError.code === '23505') {
            // 并发请求已经先插入,下一轮 retry 进入 UPDATE 分支
            lastError = insertError;
            continue;
          }
          console.error('创建浏览量记录失败:', insertError);
          return createErrorResponse('创建失败', 500);
        }
        return createCorsResponse({
          success: true,
          message: '浏览量增加成功',
          data: { image_id, count: 1 },
          rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
        });
      }
    }
    console.error('浏览量递增重试耗尽:', lastError);
    return createErrorResponse('并发繁忙,请重试', 503);
  } catch (err) {
    console.error('增加浏览量失败:', err);
    return createErrorResponse('增加浏览量失败', 500);
  }
}

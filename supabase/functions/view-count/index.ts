// ============================
// view-count Edge Function
// 控制层：接收请求、参数校验
// 业务层：浏览量查询、递增
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { createServiceClient } from '../_shared/supabaseClient.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';
import { createCorsResponse, createErrorResponse } from '../_shared/cors.ts';

// 业务常量
const VIEW_MAX_PER_MINUTE = 30;      // 1分钟最多30次浏览量更新
const VIEW_WINDOW_MS = 60000;

Deno.serve(async (req: Request) => {
  // === 1. 控制层：CORS 预检 ===
  if (req.method === 'OPTIONS') {
    return createCorsResponse({}, 204);
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

// ============================
// 业务层：获取所有图片浏览量
// ============================
async function handleListViews(): Promise<Response> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('image_views')
    .select('image_id, count');

  if (error) {
    console.error('查询浏览量失败:', error);
    return createErrorResponse('查询浏览量失败', 500);
  }

  const counts: Record<number, number> = {};
  data?.forEach((item: { image_id: number; count: number }) => {
    counts[item.image_id] = item.count;
  });

  return createCorsResponse({
    success: true,
    data: counts,
  });
}

// ============================
// 业务层：增加浏览量
// ============================
async function handleIncrementView(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return createErrorResponse('仅支持 POST 请求', 405);
  }

  let body: { image_id?: number; viewer_id?: string };
  try {
    body = await req.json();
  } catch {
    return createErrorResponse('请求体必须是有效的 JSON', 400);
  }

  const { image_id, viewer_id } = body;

  // 参数校验
  if (!image_id || typeof image_id !== 'number' || image_id <= 0) {
    return createErrorResponse('image_id 无效', 400);
  }

  // 限流检查（基于 IP + viewer_id）
  const clientIp = req.headers.get('x-forwarded-for') ||
                   req.headers.get('x-real-ip') ||
                   'unknown';
  const rateKey = `view:${clientIp}:${viewer_id || 'anon'}`;
  const rateCheck = checkRateLimit(rateKey, VIEW_MAX_PER_MINUTE, VIEW_WINDOW_MS);

  if (!rateCheck.allowed) {
    return createErrorResponse(
      `操作过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`,
      429
    );
  }

  const supabase = createServiceClient();

  try {
    // 查询是否存在记录
    const { data: existing, error: queryError } = await supabase
      .from('image_views')
      .select('id, count')
      .eq('image_id', image_id)
      .maybeSingle();

    if (queryError) {
      console.error('查询浏览量记录失败:', queryError);
      return createErrorResponse('查询失败', 500);
    }

    let newCount: number;

    if (existing) {
      // 已有记录，增加计数
      newCount = existing.count + 1;
      const { error: updateError } = await supabase
        .from('image_views')
        .update({
          count: newCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (updateError) {
        console.error('更新浏览量失败:', updateError);
        return createErrorResponse('更新浏览量失败', 500);
      }
    } else {
      // 无记录，创建新记录
      newCount = 1;
      const { error: insertError } = await supabase
        .from('image_views')
        .insert({
          image_id: image_id,
          count: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (insertError) {
        console.error('创建浏览量记录失败:', insertError);
        return createErrorResponse('创建浏览量记录失败', 500);
      }
    }

    return createCorsResponse({
      success: true,
      message: '浏览量增加成功',
      data: {
        image_id,
        count: newCount,
      },
      rateLimit: {
        remaining: rateCheck.remaining,
        resetAt: new Date(rateCheck.resetAt).toISOString(),
      },
    });

  } catch (err) {
    console.error('增加浏览量失败:', err);
    return createErrorResponse('增加浏览量失败', 500);
  }
}

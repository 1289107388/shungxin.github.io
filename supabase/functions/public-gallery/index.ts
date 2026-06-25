// ============================
// public-gallery Edge Function
// 公开接口(免鉴权),给主站前台使用:
//   GET /public-gallery/images        -> 所有可见图片列表
//   GET /public-gallery/images/:id    -> 单张图片详情
// 缓存: 1 分钟(用 stale-while-revalidate 头部)
// 注意: 永远只返回 is_visible = true 的图
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
};
function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return cors({ error: '仅支持 GET' }, 405);
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/.*\/public-gallery\/?/, '').split('/').filter(Boolean);

  // 用 anon key (走 RLS) 或者 service role? 这里用 service role,
  // 因为我们已经在 where 里硬过滤 is_visible = true,加上 anon key
  // 也可以,但 service role 更稳 (RLS 策略随时可能变)
  const supabase = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (parts[0] === 'images' && parts.length === 1) {
      // 列表
      // 兼容老 schema (没有 storage_path 等字段): 用 * 查询,代码里做 null 处理
      const { data, error } = await supabase
        .from('gallery_images')
        .select('*')
        .eq('is_visible', true)
        .order('sort_order', { ascending: true });
      if (error) { console.error('查询图片失败:', error); return cors({ error: '查询失败', detail: error.message || String(error) }, 500); }

      const enriched = (data || []).map(img => ({
        id: img.id,
        filename: img.filename,
        title: img.title || img.filename,
        category: img.category,
        is_new: img.is_new,
        sort_order: img.sort_order,
        description: img.description,
        created_at: img.created_at,
        width: img.width ?? null, height: img.height ?? null,
        src: img.storage_path
          ? `${SUPABASE_URL}/storage/v1/object/public/${img.storage_bucket || 'gallery-images'}/${img.storage_path}`
          : 'images/' + img.filename,
      }));
      return cors({ success: true, data: { images: enriched } });
    }

    if (parts[0] === 'images' && parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (!Number.isInteger(id)) return cors({ error: 'id 必须是数字' }, 400);
      const { data, error } = await supabase
        .from('gallery_images')
        .select('*')
        .eq('id', id)
        .eq('is_visible', true)
        .maybeSingle();
      if (error) { console.error('查询图片失败:', error); return cors({ error: '查询失败', detail: error.message || String(error) }, 500); }
      if (!data) return cors({ error: '图片不存在或不可见' }, 404);
      const src = data.storage_path
        ? `${SUPABASE_URL}/storage/v1/object/public/${data.storage_bucket || 'gallery-images'}/${data.storage_path}`
        : 'images/' + data.filename;
      return cors({ success: true, data: { ...data, src } });
    }

    return cors({ error: '未知接口' }, 404);
  } catch (err) {
    console.error('public-gallery 错误:', err);
    return cors({ error: '服务器内部错误' }, 500);
  }
});

// ============================
// collections-api Edge Function
// 公开接口：
//   GET /collections?area=public|paid        -> 合集列表
//   GET /collections/:id                     -> 合集详情（含图片）
// 管理接口（需 admin Bearer token）：
//   POST /collections                        -> 创建合集
//   PUT  /collections/:id                    -> 更新合集
//   DELETE /collections/:id                  -> 删除合集
//   POST /collections/:id/images             -> 批量添加图片
//   DELETE /collections/:id/images/:image_id -> 移除图片
// ============================

import { createServiceClient } from '../_shared/supabaseClient.ts';
import { verifyToken } from '../_shared/token.ts';
import { verifyOrigin } from '../_shared/originGuard.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';
import { CORS_HEADERS, createCorsResponse, createErrorResponse } from '../_shared/cors.ts';

const PAID_AREA_JWT_SECRET = Deno.env.get('PAID_AREA_JWT_SECRET') || '';
const RATE_LIMIT_PUBLIC = 120;
const RATE_LIMIT_ADMIN = 60;

// ---------- 付费区 token 校验（与 public-gallery 同源实现） ----------
function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', km, new TextEncoder().encode(data)));
}

async function verifyPaidAreaToken(token: string): Promise<boolean> {
  if (!PAID_AREA_JWT_SECRET || PAID_AREA_JWT_SECRET.length < 32) return false;
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [hb, pb, sb] = parts;
  const expected = await hmacSha256(PAID_AREA_JWT_SECRET, `${hb}.${pb}`);
  const provided = base64urlDecode(sb);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(pb)));
    if (payload.sub !== 'paid-area') return false;
    if (!payload.exp || Date.now() / 1000 > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

function extractPaidAreaToken(req: Request): string {
  const header = req.headers.get('x-paid-area-token');
  if (header) return header.trim();
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---------- 鉴权 ----------
async function requireAdmin(req: Request) {
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

function paidCacheHeaders(isPaid: boolean) {
  if (!isPaid) return {};
  return {
    'Cache-Control': 'no-store, private',
    'Vary': 'X-Paid-Area-Token, Authorization',
  };
}

// ---------- 路由 ----------
Deno.serve(async (req) => {
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/.*\/collections-api\/?/, '').split('/').filter(Boolean);
  const section = parts[0];
  const id = parts[1];
  const subAction = parts[2];

  try {
    // 公开接口
    if (section === 'collections' && req.method === 'GET' && !id) {
      return await handleListCollections(req, url);
    }
    if (section === 'collections' && req.method === 'GET' && id && !subAction) {
      return await handleGetCollection(req, id);
    }

    // 以下需 admin 鉴权
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip') || 'unknown';
    const rl = checkRateLimit(`collections-admin:${ip}`, RATE_LIMIT_ADMIN, 60_000);
    if (!rl.allowed) return createErrorResponse('请求过于频繁', 429);

    if (section === 'collections' && req.method === 'POST' && !id) {
      return await handleCreateCollection(req, auth.user.id);
    }
    if (section === 'collections' && req.method === 'PUT' && id && !subAction) {
      return await handleUpdateCollection(req, id);
    }
    if (section === 'collections' && req.method === 'DELETE' && id && !subAction) {
      return await handleDeleteCollection(id);
    }
    if (section === 'collections' && req.method === 'POST' && id && subAction === 'images') {
      return await handleAddImages(req, id);
    }
    if (section === 'collections' && req.method === 'DELETE' && id && subAction === 'images' && parts[3]) {
      return await handleRemoveImage(id, parts[3]);
    }

    return createErrorResponse('未知接口', 404);
  } catch (e) {
    console.error('collections-api error:', e);
    return createErrorResponse('服务器内部错误', 500);
  }
});

// ---------- 公开列表 ----------
async function handleListCollections(req: Request, url: URL) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip') || 'unknown';
  const rl = checkRateLimit(`collections:${ip}`, RATE_LIMIT_PUBLIC, 60_000);
  if (!rl.allowed) return createErrorResponse('请求过于频繁', 429);

  const area = (url.searchParams.get('area') || 'public').toLowerCase();
  if (area !== 'public' && area !== 'paid') {
    return createErrorResponse('area 参数只能是 public 或 paid', 400);
  }

  const isPaid = area === 'paid';
  if (isPaid) {
    const token = extractPaidAreaToken(req);
    if (!(await verifyPaidAreaToken(token))) {
      return createErrorResponse('需要付费区访问权限', 403);
    }
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('collections')
    .select('id, name, description, cover_image_id, area, is_visible, sort_order, created_at, updated_at')
    .eq('area', area)
    .eq('is_visible', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('list collections error:', error);
    return createErrorResponse('数据库查询失败', 500);
  }

  // 补充封面 URL 和图片数量
  const enriched = await enrichCollections(supabase, data || []);
  return createCorsResponse({ success: true, data: enriched }, 200, paidCacheHeaders(isPaid));
}

// ---------- 公开详情 ----------
async function handleGetCollection(req: Request, id: string) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip') || 'unknown';
  const rl = checkRateLimit(`collections:${ip}`, RATE_LIMIT_PUBLIC, 60_000);
  if (!rl.allowed) return createErrorResponse('请求过于频繁', 429);

  const collectionId = parseInt(id, 10);
  if (!collectionId) return createErrorResponse('无效合集 ID', 400);

  const supabase = createServiceClient();
  const { data: collection, error: cErr } = await supabase
    .from('collections')
    .select('id, name, description, cover_image_id, area, is_visible, sort_order, created_at, updated_at')
    .eq('id', collectionId)
    .maybeSingle();

  if (cErr || !collection) return createErrorResponse('合集不存在', 404);
  if (!collection.is_visible) return createErrorResponse('合集未公开', 404);

  const isPaid = collection.area === 'paid';
  if (isPaid) {
    const token = extractPaidAreaToken(req);
    if (!(await verifyPaidAreaToken(token))) {
      return createErrorResponse('需要付费区访问权限', 403);
    }
  }

  const { data: images, error: iErr } = await supabase
    .from('collection_images')
    .select('image_id, sort_order, gallery_images(*)')
    .eq('collection_id', collectionId)
    .order('sort_order', { ascending: true })
    .order('added_at', { ascending: true });

  if (iErr) {
    console.error('get collection images error:', iErr);
    return createErrorResponse('查询合集图片失败', 500);
  }

  const baseUrl = Deno.env.get('SUPABASE_URL') || '';
  const list = (images || [])
    .filter((item: any) => item.gallery_images && item.gallery_images.is_visible)
    .map((item: any) => ({
      ...item.gallery_images,
      src: `${baseUrl}/storage/v1/object/public/${item.gallery_images.storage_bucket}/${item.gallery_images.storage_path}`,
    }));

  return createCorsResponse({
    success: true,
    data: {
      ...collection,
      image_count: list.length,
      images: list,
    },
  }, 200, paidCacheHeaders(isPaid));
}

// ---------- 管理：创建 ----------
async function handleCreateCollection(req: Request, adminId: string) {
  let body;
  try { body = await req.json(); }
  catch { return createErrorResponse('JSON 解析失败', 400); }

  const name = (body.name || '').toString().trim();
  if (!name) return createErrorResponse('合集名称不能为空', 400);

  const area = (body.area || 'public').toString().trim().toLowerCase();
  if (area !== 'public' && area !== 'paid') return createErrorResponse('area 参数错误', 400);

  const supabase = createServiceClient();
  const { data, error } = await supabase.from('collections').insert({
    name,
    description: (body.description || '').toString().slice(0, 500) || null,
    cover_image_id: body.cover_image_id ? parseInt(body.cover_image_id, 10) : null,
    area,
    is_visible: body.is_visible !== false,
    sort_order: parseInt(body.sort_order, 10) || 99,
    created_by: adminId,
  }).select().single();

  if (error) {
    console.error('create collection error:', error);
    return createErrorResponse('创建失败: ' + error.message, 500);
  }
  return createCorsResponse({ success: true, data });
}

// ---------- 管理：更新 ----------
async function handleUpdateCollection(req: Request, id: string) {
  const collectionId = parseInt(id, 10);
  if (!collectionId) return createErrorResponse('无效合集 ID', 400);

  let body;
  try { body = await req.json(); }
  catch { return createErrorResponse('JSON 解析失败', 400); }

  const update: any = {};
  if (body.name !== undefined) {
    const name = body.name.toString().trim();
    if (!name) return createErrorResponse('合集名称不能为空', 400);
    update.name = name;
  }
  if (body.description !== undefined) update.description = body.description.toString().slice(0, 500) || null;
  if (body.cover_image_id !== undefined) update.cover_image_id = body.cover_image_id ? parseInt(body.cover_image_id, 10) : null;
  if (body.area !== undefined) {
    const area = body.area.toString().trim().toLowerCase();
    if (area !== 'public' && area !== 'paid') return createErrorResponse('area 参数错误', 400);
    update.area = area;
  }
  if (body.is_visible !== undefined) update.is_visible = !!body.is_visible;
  if (body.sort_order !== undefined) update.sort_order = parseInt(body.sort_order, 10) || 99;

  if (Object.keys(update).length === 0) return createErrorResponse('没有要更新的字段', 400);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('collections')
    .update(update)
    .eq('id', collectionId)
    .select()
    .single();

  if (error) {
    console.error('update collection error:', error);
    return createErrorResponse('更新失败: ' + error.message, 500);
  }
  return createCorsResponse({ success: true, data });
}

// ---------- 管理：删除 ----------
async function handleDeleteCollection(id: string) {
  const collectionId = parseInt(id, 10);
  if (!collectionId) return createErrorResponse('无效合集 ID', 400);

  const supabase = createServiceClient();
  const { error } = await supabase.from('collections').delete().eq('id', collectionId);
  if (error) {
    console.error('delete collection error:', error);
    return createErrorResponse('删除失败: ' + error.message, 500);
  }
  return createCorsResponse({ success: true });
}

// ---------- 管理：批量添加图片 ----------
async function handleAddImages(req: Request, id: string) {
  const collectionId = parseInt(id, 10);
  if (!collectionId) return createErrorResponse('无效合集 ID', 400);

  let body;
  try { body = await req.json(); }
  catch { return createErrorResponse('JSON 解析失败', 400); }

  const imageIds = Array.isArray(body.image_ids) ? body.image_ids.map((x: any) => parseInt(x, 10)).filter(Boolean) : [];
  if (!imageIds.length) return createErrorResponse('缺少 image_ids', 400);

  const supabase = createServiceClient();
  // 校验合集是否存在
  const { data: col } = await supabase.from('collections').select('id').eq('id', collectionId).maybeSingle();
  if (!col) return createErrorResponse('合集不存在', 404);

  const rows = imageIds.map((image_id: number, idx: number) => ({
    collection_id: collectionId,
    image_id,
    sort_order: (body.sort_order_base || 0) + idx,
  }));

  const { error } = await supabase.from('collection_images').upsert(rows, { onConflict: 'collection_id,image_id' });
  if (error) {
    console.error('add images error:', error);
    return createErrorResponse('添加图片失败: ' + error.message, 500);
  }
  return createCorsResponse({ success: true, added: imageIds.length });
}

// ---------- 管理：移除图片 ----------
async function handleRemoveImage(id: string, imageId: string) {
  const collectionId = parseInt(id, 10);
  const imgId = parseInt(imageId, 10);
  if (!collectionId || !imgId) return createErrorResponse('无效 ID', 400);

  const supabase = createServiceClient();
  const { error } = await supabase
    .from('collection_images')
    .delete()
    .eq('collection_id', collectionId)
    .eq('image_id', imgId);

  if (error) {
    console.error('remove image error:', error);
    return createErrorResponse('移除图片失败: ' + error.message, 500);
  }
  return createCorsResponse({ success: true });
}

// ---------- 工具 ----------
async function enrichCollections(supabase: any, collections: any[]) {
  const baseUrl = Deno.env.get('SUPABASE_URL') || '';
  const ids = collections.map((c) => c.id);
  const { data: counts } = await supabase
    .from('collection_images')
    .select('collection_id', { count: 'exact' })
    .in('collection_id', ids);

  // 手动聚合
  const countMap = new Map<number, number>();
  (counts || []).forEach((r: any) => {
    countMap.set(r.collection_id, (countMap.get(r.collection_id) || 0) + 1);
  });

  const coverIds = collections.map((c) => c.cover_image_id).filter(Boolean);
  const { data: covers } = coverIds.length
    ? await supabase.from('gallery_images').select('id, storage_path, storage_bucket').in('id', coverIds)
    : { data: [] };
  const coverMap = new Map((covers || []).map((r: any) => [r.id, r]));

  return collections.map((c) => {
    const cover = coverMap.get(c.cover_image_id);
    return {
      ...c,
      image_count: countMap.get(c.id) || 0,
      cover_src: cover
        ? `${baseUrl}/storage/v1/object/public/${cover.storage_bucket}/${cover.storage_path}`
        : null,
    };
  });
}

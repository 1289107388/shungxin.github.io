// ============================
// user-api Edge Function
// 公开接口(免鉴权),用于用户资料与创作者发现
//   GET /user-api/creators?sort=works|likes|views|recent&search=&limit=20&offset=0
//   GET /user-api/public-profile/:id_or_username
//   GET /user-api/user-images/:id
// 缓存: 1 分钟
// ============================

import { verifyOrigin } from '../_shared/originGuard.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';
import { CORS_HEADERS } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabaseClient.ts';

const USER_API_RATE_LIMIT_PER_MIN = 120;

const USER_CORS_HEADERS = {
  ...CORS_HEADERS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
};

function cors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...USER_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function resolveUserId(supabase: ReturnType<typeof createServiceClient>, identifier: string): Promise<number | Response> {
  if (/^\d+$/.test(identifier)) {
    const userId = parseInt(identifier, 10);
    return Number.isInteger(userId) && userId > 0 ? userId : cors({ error: '用户 id 无效' }, 400);
  }
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('id')
    .eq('username', identifier)
    .maybeSingle();
  if (userError) {
    console.error('查询用户 id 失败:', userError);
    return cors({ error: '查询用户失败', detail: userError.message || String(userError) }, 500);
  }
  if (!userRow) return cors({ error: '用户不存在' }, 404);
  return userRow.id;
}

Deno.serve(async (req) => {
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: USER_CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return cors({ error: '仅支持 GET' }, 405);
  }

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const rl = checkRateLimit(`user-api:${clientIp}`, USER_API_RATE_LIMIT_PER_MIN, 60_000);
  if (!rl.allowed) {
    return cors({ error: '请求过于频繁,请稍后再试' }, 429);
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/.*\/user-api\/?/, '').split('/').filter(Boolean);
  const supabase = createServiceClient();

  try {
    if (parts[0] === 'creators' && parts.length === 1) {
      return await handleCreators(supabase, url.searchParams);
    }
    if (parts[0] === 'public-profile' && parts.length === 2) {
      return await handlePublicProfile(supabase, parts[1]);
    }
    if (parts[0] === 'user-images' && parts.length === 2) {
      const userId = await resolveUserId(supabase, parts[1]);
      if (userId instanceof Response) return userId;
      return await handleUserImages(supabase, userId, url.searchParams);
    }
    return cors({ error: '未知接口' }, 404);
  } catch (err) {
    console.error('user-api 错误:', err);
    return cors({ error: '服务器内部错误' }, 500);
  }
});

async function handleCreators(supabase: ReturnType<typeof createServiceClient>, params: URLSearchParams) {
  const sort = params.get('sort') || 'works';
  const search = (params.get('search') || '').trim();
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10), 1), 100);
  const offset = Math.max(parseInt(params.get('offset') || '0', 10), 0);

  let query = supabase.from('creator_stats').select('*');
  if (search) {
    query = query.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  switch (sort) {
    case 'likes':
      query = query.order('total_likes', { ascending: false });
      break;
    case 'views':
      query = query.order('total_views', { ascending: false });
      break;
    case 'recent':
      query = query.order('created_at', { ascending: false });
      break;
    case 'works':
    default:
      query = query.order('works_count', { ascending: false });
      break;
  }

  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) {
    console.error('查询创作者失败:', error);
    return cors({ error: '查询创作者失败', detail: error.message || String(error) }, 500);
  }

  const safe = (data || []).map((u: any) => ({
    id: u.id,
    uid: u.uid,
    username: u.username,
    display_name: u.display_name,
    avatar: u.avatar,
    bio: u.bio,
    role: u.role,
    created_at: u.created_at,
    works_count: Number(u.works_count || 0),
    total_likes: Number(u.total_likes || 0),
    total_views: Number(u.total_views || 0),
  }));
  return cors({ success: true, data: { creators: safe, limit, offset } });
}

async function handlePublicProfile(supabase: ReturnType<typeof createServiceClient>, identifier: string) {
  const isId = /^\d+$/.test(identifier);

  // 1. 先从 users 表读取用户基本资料，避免 creator_stats 视图过滤导致无作品用户 404
  const usersQ = supabase
    .from('users')
    .select('id, uid, username, display_name, avatar, bio, role, created_at')
    .limit(1);
  const { data: userRow, error: userError } = isId
    ? await usersQ.eq('id', parseInt(identifier, 10)).maybeSingle()
    : await usersQ.eq('username', identifier).maybeSingle();

  if (userError) {
    console.error('查询用户资料失败:', userError);
    return cors({ error: '查询用户资料失败', detail: userError.message || String(userError) }, 500);
  }
  if (!userRow) return cors({ error: '用户不存在' }, 404);

  // 2. 再查创作者统计；若视图未包含该用户则使用零值兜底
  const { data: statsRow, error: statsError } = await supabase
    .from('creator_stats')
    .select('works_count, total_likes, total_views')
    .eq('id', userRow.id)
    .maybeSingle();

  if (statsError) {
    console.error('查询用户统计失败:', statsError);
  }

  const profile = {
    id: userRow.id,
    uid: userRow.uid,
    username: userRow.username,
    display_name: userRow.display_name,
    avatar: userRow.avatar,
    bio: userRow.bio,
    role: userRow.role,
    created_at: userRow.created_at,
    stats: {
      works_count: Number(statsRow?.works_count || 0),
      total_likes: Number(statsRow?.total_likes || 0),
      total_views: Number(statsRow?.total_views || 0),
    },
  };
  return cors({ success: true, data: profile });
}

async function handleUserImages(
  supabase: ReturnType<typeof createServiceClient>,
  userId: number,
  params: URLSearchParams,
) {
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '30', 10), 1), 100);
  const offset = Math.max(parseInt(params.get('offset') || '0', 10), 0);

  const { data, error } = await supabase
    .from('gallery_images')
    .select(`*, uploader:users!uploaded_by(id, uid, username, display_name, avatar)`)
    .eq('uploaded_by', userId)
    .eq('is_visible', true)
    .eq('area', 'public')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('查询用户作品失败:', error);
    return cors({ error: '查询用户作品失败', detail: error.message || String(error) }, 500);
  }

  const images = (data || []).map((img: any) => ({
    id: img.id,
    filename: img.filename,
    title: img.title || img.filename,
    category: img.category,
    is_new: img.is_new,
    sort_order: img.sort_order,
    description: img.description,
    created_at: img.created_at,
    width: img.width ?? null,
    height: img.height ?? null,
    src: img.storage_path
      ? `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/${img.storage_bucket || 'gallery-images'}/${img.storage_path}`
      : 'assets/images/' + img.filename,
    uploader: img.uploader ? {
      id: img.uploader.id,
      uid: img.uploader.uid,
      username: img.uploader.username,
      display_name: img.uploader.display_name,
      avatar: img.uploader.avatar,
    } : null,
  }));
  return cors({ success: true, data: { images, limit, offset } });
}

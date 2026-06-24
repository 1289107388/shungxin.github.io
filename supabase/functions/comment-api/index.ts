// ============================
// comment-api Edge Function
// 控制层：路由分发、参数校验、限流
// 业务层：评论查询、创建、Giscus 同步
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

const COMMENT_MAX_PER_MINUTE = 5;
const COMMENT_WINDOW_MS = 60000;
const COMMENT_MAX_LENGTH = 1000;
const PAGE_MAX_SIZE = 50;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/comment-api\/?/, '') || 'list';

  try {
    switch (path) {
      case 'list': return await handleListComments(url);
      case 'create': return await handleCreateComment(req);
      case 'sync-giscus': return await handleGiscusSync(req);
      case 'delete': return await handleDeleteComment(req);
      default: return createErrorResponse('未知接口', 404);
    }
  } catch (err) {
    console.error('comment-api 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

async function handleListComments(url) {
  const imageId = parseInt(url.searchParams.get('image_id') || '0');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(PAGE_MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('limit') || '20')));
  const sort = url.searchParams.get('sort') || 'newest';

  if (!imageId || imageId <= 0) return createErrorResponse('image_id 无效', 400);

  const supabase = createServiceClient();
  const offset = (page - 1) * limit;
  const ascending = sort === 'oldest';

  const { count: totalCount, error: countError } = await supabase
    .from('comments').select('*', { count: 'exact', head: true })
    .eq('image_id', imageId).eq('status', 'approved');
  if (countError) console.error('查询评论总数失败:', countError);

  const { data: comments, error } = await supabase
    .from('comments')
    .select('id, image_id, content, github_username, github_avatar, rating, likes_count, parent_id, status, created_at, updated_at')
    .eq('image_id', imageId).eq('status', 'approved')
    .order('created_at', { ascending })
    .range(offset, offset + limit - 1);

  if (error) { console.error('查询评论失败:', error); return createErrorResponse('查询评论失败', 500); }

  const total = totalCount || 0;
  return createCorsResponse({
    success: true, data: comments || [],
    pagination: { page, limit, total, hasMore: offset + (comments?.length || 0) < total, totalPages: Math.ceil(total / limit) },
  });
}

async function handleCreateComment(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { image_id, content, github_username, github_avatar, rating, parent_id } = body;

  if (!image_id || typeof image_id !== 'number' || image_id <= 0) return createErrorResponse('image_id 无效', 400);
  if (!content || typeof content !== 'string' || content.trim().length < 2) return createErrorResponse('评论内容至少2个字符', 400);
  if (content.length > COMMENT_MAX_LENGTH) return createErrorResponse(`评论内容不能超过 ${COMMENT_MAX_LENGTH} 字符`, 400);

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateKey = `comment:${clientIp}:${github_username || clientIp}`;
  const rateCheck = checkRateLimit(rateKey, COMMENT_MAX_PER_MINUTE, COMMENT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return createErrorResponse(`评论过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  const cleanContent = await filterSensitiveWords(content.trim());
  const supabase = createServiceClient();

  const { data: comment, error } = await supabase.from('comments').insert({
    image_id, content: cleanContent,
    github_username: github_username || '匿名用户',
    github_avatar: github_avatar || null,
    rating: rating && rating >= 1 && rating <= 5 ? rating : null,
    parent_id: parent_id || null,
    status: 'approved', source: 'website',
    created_at: new Date().toISOString(),
  }).select().single();

  if (error) { console.error('创建评论失败:', error); return createErrorResponse('创建评论失败', 500); }

  return createCorsResponse({
    success: true, message: '评论发布成功', data: comment,
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  });
}

async function handleDeleteComment(req) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return createErrorResponse('仅支持 POST/DELETE 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { comment_id, admin_token } = body;
  if (!comment_id || typeof comment_id !== 'number') return createErrorResponse('comment_id 无效', 400);

  const validAdminToken = Deno.env.get('ADMIN_TOKEN') || 'shungxin_admin_2024';
  if (admin_token !== validAdminToken) return createErrorResponse('无权操作', 403);

  const supabase = createServiceClient();
  const { error } = await supabase.from('comments').delete().eq('id', comment_id);
  if (error) { console.error('删除评论失败:', error); return createErrorResponse('删除评论失败', 500); }

  return createCorsResponse({ success: true, message: '评论已删除' });
}

async function handleGiscusSync(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  const payload = await req.json().catch(() => null);
  if (!payload) return createErrorResponse('无效的 Webhook 载荷', 400);

  const eventType = req.headers.get('x-github-event') || '';
  if (eventType !== 'discussion' && eventType !== 'discussion_comment') {
    return createCorsResponse({ success: true, message: '事件类型无需处理' });
  }

  const supabase = createServiceClient();
  try {
    if (eventType === 'discussion' && payload.action === 'created') {
      await syncDiscussion(supabase, payload.discussion);
    } else if (eventType === 'discussion_comment' && payload.action === 'created') {
      await syncDiscussionComment(supabase, payload);
    }
    return createCorsResponse({ success: true, message: '同步成功' });
  } catch (err) {
    console.error('Giscus 同步失败:', err);
    return createErrorResponse('同步失败', 500);
  }
}

async function syncDiscussion(supabase, discussion) {
  const title = (discussion.title || '');
  const match = title.match(/image[-_]?(\d+)/i);
  const imageId = match ? parseInt(match[1]) : null;
  if (!imageId) { console.log('无法从 Discussion 标题提取 image_id:', title); return; }

  await supabase.from('comment_sync_logs').insert({
    event_type: 'discussion_created', github_discussion_id: discussion.id,
    image_id: imageId, payload: JSON.stringify(discussion), created_at: new Date().toISOString(),
  });
}

async function syncDiscussionComment(supabase, payload) {
  const comment = payload.comment || {};
  const discussion = payload.discussion || {};
  if (!comment || !discussion) return;

  const title = (discussion.title || '');
  const match = title.match(/image[-_]?(\d+)/i);
  const imageId = match ? parseInt(match[1]) : null;
  if (!imageId) { console.log('无法从 Discussion 标题提取 image_id:', title); return; }

  const user = comment.user || {};

  const { data: existing } = await supabase.from('comments').select('id').eq('github_comment_id', comment.id).maybeSingle();
  if (existing) { console.log('评论已同步，跳过:', comment.id); return; }

  const { error } = await supabase.from('comments').insert({
    image_id: imageId, content: (comment.body || ''),
    github_username: (user.login || 'GitHub用户'),
    github_avatar: (user.avatar_url || null),
    github_comment_id: comment.id, github_discussion_id: discussion.id,
    status: 'approved', source: 'giscus',
    created_at: (comment.created_at || new Date().toISOString()),
  });

  if (error) { console.error('同步评论到数据库失败:', error); throw error; }

  await supabase.from('comment_sync_logs').insert({
    event_type: 'comment_created', github_comment_id: comment.id,
    github_discussion_id: discussion.id, image_id: imageId,
    payload: JSON.stringify(payload), created_at: new Date().toISOString(),
  });

  console.log('Giscus 评论同步成功:', comment.id, '-> image_id:', imageId);
}

async function filterSensitiveWords(text) {
  const defaultWords = ['脏话', '垃圾', '傻逼', '他妈的'];
  try {
    const supabase = createServiceClient();
    const { data: words } = await supabase.from('sensitive_words').select('word').eq('is_active', true);
    const sensitiveWords = (words || []).map((w) => w.word);
    const allWords = [...defaultWords, ...sensitiveWords];
    let filtered = text;
    allWords.forEach((word) => {
      if (word) {
        const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        filtered = filtered.replace(regex, '*'.repeat(word.length));
      }
    });
    return filtered;
  } catch { return text; }
}

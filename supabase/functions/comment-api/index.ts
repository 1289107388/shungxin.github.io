// ============================
// comment-api Edge Function
// 控制层：路由分发、参数校验、限流
// 业务层：评论查询、创建、点赞、回复（嵌套）、Giscus 同步
// 数据层：通过 Service Role 操作 PostgreSQL
// ============================

import { verifyOrigin } from '../_shared/originGuard.ts';
import { safeParseInt } from '../_shared/safeParams.ts';
import { getSiteSettings, parseBool } from '../_shared/siteSettings.ts';
import { sendNotificationEmail } from '../_shared/emailNotifier.ts';
import { CORS_HEADERS, createCorsResponse, createErrorResponse } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabaseClient.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';

const COMMENT_MAX_PER_MINUTE = 5;
const COMMENT_WINDOW_MS = 60000;
const COMMENT_MAX_LENGTH = 1000;
const PAGE_MAX_SIZE = 50;
const COMMENT_LIKE_MAX_PER_MINUTE = 30;
const COMMENT_LIKE_WINDOW_MS = 60000;

Deno.serve(async (req) => {
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/.*\/comment-api\/?/, '') || 'list';

  try {
    switch (path) {
      case 'list':           return await handleListComments(url);
      case 'replies':        return await handleListReplies(url);
      case 'create':         return await handleCreateComment(req);
      case 'delete':         return await handleDeleteComment(req);
      case 'like-toggle':    return await handleLikeToggle(req);
      case 'sync-giscus':    return await handleGiscusSync(req);
      default: return createErrorResponse('未知接口', 404);
    }
  } catch (err) {
    console.error('comment-api 错误:', err);
    return createErrorResponse('服务器内部错误', 500);
  }
});

/**
 * 列出某张图片的"顶级评论"（parent_id IS NULL），按时间/点赞排序
 * Query:
 *   - image_id (required)
 *   - page / limit / sort (newest | oldest | likes)
 *   - user_id (optional) 访客/登录用户的标识，用于返回 liked_by_me
 * 返回:
 *   {
 *     data: Comment[],  // 顶级评论
 *     pagination: {...}
 *   }
 * 注：每个顶级评论同时附带 replies_count（子评论数量，不展开）
 */
async function handleListComments(url) {
  // 修复: 用 safeParseInt 防御 NaN -> .range(NaN, NaN) 触发 500
  const imageId = safeParseInt(url.searchParams.get('image_id'), 0, 1);
  const page = safeParseInt(url.searchParams.get('page'), 1, 1);
  const limit = safeParseInt(url.searchParams.get('limit'), 20, 1, 100);
  const sort = url.searchParams.get('sort') || 'newest';
  const userId = (url.searchParams.get('user_id') || '').trim();

  if (!imageId || imageId <= 0) return createErrorResponse('image_id 无效', 400);

  const supabase = createServiceClient();
  const offset = (page - 1) * limit;
  const ascending = sort === 'oldest';

  // 1) 顶级评论总数
  const { count: totalCount, error: countError } = await supabase
    .from('comments').select('*', { count: 'exact', head: true })
    .eq('image_id', imageId).eq('status', 'approved').is('parent_id', null);
  if (countError) console.error('查询评论总数失败:', countError);

  // 2) 顶级评论列表
  let query = supabase
    .from('comments')
    .select('id, image_id, content, github_username, github_avatar, rating, likes_count, parent_id, status, created_at, updated_at')
    .eq('image_id', imageId).eq('status', 'approved').is('parent_id', null);

  if (sort === 'likes') {
    query = query.order('likes_count', { ascending: false }).order('created_at', { ascending: false });
  } else {
    query = query.order('created_at', { ascending });
  }

  const { data: topComments, error } = await query.range(offset, offset + limit - 1);
  if (error) { console.error('查询评论失败:', error); return createErrorResponse('查询评论失败', 500); }

  const commentIds = (topComments || []).map((c) => c.id);

  // 3) 子评论数量（每个顶级评论下挂几条回复）
  let repliesCountMap = {};
  if (commentIds.length > 0) {
    const { data: replyRows, error: replyErr } = await supabase
      .from('comments')
      .select('parent_id')
      .in('parent_id', commentIds)
      .eq('status', 'approved');
    if (replyErr) console.error('查询子评论数失败:', replyErr);
    (replyRows || []).forEach((r) => {
      repliesCountMap[r.parent_id] = (repliesCountMap[r.parent_id] || 0) + 1;
    });
  }

  // 4) 当前用户对这些评论的点赞状态
  let likedSet = new Set();
  if (userId && commentIds.length > 0) {
    const { data: likeRows, error: likeErr } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', userId)
      .in('comment_id', commentIds);
    if (likeErr) console.error('查询评论点赞状态失败:', likeErr);
    (likeRows || []).forEach((r) => likedSet.add(r.comment_id));
  }

  const enriched = (topComments || []).map((c) => ({
    ...c,
    replies_count: repliesCountMap[c.id] || 0,
    liked_by_me: likedSet.has(c.id),
  }));

  const total = totalCount || 0;
  return createCorsResponse({
    success: true, data: enriched,
    pagination: { page, limit, total, hasMore: offset + enriched.length < total, totalPages: Math.ceil(total / limit) },
  });
}

/**
 * 列出某条顶级评论下的子回复（嵌套一级）
 * Query:
 *   - parent_id (required)
 *   - page / limit / sort
 *   - user_id (optional)
 */
async function handleListReplies(url) {
  // 修复: 用 safeParseInt 防御 NaN
  const parentId = safeParseInt(url.searchParams.get('parent_id'), 0, 1);
  const page = safeParseInt(url.searchParams.get('page'), 1, 1);
  const limit = safeParseInt(url.searchParams.get('limit'), 50, 1, 100);
  const userId = (url.searchParams.get('user_id') || '').trim();
  const sort = url.searchParams.get('sort') || 'oldest';

  if (!parentId || parentId <= 0) return createErrorResponse('parent_id 无效', 400);

  const supabase = createServiceClient();
  const offset = (page - 1) * limit;
  const ascending = sort === 'oldest';

  const { count: totalCount, error: countError } = await supabase
    .from('comments').select('*', { count: 'exact', head: true })
    .eq('parent_id', parentId).eq('status', 'approved');
  if (countError) console.error('查询回复总数失败:', countError);

  const { data: replies, error } = await supabase
    .from('comments')
    .select('id, image_id, content, github_username, github_avatar, rating, likes_count, parent_id, reply_to_username, status, created_at, updated_at')
    .eq('parent_id', parentId).eq('status', 'approved')
    .order('created_at', { ascending })
    .range(offset, offset + limit - 1);
  if (error) { console.error('查询回复失败:', error); return createErrorResponse('查询回复失败', 500); }

  // 当前用户的点赞状态
  const replyIds = (replies || []).map((r) => r.id);
  let likedSet = new Set();
  if (userId && replyIds.length > 0) {
    const { data: likeRows } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', userId)
      .in('comment_id', replyIds);
    (likeRows || []).forEach((r) => likedSet.add(r.comment_id));
  }

  const enriched = (replies || []).map((r) => ({ ...r, liked_by_me: likedSet.has(r.id) }));
  const total = totalCount || 0;
  return createCorsResponse({
    success: true, data: enriched,
    pagination: { page, limit, total, hasMore: offset + enriched.length < total, totalPages: Math.ceil(total / limit) },
  });
}

async function handleCreateComment(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { image_id, content, github_username, github_avatar, rating, parent_id, reply_to_username, user_id, user_token } = body;
  console.log('[create] body:', { image_id, parent_id, github_username, content_preview: (content || '').slice(0, 30), user_token: !!user_token });

  if (!image_id || typeof image_id !== 'number' || image_id <= 0) return createErrorResponse('image_id 无效', 400);
  if (!content || typeof content !== 'string' || content.trim().length < 2) return createErrorResponse('评论内容至少2个字符', 400);
  if (content.length > COMMENT_MAX_LENGTH) return createErrorResponse(`评论内容不能超过 ${COMMENT_MAX_LENGTH} 字符`, 400);

  // 如果是回复，验证 parent 评论存在并属于同一张图
  let parentComment = null;
  if (parent_id) {
    if (typeof parent_id !== 'number' || parent_id <= 0) return createErrorResponse('parent_id 无效', 400);
    const supabase = createServiceClient();
    const { data: p, error: pErr } = await supabase
      .from('comments').select('id, image_id, github_username, status, parent_id')
      .eq('id', parent_id).maybeSingle();
    if (pErr) { console.error('查询父评论失败:', pErr); return createErrorResponse('查询父评论失败', 500); }
    if (!p) return createErrorResponse('父评论不存在或已删除', 404);
    if (p.status !== 'approved') return createErrorResponse('父评论未通过审核', 403);
    // 标准化 image_id：PostgREST 数字列有时返回 string，强制用 Number 转换后比较
    const pImageId = Number(p.image_id);
    const reqImageId = Number(image_id);
    if (pImageId !== reqImageId) {
      console.warn(`[parent 校验失败] parent_id=${parent_id}, p.image_id=${JSON.stringify(p.image_id)} (${typeof p.image_id}), req.image_id=${JSON.stringify(image_id)} (${typeof image_id}), p.status=${p.status}, p.parent_id=${p.parent_id}`);
      return createErrorResponse(`父评论不属于该图片（父评论 image_id=${pImageId}，请求 image_id=${reqImageId}）`, 400);
    }
    parentComment = p;
  }

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateKey = `comment:${clientIp}:${github_username || clientIp}`;
  const rateCheck = checkRateLimit(rateKey, COMMENT_MAX_PER_MINUTE, COMMENT_WINDOW_MS);
  if (!rateCheck.allowed) {
    return createErrorResponse(`评论过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  // 可选:验证 user_token,关联到 users.id
  let authedUserId = null;
  if (user_token && typeof user_token === 'string') {
    try {
      const verifyResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/auth-api/me`, {
        headers: { 'Authorization': `Bearer ${user_token}` },
      });
      if (verifyResp.ok) {
        const me = await verifyResp.json();
        if (me && me.user && me.user.id) authedUserId = me.user.id;
      }
    } catch (e) { console.warn('user_token 验证失败:', e); }
  }

  const cleanContent = await filterSensitiveWords(content.trim());
  const supabase = createServiceClient();

  // 读取站点默认评论审核策略
  const settings = await getSiteSettings(supabase, [
    'site_name',
    'default_comment_status',
    'notify_on_pending_comment',
  ]);
  const defaultStatus = settings.default_comment_status === 'pending' ? 'pending' : 'approved';

  const baseInsert = {
    image_id, content: cleanContent,
    github_username: github_username || '匿名用户',
    github_avatar: github_avatar || null,
    rating: rating && rating >= 1 && rating <= 5 ? rating : null,
    parent_id: parent_id || null,
    status: defaultStatus, source: 'local',
    likes_count: 0,
    created_at: new Date().toISOString(),
  };
  if (authedUserId) baseInsert.user_id = authedUserId;

  // 第一次尝试：写入 reply_to_username（回复场景需要）
  // 如果数据库尚未运行 SQL 迁移（reply_to_username 字段不存在），会自动回退到不带该字段
  let insertPayload = {
    ...baseInsert,
    reply_to_username: (parentComment && parentComment.github_username) || reply_to_username || null,
  };
  let { data: comment, error } = await supabase.from('comments').insert(insertPayload).select().single();

  // 兼容老 schema：reply_to_username 字段不存在时回退
  if (error && /(column .*reply_to_username.* does not exist|reply_to_username.* not found)/i.test(error.message || '')) {
    console.warn('comments 表缺少 reply_to_username 字段，自动回退写入。请运行 sql/create_comment_likes.sql 添加该字段。');
    insertPayload = { ...baseInsert };
    ({ data: comment, error } = await supabase.from('comments').insert(insertPayload).select().single());
  }

  if (error) {
    console.error('创建评论失败: code=' + (error.code || '?') + ', msg=' + (error.message || '') + ', details=' + (error.details || '') + ', hint=' + (error.hint || ''));
    return createErrorResponse('创建评论失败: ' + (error.message || '未知错误'), 500);
  }

  // 待审核评论邮件通知管理员
  if (comment && comment.status === 'pending' && parseBool(settings.notify_on_pending_comment)) {
    try {
      await sendNotificationEmail(supabase, {
        subject: `[${settings.site_name || '站点'}] 有新评论待审核`,
        text: `图片 ID: ${image_id}\n作者: ${comment.github_username || '匿名用户'}\n内容: ${(comment.content || '').slice(0, 200)}\n时间: ${comment.created_at}\n请登录管理后台处理。`,
        tags: ['pending_comment'],
      });
    } catch (e) {
      console.warn('待审核评论邮件通知失败:', e);
    }
  }

  return createCorsResponse({
    success: true, message: parent_id ? '回复发布成功' : '评论发布成功', data: comment,
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  });
}

async function handleDeleteComment(req) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return createErrorResponse('仅支持 POST/DELETE 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { comment_id, admin_token } = body;
  if (!comment_id || typeof comment_id !== 'number') return createErrorResponse('comment_id 无效', 400);

  const validAdminToken = Deno.env.get('ADMIN_TOKEN');
  if (!validAdminToken || validAdminToken.length < 32) {
    console.error('[comment-api] ADMIN_TOKEN 未配置或过短,拒绝删除');
    return createErrorResponse('服务端未配置管理员令牌', 500);
  }
  if (admin_token !== validAdminToken) return createErrorResponse('无权操作', 403);

  const supabase = createServiceClient();
  // 修复: 先查出所有子回复 id,清理它们对应的 comment_likes,
  // 否则会留孤儿数据 (子回复删了但它们的 likes 记录还在)
  const { data: childIds } = await supabase
    .from('comments')
    .select('id')
    .eq('parent_id', comment_id);
  if (childIds && childIds.length > 0) {
    const ids = childIds.map((c) => c.id);
    const { error: likeErr } = await supabase
      .from('comment_likes')
      .delete()
      .in('comment_id', ids);
    if (likeErr) console.warn('清理子回复 likes 失败:', likeErr);
  }

  // 删除父评论
  const { error: r1 } = await supabase.from('comments').delete().eq('id', comment_id);
  if (r1) { console.error('删除评论失败:', r1); return createErrorResponse('删除评论失败', 500); }
  // 删除子回复
  await supabase.from('comments').delete().eq('parent_id', comment_id);
  // 删除父评论自己的 likes
  await supabase.from('comment_likes').delete().eq('comment_id', comment_id);

  return createCorsResponse({ success: true, message: '评论已删除' });
}

/**
 * 评论点赞 / 取消点赞
 * Body:
 *   - comment_id (number, required)
 *   - action ('like' | 'unlike', required)
 *   - user_id (string, required)  访客 ID 或登录用户 ID
 */
async function handleLikeToggle(req) {
  if (req.method !== 'POST') return createErrorResponse('仅支持 POST 请求', 405);

  let body;
  try { body = await req.json(); } catch { return createErrorResponse('请求体必须是有效的 JSON', 400); }

  const { comment_id, action, user_id } = body;
  if (!comment_id || typeof comment_id !== 'number' || comment_id <= 0) return createErrorResponse('comment_id 必须是正整数', 400);
  if (!action || (action !== 'like' && action !== 'unlike')) return createErrorResponse('action 必须是 like 或 unlike', 400);
  if (!user_id || typeof user_id !== 'string' || user_id.length < 3) return createErrorResponse('user_id 无效', 400);

  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const rateKey = `comment_like:${clientIp}:${user_id}`;
  const rateCheck = checkRateLimit(rateKey, COMMENT_LIKE_MAX_PER_MINUTE, COMMENT_LIKE_WINDOW_MS);
  if (!rateCheck.allowed) {
    return createErrorResponse(`操作过于频繁，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`, 429);
  }

  const supabase = createServiceClient();

  // 1) 验证评论存在
  const { data: comment, error: cErr } = await supabase
    .from('comments').select('id, likes_count').eq('id', comment_id).maybeSingle();
  if (cErr) { console.error('查询评论失败:', cErr); return createErrorResponse('查询评论失败', 500); }
  if (!comment) return createErrorResponse('评论不存在', 404);

  if (action === 'like') {
    // 幂等：使用 upsert（comment_id, user_id 唯一）
    const { error: insErr } = await supabase
      .from('comment_likes')
      .upsert({ comment_id, user_id, created_at: new Date().toISOString() }, { onConflict: 'comment_id,user_id', ignoreDuplicates: true });
    if (insErr) { console.error('点赞写入失败:', insErr); return createErrorResponse('点赞失败', 500); }
  } else {
    await supabase.from('comment_likes').delete().eq('comment_id', comment_id).eq('user_id', user_id);
  }

  // 2) 重新统计真实数量并写回 comments.likes_count
  const { count: realCount, error: cntErr } = await supabase
    .from('comment_likes').select('*', { count: 'exact', head: true }).eq('comment_id', comment_id);
  if (cntErr) console.error('统计点赞数失败:', cntErr);
  const finalCount = realCount || 0;

  await supabase.from('comments').update({ likes_count: finalCount, updated_at: new Date().toISOString() }).eq('id', comment_id);

  return createCorsResponse({
    success: true,
    message: action === 'like' ? '点赞成功' : '已取消点赞',
    data: { comment_id, action, count: finalCount, liked_by_me: action === 'like' },
    rateLimit: { remaining: rateCheck.remaining, resetAt: new Date(rateCheck.resetAt).toISOString() },
  });
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
    likes_count: 0,
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

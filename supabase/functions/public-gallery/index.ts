// ============================
// public-gallery Edge Function
// 公开接口(免鉴权),给主站前台使用:
//   GET /public-gallery/images        -> 所有可见图片列表
//   GET /public-gallery/images/:id    -> 单张图片详情
// 缓存: 1 分钟(用 stale-while-revalidate 头部)
// 注意: 永远只返回 is_visible = true 的图
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { verifyOrigin } from '../_shared/originGuard.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
const PAID_AREA_JWT_SECRET = Deno.env.get('PAID_AREA_JWT_SECRET') || '';

// public-gallery 限流:120 次/分钟/IP(防爬虫,正常浏览很够)
const PUBLIC_GALLERY_RATE_LIMIT_PER_MIN = 120;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info, X-Paid-Area-Token',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
};
function cors(body, status = 200, isPaid = false) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  if (isPaid) {
    // 付费区响应包含鉴权状态，禁止任何缓存
    headers['Cache-Control'] = 'no-store, private';
    headers['Vary'] = 'X-Paid-Area-Token, Authorization';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// ---------- 付费区 token 校验（与 paid-area-auth 同源实现） ----------
function base64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(key, data) {
  const km = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', km, new TextEncoder().encode(data)));
}

async function verifyPaidAreaToken(token) {
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

function extractPaidAreaToken(req) {
  const header = req.headers.get('x-paid-area-token');
  if (header) return header.trim();
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

Deno.serve(async (req) => {
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return cors({ error: '仅支持 GET' }, 405);
  }

  // 限流:120 次/分钟/IP(防爬虫)
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const rl = checkRateLimit(`public-gallery:${clientIp}`, PUBLIC_GALLERY_RATE_LIMIT_PER_MIN, 60_000);
  if (!rl.allowed) {
    return cors({ error: '请求过于频繁,请稍后再试' }, 429);
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/.*\/public-gallery\/?/, '').split('/').filter(Boolean);

  // 用 anon key (走 RLS) 或者 service role? 这里用 service role,
  // 因为我们已经在 where 里硬过滤 is_visible = true,加上 anon key
  // 也可以,但 service role 更稳 (RLS 策略随时可能变)
  const supabase = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 解析 area 与付费区 token（列表与详情共用）
  const areaParam = (url.searchParams.get('area') || 'public').toLowerCase();
  const requestedArea = areaParam === 'paid' ? 'paid' : 'public';
  const paidToken = extractPaidAreaToken(req);
  const paidAccess = requestedArea === 'paid' ? await verifyPaidAreaToken(paidToken) : false;

  try {
    if (parts[0] === 'images' && parts.length === 1) {
      // 列表
      if (requestedArea === 'paid' && !paidAccess) {
        return cors({ error: '需要付费区访问权限', code: 'PAID_AREA_REQUIRED' }, 401, true);
      }
      // 兼容老 schema (没有 storage_path 等字段): 用 * 查询,代码里做 null 处理
      // 同时关联 users 表取上传者公开信息(FK uploaded_by -> users.id)
      const { data, error } = await supabase
        .from('gallery_images')
        .select(`*, uploader:users!uploaded_by(id, username, display_name, avatar)`)
        .eq('is_visible', true)
        .eq('area', requestedArea)
        .order('sort_order', { ascending: true });
      if (error) { console.error('查询图片失败:', error); return cors({ error: '查询失败', detail: error.message || String(error) }, 500); }

      const enriched = (data || []).map(img => ({
        id: img.id,
        filename: img.filename,
        title: img.title || img.filename,
        category: img.category,
        area: img.area || 'public',
        is_new: img.is_new,
        is_visible: img.is_visible,            // 真实数据库值
        sort_order: img.sort_order,
        description: img.description,
        created_at: img.created_at,
        width: img.width ?? null, height: img.height ?? null,
        // 老图(无 storage_path)用相对路径,主站部署在任何域名都能正确加载
        // 新图(有 storage_path)用 Supabase Storage public URL
        src: img.storage_path
          ? `${SUPABASE_URL}/storage/v1/object/public/${img.storage_bucket || 'gallery-images'}/${img.storage_path}`
          : 'assets/images/' + img.filename,
        is_local: !img.storage_path,           // 标记: 老图 = 走主站静态资源
        uploaded_by: img.uploaded_by ?? null,
        uploader: img.uploader ? {
          id: img.uploader.id,
          username: img.uploader.username,
          display_name: img.uploader.display_name,
          avatar: img.uploader.avatar,
        } : null,
      }));
      return cors({ success: true, data: { images: enriched, area: requestedArea } }, 200, requestedArea === 'paid');
    }

    if (parts[0] === 'images' && parts.length === 2) {
      const id = parseInt(parts[1], 10);
      if (!Number.isInteger(id)) return cors({ error: 'id 必须是数字' }, 400);
      const { data, error } = await supabase
        .from('gallery_images')
        .select(`*, uploader:users!uploaded_by(id, username, display_name, avatar)`)
        .eq('id', id)
        .eq('is_visible', true)
        .maybeSingle();
      if (error) { console.error('查询图片失败:', error); return cors({ error: '查询失败', detail: error.message || String(error) }, 500); }
      if (!data) return cors({ error: '图片不存在或不可见' }, 404);
      // 付费区单图必须携带有效 token（对外统一返回 404，避免泄露存在性）
      if (data.area === 'paid' && !paidAccess) {
        return cors({ error: '图片不存在或不可见' }, 404, true);
      }
      const src = data.storage_path
        ? `${SUPABASE_URL}/storage/v1/object/public/${data.storage_bucket || 'gallery-images'}/${data.storage_path}`
        : 'assets/images/' + data.filename;
      const uploader = data.uploader ? {
        id: data.uploader.id,
        username: data.uploader.username,
        display_name: data.uploader.display_name,
        avatar: data.uploader.avatar,
      } : null;
      const isPaidImg = data.area === 'paid';
      return cors({ success: true, data: { ...data, area: data.area || 'public', src, uploader } }, 200, isPaidImg);
    }

    return cors({ error: '未知接口' }, 404);
  } catch (err) {
    console.error('public-gallery 错误:', err);
    return cors({ error: '服务器内部错误' }, 500);
  }
});

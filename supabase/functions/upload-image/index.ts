// ============================
// upload-image Edge Function
// 功能: 接收 multipart/form-data 上传的图片
//       -> sharp 压缩 + 转 WebP (1280 长边, quality 82)
//       -> 存到 Supabase Storage (gallery-images 桶)
//       -> 写一条记录到 gallery_images 表
// 鉴权: admin HMAC token (复用 admin-api 同一套)
// 限制: 单图 10MB;jpg/png/webp/heic/avif
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
// sharp 通过 npm: 协议加载 (Deno 1.40+ 原生支持)
// 注意: Supabase Edge Functions 的 Deno 版本可能不支持最新 sharp,
// 用 v0.33.5 是最稳的兼容版本
import sharp from 'npm:sharp@0.33.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const AUTH_SECRET = Deno.env.get('AUTH_SECRET') || 'shungxin_auth_secret_2024_change_in_prod';
const BUCKET = 'gallery-images';

// ---------- CORS ----------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info, X-Client-Token',
  'Access-Control-Max-Age': '86400',
};
function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
function err(message, status = 400) {
  return cors({ error: message }, status);
}

// ---------- Token 验证 (与 admin-api 一致) ----------
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
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [pb64, sb64] = token.split('.');
  if (!pb64 || !sb64) return null;
  const expected = await hmacSha256(AUTH_SECRET, pb64);
  const provided = base64urlDecode(sb64);
  if (expected.length !== provided.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  if (diff !== 0) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlDecode(pb64))); }
  catch { return null; }
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}
async function requireAdmin(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: err('未登录', 401) };
  const payload = await verifyToken(token);
  if (!payload) return { error: err('Token 无效或已过期', 401) };
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: row } = await supabase
    .from('users')
    .select('id, username, display_name, role, is_active')
    .eq('id', payload.sub)
    .maybeSingle();
  if (!row) return { error: err('用户不存在', 401) };
  if (!row.is_active) return { error: err('账号已被禁用', 403) };
  // 改造: 允许 user 和 admin 两种角色上传
  // - admin 上传的图默认立即可见 (is_visible=true)
  // - user  上传的图默认待审核 (is_visible=false), admin 在后台通过后才可见
  if (row.role !== 'admin' && row.role !== 'user') return { error: err('无上传权限', 403) };
  return { user: row };
}

// ---------- 用户上传限流 (每用户每天 5 张) ----------
const userUploadCounts = new Map(); // key: user_id, value: { count, resetAt }
function checkUserUploadLimit(userId) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const MAX = 5;
  const entry = userUploadCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    userUploadCounts.set(userId, { count: 1, resetAt: now + DAY });
    return { allowed: true, remaining: MAX - 1 };
  }
  if (entry.count >= MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: MAX - entry.count };
}

// ---------- 主入口 ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return err('仅支持 POST', 405);

  // 1) 鉴权 (user 或 admin)
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const user = auth.user;
  const isAdmin = user.role === 'admin';

  // 1b) 普通用户限流:每天 5 张
  if (!isAdmin) {
    const rl = checkUserUploadLimit(user.id);
    if (!rl.allowed) {
      const hours = Math.ceil((rl.resetAt - Date.now()) / 3600000);
      return err(`今日上传已达上限(5 张),请 ${hours} 小时后再试`, 429);
    }
  }

  // 2) 解析 multipart/form-data
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return err('Content-Type 必须是 multipart/form-data', 400);
  }
  let form;
  try { form = await req.formData(); }
  catch (e) { return err('multipart 解析失败: ' + e.message, 400); }

  const file = form.get('file');
  if (!file || !(file instanceof File)) return err('缺少 file 字段', 400);

  // 可选字段
  const title = (form.get('title') || '').toString().trim() || null;
  const category = (form.get('category') || 'portrait').toString().trim().slice(0, 32) || 'portrait';
  const isNew = form.get('is_new') === 'true' || form.get('is_new') === '1';
  const isVisible = form.get('is_visible') !== 'false' && form.get('is_visible') !== '0';
  const sortOrder = parseInt((form.get('sort_order') || '99').toString(), 10) || 99;
  const description = (form.get('description') || '').toString().slice(0, 500) || null;

  // 3) 校验
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];
  if (!allowedTypes.includes(file.type)) {
    return err(`不支持的图片类型: ${file.type},仅支持 jpg/png/webp/heic/avif`, 400);
  }
  if (file.size > 10 * 1024 * 1024) {
    return err('图片大小不能超过 10MB', 400);
  }
  if (file.size === 0) return err('文件为空', 400);

  // 4) 压缩 + 转 WebP
  let processed: Uint8Array;
  let width: number;
  let height: number;
  try {
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    const image = sharp(inputBytes);
    const meta = await image.metadata();
    width = meta.width || 0;
    height = meta.height || 0;
    // 长边 1280, 质量 82, 自动旋转 EXIF
    processed = await image
      .rotate()                      // 修正 EXIF 朝向
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (e) {
    console.error('图片处理失败:', e);
    return err('图片处理失败: ' + (e.message || String(e)), 400);
  }

  // 5) 拼 storage path: YYYY/MM/DD/<random>.<ext>
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomUUID().slice(0, 8);
  const storagePath = `${yyyy}/${mm}/${dd}/${rand}.webp`;

  // 6) 上传到 Storage
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, processed, {
      contentType: 'image/webp',
      cacheControl: '31536000',     // 1 年缓存(图片 hash 在路径里,改名即失效)
      upsert: false,
    });
  if (upErr) {
    console.error('Storage 上传失败:', upErr);
    return err('存储失败: ' + upErr.message, 500);
  }

  // 7) 写 gallery_images 表
  // 关键: 普通用户上传的图默认 is_visible=false (待审核)
  //       admin 上传的图尊重表单 is_visible 字段(默认 true)
  const finalIsVisible = isAdmin ? isVisible : false;
  const filename = storagePath.split('/').pop();   // 例如 'abc12345.webp'
  const { data: row, error: insErr } = await supabase
    .from('gallery_images')
    .insert({
      filename,
      title: title || filename,
      category,
      is_visible: finalIsVisible,
      is_new: isNew,
      sort_order: sortOrder,
      description,
      storage_path: storagePath,
      storage_bucket: BUCKET,
      width,
      height,
      size_bytes: processed.byteLength,
      mime_type: 'image/webp',
      uploaded_by: user.id,                  // 记录上传者
    })
    .select('id, filename, title, category, is_visible, is_new, sort_order, description, created_at, width, height, size_bytes, storage_path, storage_bucket, uploaded_by')
    .single();
  if (insErr) {
    // 失败回滚(删除刚上传的文件)
    await supabase.storage.from(BUCKET).remove([storagePath]);
    console.error('插入 gallery_images 失败:', insErr);
    return err('数据库写入失败: ' + insErr.message, 500);
  }

  // 8) 写审计日志
  try {
    await supabase.from('admin_audit_logs').insert({
      admin_id: user.id,
      admin_name: user.display_name || user.username,
      action: isAdmin ? 'images.upload' : 'images.user_upload',
      target_type: 'image',
      target_id: String(row.id),
      details: {
        storage_path: storagePath,
        size_bytes: processed.byteLength,
        width, height,
        uploaded_by_role: user.role,
        pending_review: !isAdmin,     // 标记是否待审核
      },
    });
  } catch (e) { console.warn('审计日志写入失败:', e); }

  // 9) 返回完整数据
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  return cors({
    success: true,
    data: {
      ...row,
      src: publicUrl,
      pending_review: !isAdmin,     // 告诉前端这张图是否待审核
    },
  }, 200);
});

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
import { verifyOrigin } from '../_shared/originGuard.ts';
import { checkRateLimit } from '../_shared/rateLimiter.ts';
// 注: 暂不压缩(避免 Deno Deploy 上 sharp/jsquash 的兼容问题)
// 用户上传原图直接存,后续可挂 Cloudflare Images / imgproxy 做边缘压缩

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const AUTH_SECRET_RAW = Deno.env.get('AUTH_SECRET');
if (!AUTH_SECRET_RAW || AUTH_SECRET_RAW.length < 32) {
  throw new Error('AUTH_SECRET 环境变量未设置或长度不足 32 字符');
}
const AUTH_SECRET = AUTH_SECRET_RAW;
const BUCKET = 'gallery-images';

// upload-image 的限流: 30 次/分钟/IP(防止刷配额)
// 注: 真正精细的每日 5 张限制在 handleUpload 里靠 user_id 计数
const UPLOAD_RATE_LIMIT_PER_MIN = 30;

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

// ---------- 图片宽高解析(纯 JS,支持 PNG/JPEG/GIF/WebP) ----------
function parseImageDimensions(bytes, mime) {
  // PNG: 8 byte signature + IHDR chunk
  //    0..8 = \x89PNG\r\n\x1a\n
  //    8..12 = IHDR chunk length (4)
  //    12..16 = "IHDR"
  //    16..20 = width (big-endian u32)
  //    20..24 = height
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { w: readU32BE(bytes, 16), h: readU32BE(bytes, 20) };
  }
  // JPEG: 找 SOF0/SOF2 marker
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      // SOF0..SOF15 (但 SOF4,SOF8,SOF12 跳过,SOF14 是 DQT 不算)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { w: readU16BE(bytes, i + 5), h: readU16BE(bytes, i + 7) };
      }
      // 跳过这个 segment
      const segLen = readU16BE(bytes, i + 2);
      i += 2 + segLen;
    }
  }
  // GIF: 'GIF87a' / 'GIF89a' (6 字节) + 2 字节宽 + 2 字节高
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: readU16LE(bytes, 6), h: readU16LE(bytes, 8) };
  }
  // WebP: 复杂(RIFF 容器,可能 VP8 / VP8L / VP8X),简单起见返 0
  return { w: 0, h: 0 };
}
function readU32BE(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function readU16BE(b, o) { return (b[o] << 8) | b[o + 1]; }
function readU16LE(b, o) { return b[o] | (b[o + 1] << 8); }

// ===== P0-1.3: 魔数二次校验 =====
// 给定文件前 16 字节 + 声明的 MIME,验证文件头是否匹配
// 严格检查:file.type 是客户端声明,这里只允许 mime 与 header 真正一致的请求通过
function verifyImageMagicHeader(bytes, claimedMime) {
  if (!bytes || bytes.length < 4) return { ok: false, reason: '文件头太短' };

  // 探测真实类型
  let realType = null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) realType = 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
        && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) realType = 'image/png';
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) realType = 'image/webp';
  // GIF: 47 49 46 38
  else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) realType = 'image/gif';
  // HEIC/HEIF/AVIF: 头 4 字节任意,字节 4-7 = 66 74 79 70
  else if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (['heic', 'heix', 'heim', 'heis'].indexOf(brand) >= 0) realType = 'image/heic';
    else if (['mif1', 'msf1'].indexOf(brand) >= 0) realType = 'image/heif';
    else if (['avif', 'avis'].indexOf(brand) >= 0) realType = 'image/avif';
  }
  // BMP: 42 4D
  else if (bytes[0] === 0x42 && bytes[1] === 0x4D) realType = 'image/bmp';

  if (!realType) {
    return { ok: false, reason: '文件头不是已知图片格式' };
  }

  // 客户端声明的 mime 必须与真实文件头匹配(或在容差范围)
  // 例外:image/jpg / image/jpe 在浏览器里有时声明为 image/jpeg
  const normalize = (m) => (m || '').toLowerCase().replace('image/jpg', 'image/jpeg').replace('image/jpe', 'image/jpeg');
  if (normalize(claimedMime) !== normalize(realType)) {
    return { ok: false, reason: `声明 ${claimedMime} 但实际是 ${realType}` };
  }

  return { ok: true, type: realType };
}

// ---------- 主入口 ----------
Deno.serve(async (req) => {
  // 域名白名单
  const blocked = verifyOrigin(req);
  if (blocked) return blocked;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return err('仅支持 POST', 405);

  // 限流:按 IP,30 次/分钟
  // 真实部署时,Supabase Edge Function 拿不到真实 IP(只能拿到 Deno 内部 IP),
  // 用 'x-forwarded-for' 头作为 fallback
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const rl = checkRateLimit(`upload:${clientIp}`, UPLOAD_RATE_LIMIT_PER_MIN, 60_000);
  if (!rl.allowed) {
    return err(`上传过于频繁,请稍后再试(每分钟最多 ${UPLOAD_RATE_LIMIT_PER_MIN} 次)`, 429);
  }

  try {
    return await handleUpload(req);
  } catch (e) {
    console.error('upload-image 未捕获错误:', e);
    const msg = (e && e.message) || String(e);
    return err('服务器内部错误: ' + msg, 500);
  }
});

async function handleUpload(req) {
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

  // 3a) P0-1.3: 文件名黑名单(防止脚本/可执行文件伪装)
  const fname = (file.name || '').toLowerCase();
  const blockedExts = ['.php', '.exe', '.sh', '.bat', '.cmd', '.js', '.html', '.htm', '.svg', '.xml', '.asp', '.aspx', '.jsp', '.cgi', '.pl', '.py', '.phtml', '.phar'];
  for (const ext of blockedExts) {
    if (fname.endsWith(ext)) return err(`文件名后缀不允许: ${ext}`, 400);
  }

  // 3b) P0-1.3: 魔数二次校验(防绕过浏览器直接打 API)
  // file.type 是客户端声明的,完全可控,必须读真实文件头核对
  const headerBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const magicCheck = verifyImageMagicHeader(headerBytes, file.type);
  if (!magicCheck.ok) {
    return err(`文件内容与扩展名不符: ${magicCheck.reason}`, 400);
  }

  // 4) 暂不压缩: 原图直接使用(保持原 mime 和扩展名)
  //    后续可挂 CDN 边缘压缩,或部署到支持 sharp 的环境后再开启
  const inputBytes = new Uint8Array(await file.arrayBuffer());
  let width = 0;
  let height = 0;
  // 尝试从文件头解析宽高(PNG/JPEG 头里就有;WebP/AVIF 较复杂,这里用 0 兜底)
  try {
    const dims = parseImageDimensions(inputBytes, file.type);
    width = dims.w;
    height = dims.h;
  } catch { /* 解析失败不致命,存 0 */ }

  // 5) 拼 storage path: YYYY/MM/DD/<random>.<原 ext>
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomUUID().slice(0, 8);
  const ext = (file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const storagePath = `${yyyy}/${mm}/${dd}/${rand}.${ext}`;

  // 6) 上传到 Storage
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, inputBytes, {
      contentType: file.type,
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
  const filename = storagePath.split('/').pop();   // 例如 'abc12345.png'
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
      size_bytes: inputBytes.byteLength,
      mime_type: file.type,
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
        size_bytes: inputBytes.byteLength,
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
}

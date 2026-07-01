// ============================
// 站点设置读取辅助
// 所有 Edge Function 统一从这里读取 site_settings,
// 避免重复实现默认值与类型转换。
// ============================

const DEFAULTS: Record<string, string> = {
  site_name: 'shungxin-gallery',
  site_description: '',
  allow_user_upload: 'true',
  default_comment_status: 'approved',
  maintenance_mode: 'false',
  // 上传
  upload_max_size_bytes: String(10 * 1024 * 1024),
  upload_allowed_formats: 'jpg,png,webp,gif,heic,avif',
  upload_compression_threshold_bytes: String(1024 * 1024),
  upload_daily_limit_user: '5',
  // 公告
  site_announcement_enabled: 'false',
  site_announcement_content: '',
  // 存储
  storage_warning_threshold_percent: '80',
  storage_max_capacity_bytes: '0',
  // 邮件
  email_notifications_enabled: 'false',
  email_provider: 'webhook',
  email_webhook_url: '',
  email_from: '',
  email_to_admin: '',
  notify_on_pending_comment: 'true',
  notify_on_abnormal_login: 'true',
  // 首页 Hero 大图
  hero_enabled: 'true',
  hero_image_url: '',
  hero_title: '',
  hero_subtitle: '',
  hero_cta_text: '',
  hero_cta_link: '',
};

export async function getSiteSettings(supabase: any, keys?: string[]) {
  const targetKeys = keys || Object.keys(DEFAULTS);
  const { data, error } = await supabase
    .from('site_settings')
    .select('key, value')
    .in('key', targetKeys);
  if (error) {
    console.error('读取站点设置失败:', error);
  }
  const map: Record<string, string> = { ...DEFAULTS };
  (data || []).forEach((row: any) => {
    if (row.key && row.value !== undefined) map[row.key] = String(row.value);
  });
  return map;
}

export function parseBool(s: string | undefined): boolean {
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export function parseIntSafe(s: string | undefined, fallback: number): number {
  const n = parseInt(s || '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseFormats(s: string | undefined): string[] {
  return (s || '')
    .split(/[,，]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

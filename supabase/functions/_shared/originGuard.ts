// ============================
// originGuard: 域名白名单中间件
// 防止第三方网站盗用 Edge Function 配额
// 用法:
//   import { verifyOrigin } from '../_shared/originGuard.ts';
//   Deno.serve(async (req) => {
//     const blocked = verifyOrigin(req);
//     if (blocked) return blocked;
//     // ... 你的业务逻辑
//   });
// ============================

/**
 * 允许的 origin 列表(精确匹配或前缀匹配)
 * 维护规则:
 *   - 加新域名: 在这里加一行
 *   - 严格模式: 完全匹配
 *   - 通配模式: 以 * 结尾表示子域名通配(慎用)
 */
const ALLOWED_ORIGINS: Array<string> = [
  // Supabase Storage 静态托管(主站)
  'https://qlhfyawbyedhqokivezn.supabase.co',
  // Codebuddy Work 部署(当前实际部署地址)
  'https://eb671768e9c140a3aac69cb42140e506.app.codebuddy.work',
  // 旧部署地址(向后兼容)
  'https://shungxin.github.io',
  // 部署指南里提到的另一个 GitHub Pages 域名
  'https://1289107388.github.io',
  // 自定义域(预留,如果有)
  // 'https://gallery.shungxin.com',
];

/**
 * 本地开发 origin 规则:http://localhost:* 和 http://127.0.0.1:*
 */
function isLocalDev(origin: string): boolean {
  if (!origin) return false;
  // 允许 http://localhost:any-port 和 http://127.0.0.1:any-port
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * 检测 origin 是否在白名单
 * 返回 true = 放行, false = 拒绝
 */
export function isOriginAllowed(origin: string | null): boolean {
  // 没传 origin(curl / Postman / 服务端调用 / file://)默认放行
  // 这样 CI 脚本、cron job、Postman 调试都还能用
  if (!origin) return true;
  // 修复: 不再放行 origin === 'null'
  // 'Origin: null' 可被沙箱 iframe / data: URL / 跨域重定向伪造,
  // 一旦放行将完全绕过域名白名单
  if (origin === 'null') return false;

  // 精确匹配
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // 本地开发
  if (isLocalDev(origin)) return true;

  return false;
}

/**
 * Edge Function 入口处调用的 guard
 * 返回 null = 放行,Response = 拦截响应(直接 return 即可)
 */
export function verifyOrigin(req: Request): Response | null {
  const origin = req.headers.get('origin');

  // OPTIONS 预检请求: Edge Function 一般会自己处理 CORS,这里放行
  // 真正拒绝放在业务请求里,避免预检就 403 让浏览器看到 CORS 错
  if (req.method === 'OPTIONS') return null;

  if (!isOriginAllowed(origin)) {
    console.warn(`[originGuard] 拒绝来源: origin=${origin} ua=${req.headers.get('user-agent') || ''}`);
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: '当前 origin 未在白名单中',
        origin: origin,
      }),
      {
        status: 403,
        // 修复: 403 响应必须带 CORS 头,否则浏览器屏蔽响应体
        // 前端只能看到 "Failed to fetch",无法区分网络问题 vs origin 拒绝
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'apikey, Authorization, Content-Type, x-client-info',
        },
      }
    );
  }
  return null;
}

/**
 * 辅助:获取当前白名单(供管理页/调试页展示)
 */
export function getAllowedOrigins(): readonly string[] {
  return ALLOWED_ORIGINS;
}

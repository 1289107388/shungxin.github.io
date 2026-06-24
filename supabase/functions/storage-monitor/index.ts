// ============================
// storage-monitor Edge Function
// 控制层：定时触发 / 手动触发
// 业务层：查询数据库占用空间、判断是否告警
// 数据层：通过 Service Role 查询 PostgreSQL 系统表
// ============================

import { createServiceClient } from '../_shared/supabaseClient.ts';
import { createCorsResponse, createErrorResponse } from '../_shared/cors.ts';

// 告警阈值（500MB 免费额度，450MB 触发告警）
const STORAGE_LIMIT_MB = 500;
const STORAGE_WARNING_MB = 450;
const STORAGE_CRITICAL_MB = 480;

Deno.serve(async (req: Request) => {
  // === 1. 控制层：CORS 预检 ===
  if (req.method === 'OPTIONS') {
    return createCorsResponse({}, 204);
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return createErrorResponse('仅支持 GET/POST 请求', 405);
  }

  try {
    const result = await checkStorageUsage();
    return createCorsResponse(result, result.alert ? 200 : 200);
  } catch (err) {
    console.error('storage-monitor 错误:', err);
    return createErrorResponse('检查存储空间失败', 500);
  }
});

// ============================
// 业务层：检查存储空间使用情况
// ============================
async function checkStorageUsage(): Promise<{
  success: boolean;
  alert: boolean;
  level: 'normal' | 'warning' | 'critical';
  usageMB: number;
  limitMB: number;
  usagePercent: number;
  tables: Array<{
    tableName: string;
    sizeBytes: number;
    sizeMB: number;
    rowCount: number | null;
  }>;
  recommendations: string[];
  timestamp: string;
}> {
  const supabase = createServiceClient();

  // 查询各表占用空间
  const { data: tableSizes, error: sizeError } = await supabase.rpc('get_table_sizes');

  if (sizeError) {
    console.error('查询表大小失败:', sizeError);
    // 备用方案：直接查询 pg_class
    return await checkStorageFallback(supabase);
  }

  // 计算总占用
  let totalBytes = 0;
  const tables: Array<{
    tableName: string;
    sizeBytes: number;
    sizeMB: number;
    rowCount: number | null;
  }> = [];

  if (tableSizes && Array.isArray(tableSizes)) {
    tableSizes.forEach((row: Record<string, unknown>) => {
      const sizeBytes = parseInt(String(row.size_bytes || 0));
      totalBytes += sizeBytes;
      tables.push({
        tableName: String(row.table_name || 'unknown'),
        sizeBytes,
        sizeMB: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
        rowCount: row.row_count ? parseInt(String(row.row_count)) : null,
      });
    });
  }

  // 按大小排序
  tables.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const usageMB = Math.round((totalBytes / 1024 / 1024) * 100) / 100;
  const usagePercent = Math.round((usageMB / STORAGE_LIMIT_MB) * 1000) / 10;

  // 判断告警级别
  let level: 'normal' | 'warning' | 'critical' = 'normal';
  let alert = false;

  if (usageMB >= STORAGE_CRITICAL_MB) {
    level = 'critical';
    alert = true;
  } else if (usageMB >= STORAGE_WARNING_MB) {
    level = 'warning';
    alert = true;
  }

  // 生成建议
  const recommendations: string[] = [];

  if (level === 'critical') {
    recommendations.push('🚨 存储空间严重不足！请立即清理数据。');
    recommendations.push('建议清理 like_logs、comment_sync_logs 等日志表。');
    recommendations.push('建议清理超过30天的已删除评论记录。');
  } else if (level === 'warning') {
    recommendations.push('⚠️ 存储空间即将不足，建议提前清理。');
    recommendations.push('可清理超过90天的操作日志。');
  }

  // 大表建议
  const largeTables = tables.filter((t) => t.sizeMB > 10);
  if (largeTables.length > 0) {
    recommendations.push(`大表提醒: ${largeTables.map((t) => `${t.tableName}(${t.sizeMB}MB)`).join(', ')}`);
  }

  // 记录监控日志
  await supabase.from('storage_monitor_logs').insert({
    usage_mb: usageMB,
    limit_mb: STORAGE_LIMIT_MB,
    usage_percent: usagePercent,
    alert_level: level,
    tables_snapshot: JSON.stringify(tables.slice(0, 10)),
    recommendations: JSON.stringify(recommendations),
    created_at: new Date().toISOString(),
  });

  return {
    success: true,
    alert,
    level,
    usageMB,
    limitMB: STORAGE_LIMIT_MB,
    usagePercent,
    tables: tables.slice(0, 20), // 只返回前20个大表
    recommendations,
    timestamp: new Date().toISOString(),
  };
}

// ============================
// 备用方案：使用原始 SQL 查询
// ============================
async function checkStorageFallback(supabase: ReturnType<typeof createServiceClient>) {
  // 查询所有表的大小
  const { data, error } = await supabase
    .from('information_schema.tables')
    .select('table_name')
    .eq('table_schema', 'public');

  if (error) {
    console.error('备用查询失败:', error);
    return {
      success: false,
      alert: true,
      level: 'critical' as const,
      usageMB: 0,
      limitMB: STORAGE_LIMIT_MB,
      usagePercent: 0,
      tables: [],
      recommendations: ['无法获取存储空间信息，请检查数据库连接'],
      timestamp: new Date().toISOString(),
    };
  }

  // 简化返回
  return {
    success: true,
    alert: false,
    level: 'normal' as const,
    usageMB: 0,
    limitMB: STORAGE_LIMIT_MB,
    usagePercent: 0,
    tables: (data || []).map((t: { table_name: string }) => ({
      tableName: t.table_name,
      sizeBytes: 0,
      sizeMB: 0,
      rowCount: null,
    })),
    recommendations: ['存储监控函数需要数据库管理员权限执行 pg_size_pretty'],
    timestamp: new Date().toISOString(),
  };
}

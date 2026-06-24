// ============================
// Supabase 服务端客户端
// ============================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
}

/**
 * 创建具有服务角色权限的 Supabase 客户端
 * 用于 Edge Functions 内部操作数据库（绕过 RLS）
 */
export function createServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * 创建具有匿名权限的 Supabase 客户端
 * 用于验证 RLS 策略是否生效
 */
export function createAnonClient(anonKey: string) {
  return createClient(SUPABASE_URL, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

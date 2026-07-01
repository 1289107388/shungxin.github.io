// ============================
// 邮件通知发送辅助
// 支持两种模式:
//   1. webhook: POST 到管理员配置的 email_webhook_url,
//      由外部服务(如企业微信机器人/钉钉/自建 SMTP 服务)转发邮件。
//   2. resend: 直接调用 Resend API 发送邮件(需配置 RESEND_API_KEY 环境变量)。
// ============================

import { getSiteSettings, parseBool } from './siteSettings.ts';

export interface EmailPayload {
  to?: string;
  subject: string;
  text: string;
  html?: string;
  tags?: string[];
}

export async function sendNotificationEmail(
  supabase: any,
  payload: EmailPayload,
): Promise<{ success: boolean; error?: string; provider?: string }> {
  const settings = await getSiteSettings(supabase, [
    'email_notifications_enabled',
    'email_provider',
    'email_webhook_url',
    'email_from',
    'email_to_admin',
  ]);

  if (!parseBool(settings.email_notifications_enabled)) {
    return { success: true, provider: 'disabled' };
  }

  const provider = settings.email_provider || 'webhook';
  const to = payload.to || settings.email_to_admin;
  if (!to) {
    return { success: false, error: '未配置收件人(email_to_admin)' };
  }

  if (provider === 'resend') {
    return await sendViaResend(settings.email_from, to, payload);
  }

  // 默认 webhook
  const webhookUrl = settings.email_webhook_url;
  if (!webhookUrl) {
    return { success: false, error: '未配置邮件 webhook URL' };
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from: settings.email_from || 'noreply@example.com',
        subject: payload.subject,
        text: payload.text,
        html: payload.html || payload.text.replace(/\n/g, '<br>'),
        tags: payload.tags || [],
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return { success: false, error: `webhook ${resp.status}: ${txt}`, provider: 'webhook' };
    }
    return { success: true, provider: 'webhook' };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e), provider: 'webhook' };
  }
}

async function sendViaResend(
  from: string,
  to: string,
  payload: EmailPayload,
): Promise<{ success: boolean; error?: string; provider?: string }> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    return { success: false, error: '未配置 RESEND_API_KEY 环境变量', provider: 'resend' };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from || 'onboarding@resend.dev',
        to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        tags: payload.tags,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return { success: false, error: `resend ${resp.status}: ${txt}`, provider: 'resend' };
    }
    return { success: true, provider: 'resend' };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e), provider: 'resend' };
  }
}

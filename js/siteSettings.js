// 站点公共设置加载与公告渲染
(function () {
  'use strict';

  const CFG = window.AppConfig || {};
  // 直接拼 URL,避免老版本 config.js 的 getFunctionUrl 缓存问题
  const url = CFG.SUPABASE?.url
    ? `${CFG.SUPABASE.url}/functions/v1/admin-api/public-settings`
    : CFG.getFunctionUrl?.('adminApi', 'public-settings');
  if (!url) return;

  function setText(selector, text) {
    if (!text) return;
    const el = document.querySelector(selector);
    if (!el) return;
    // 保留 logo 后的 <span>.</span>（如果有）
    const suffix = el.querySelector('span');
    el.textContent = text;
    if (suffix) el.appendChild(suffix);
  }

  function setMeta(nameOrProp, value, isProperty) {
    if (!value) return;
    const attr = isProperty ? 'property' : 'name';
    const el = document.querySelector(`meta[${attr}="${nameOrProp}"]`);
    if (el) el.setAttribute('content', value);
  }

  async function load() {
    try {
      const res = await fetch(url, {
        headers: { 'apikey': CFG.SUPABASE?.anonKey || '' },
      });
      if (!res.ok) return;
      const { data } = await res.json();
      if (!data) return;

      // 维护模式:可扩展为全屏遮罩,这里先打日志
      if (data.maintenance_mode) {
        console.log('[siteSettings] 站点处于维护模式');
      }

      // 站点名称 -> 页面标题 / logo / 首页大标题
      if (data.site_name) {
        const titleEl = document.querySelector('title');
        if (titleEl && !titleEl.dataset.manual) titleEl.textContent = data.site_name;
        setText('.nav-logo', data.site_name);
        setText('.footer-logo', data.site_name);
        setText('.gallery-title', data.site_name);
        setMeta('og:title', data.site_name, true);
        setMeta('twitter:title', data.site_name, true);
      }

      // 站点描述 -> meta / 首页副标题
      if (data.site_description) {
        setMeta('description', data.site_description, false);
        setMeta('og:description', data.site_description, true);
        setMeta('twitter:description', data.site_description, true);
        const sub = document.querySelector('.gallery-subtitle');
        if (sub) sub.textContent = data.site_description;
      }

      // 渲染公告
      const ann = document.getElementById('siteAnnouncement');
      if (ann && data.site_announcement_enabled && data.site_announcement_content) {
        ann.innerHTML = data.site_announcement_content;
        ann.classList.remove('hidden');
        document.body.classList.add('has-announcement');
      }

      // 渲染首页 Hero 大图
      renderHero(data);
    } catch (e) {
      console.warn('加载站点公共设置失败:', e);
    }
  }

  function renderHero(data) {
    const section = document.getElementById('heroSection');
    if (!section) return;
    if (!data.hero_enabled) {
      section.classList.add('hidden');
      document.body.classList.remove('has-hero');
      return;
    }

    const img = document.getElementById('heroImg');
    const title = document.getElementById('heroTitle');
    const subtitle = document.getElementById('heroSubtitle');
    const cta = document.getElementById('heroCta');
    const ctaText = document.getElementById('heroCtaText');

    // 默认文案：未配置时展示站点名/描述
    const heroTitle = data.hero_title || data.site_name || '双薪写真';
    const heroSubtitle = data.hero_subtitle || data.site_description || '记录美好瞬间，定格珍贵回忆';

    if (img) {
      const url = data.hero_image_url || '';
      img.src = url;
      img.alt = heroTitle;
      if (!url) img.style.display = 'none';
      else img.style.display = '';
    }

    if (title) {
      title.innerHTML = splitWords(heroTitle);
      // 给每个词加递增延迟
      const words = title.querySelectorAll('.word');
      words.forEach((w, i) => { w.style.animationDelay = (0.35 + i * 0.12) + 's'; });
    }
    if (subtitle) subtitle.textContent = heroSubtitle;
    if (ctaText) ctaText.textContent = data.hero_cta_text || '进入画廊';
    if (cta && data.hero_cta_link) cta.href = data.hero_cta_link;

    section.classList.remove('hidden');
    document.body.classList.add('has-hero');

    bindHeroInteractions(section);
  }

  function splitWords(text) {
    return String(text || '')
      .split(/(\s+)/)
      .map(part => part.trim() ? `<span class="word">${escapeHtml(part)}</span>` : part)
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  function bindHeroInteractions(section) {
    const bg = document.getElementById('heroBg');
    const scrollBtn = document.getElementById('heroScroll');

    // 滚动视差：轻柔下移背景
    let ticking = false;
    function updateParallax() {
      const y = window.scrollY || 0;
      const vh = window.innerHeight || 1;
      const ratio = Math.min(y / vh, 1);
      if (bg) bg.style.setProperty('--hero-parallax', (ratio * 80) + 'px');
      ticking = false;
    }
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(updateParallax);
    }, { passive: true });
    updateParallax();

    // 滚动到底部提示 / 画廊
    if (scrollBtn) {
      scrollBtn.addEventListener('click', () => {
        const target = document.getElementById('gallery');
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();

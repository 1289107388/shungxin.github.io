(function(global) {
  'use strict';

  // 用户资料弹窗：展示公开资料 + 该用户已上架作品
  const modal = document.getElementById('userProfileModal');
  if (!modal) return;

  const closeBtn = document.getElementById('userProfileClose');
  const avatarEl = document.getElementById('profileAvatar');
  const nameEl = document.getElementById('profileName');
  const usernameEl = document.getElementById('profileUsername');
  const bioEl = document.getElementById('profileBio');
  const worksEl = document.getElementById('profileWorks');
  const likesEl = document.getElementById('profileLikes');
  const viewsEl = document.getElementById('profileViews');
  const loadingEl = document.getElementById('profileLoading');
  const gridEl = document.getElementById('profileGrid');

  let currentImages = [];

  function getConfig() {
    const cfg = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
    let url = cfg.url || 'https://qlhfyawbyedhqokivezn.supabase.co';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return { url, anonKey: cfg.anonKey || '' };
  }

  function formatNumber(n) {
    const num = Number(n) || 0;
    if (num >= 10000) return (num / 10000).toFixed(1) + 'w';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderAvatar(el, name, avatar) {
    el.innerHTML = '';
    if (avatar) {
      const img = document.createElement('img');
      img.src = avatar;
      img.alt = name;
      el.appendChild(img);
    } else {
      el.textContent = (name || '?').charAt(0).toUpperCase();
    }
  }

  async function fetchJson(url) {
    const { anonKey } = getConfig();
    const headers = {
      'apikey': anonKey,
      'Authorization': 'Bearer ' + anonKey,
    };
    const userToken = localStorage.getItem('shungxin_auth_token');
    if (userToken) headers['Authorization'] = 'Bearer ' + userToken;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ': ' + text);
    }
    return r.json();
  }

  function openModal() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    currentImages = [];
  }

  async function loadProfile(identifier) {
    const { url } = getConfig();
    const [profileRes, imagesRes] = await Promise.all([
      fetchJson(`${url}/functions/v1/user-api/public-profile/${encodeURIComponent(identifier)}`),
      fetchJson(`${url}/functions/v1/user-api/user-images/${encodeURIComponent(identifier)}`),
    ]);

    if (!profileRes.success || !profileRes.data) throw new Error('获取用户资料失败');
    const p = profileRes.data;

    // 渲染头部
    const displayName = p.display_name || p.username || '用户';
    renderAvatar(avatarEl, displayName, p.avatar);
    nameEl.textContent = escapeHtml(displayName);
    usernameEl.textContent = '@' + escapeHtml(p.username);
    bioEl.textContent = p.bio ? escapeHtml(p.bio) : '这位创作者还没有写简介';
    bioEl.style.display = 'block';
    worksEl.textContent = formatNumber(p.stats?.works_count);
    likesEl.textContent = formatNumber(p.stats?.total_likes);
    viewsEl.textContent = formatNumber(p.stats?.total_views);

    // 渲染作品
    loadingEl.style.display = 'none';
    gridEl.innerHTML = '';
    currentImages = (imagesRes.success && imagesRes.data && imagesRes.data.images) ? imagesRes.data.images : [];

    if (!currentImages.length) {
      gridEl.innerHTML = '<div class="profile-grid-empty">该创作者还没有公开作品</div>';
      return;
    }

    currentImages.forEach(img => {
      const item = document.createElement('div');
      item.className = 'profile-grid-item';
      item.title = img.title || '';
      const thumb = document.createElement('img');
      thumb.src = img.src;
      thumb.alt = img.title || '';
      thumb.loading = 'lazy';
      item.appendChild(thumb);
      item.addEventListener('click', () => openProfileImage(img));
      gridEl.appendChild(item);
    });
  }

  function openProfileImage(img) {
    // 优先在主页画廊中打开 lightbox（保证交互一致）
    if (global.imageData && global.openLightbox) {
      const all = global.imageData;
      const idx = all.findIndex(i => String(i.id) === String(img.id));
      if (idx >= 0) {
        closeModal();
        global.openLightbox(idx);
        return;
      }
    }
    //  fallback: 新标签页打开
    global.open(img.src, '_blank');
  }

  async function openUserProfile(identifier) {
    if (!identifier) return;
    openModal();
    // 重置状态
    avatarEl.textContent = 'U';
    nameEl.textContent = '加载中…';
    usernameEl.textContent = '';
    bioEl.textContent = '';
    worksEl.textContent = '0';
    likesEl.textContent = '0';
    viewsEl.textContent = '0';
    loadingEl.style.display = 'flex';
    gridEl.innerHTML = '';

    try {
      await loadProfile(identifier);
    } catch (e) {
      console.error('[userProfile] 加载失败:', e);
      nameEl.textContent = '加载失败';
      usernameEl.textContent = '';
      bioEl.textContent = e.message || '请检查网络或稍后重试';
      loadingEl.style.display = 'none';
      gridEl.innerHTML = '<div class="profile-grid-empty">无法加载该创作者资料</div>';
    }
  }

  // 事件绑定
  closeBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  // 暴露全局
  global.openUserProfile = openUserProfile;
  global.UserProfile = { open: openUserProfile, close: closeModal };
})(window);

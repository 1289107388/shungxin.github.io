(function(global) {
  'use strict';

  // 创作者发现页逻辑
  const grid = document.getElementById('creatorsGrid');
  const searchInput = document.getElementById('creatorsSearch');
  const sortContainer = document.getElementById('creatorsSort');
  if (!grid) return;

  let currentSort = 'works';
  let currentSearch = '';
  let isLoading = false;
  let hasMore = true;
  let offset = 0;
  const limit = 20;

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

  async function fetchCreators(append = false) {
    if (isLoading) return;
    isLoading = true;
    if (!append) {
      offset = 0;
      hasMore = true;
      grid.innerHTML = `
        <div class="profile-loading" style="grid-column:1 / -1;">
          <div class="profile-loading-spinner"></div>
          正在加载创作者…
        </div>
      `;
    }

    const { url, anonKey } = getConfig();
    const params = new URLSearchParams({
      sort: currentSort,
      search: currentSearch,
      limit: String(limit),
      offset: String(offset),
    });
    const headers = {
      'apikey': anonKey,
      'Authorization': 'Bearer ' + anonKey,
    };
    const userToken = localStorage.getItem('shungxin_auth_token');
    if (userToken) headers['Authorization'] = 'Bearer ' + userToken;

    try {
      const r = await fetch(`${url}/functions/v1/user-api/creators?${params}`, { headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j.success || !j.data || !Array.isArray(j.data.creators)) throw new Error('数据格式错误');

      const creators = j.data.creators;
      hasMore = creators.length === limit;

      if (!append) grid.innerHTML = '';
      if (!creators.length && offset === 0) {
        grid.innerHTML = `
          <div class="profile-grid-empty" style="grid-column:1 / -1;">
            未找到匹配的创作者
          </div>
        `;
        isLoading = false;
        return;
      }

      creators.forEach((c, idx) => {
        const rank = offset + idx + 1;
        const name = escapeHtml(c.display_name || c.username);
        const username = escapeHtml(c.username);
        const bio = escapeHtml(c.bio) || '这位创作者还没有写简介';
        const avatar = c.avatar
          ? `<img src="${escapeHtml(c.avatar)}" alt="${name}">`
          : `<span>${name.charAt(0).toUpperCase()}</span>`;
        const card = document.createElement('div');
        card.className = 'creator-card';
        card.innerHTML = `
          <div class="creator-card-rank">#${rank}</div>
          <div class="creator-card-avatar">${avatar}</div>
          <div class="creator-card-name">${name}</div>
          <div class="creator-card-username">@${username}</div>
          <div class="creator-card-bio">${bio}</div>
          <div class="creator-card-stats">
            <div class="creator-card-stat">
              <div class="creator-card-stat-value">${formatNumber(c.works_count)}</div>
              <div class="creator-card-stat-label">作品</div>
            </div>
            <div class="creator-card-stat">
              <div class="creator-card-stat-value">${formatNumber(c.total_likes)}</div>
              <div class="creator-card-stat-label">获赞</div>
            </div>
            <div class="creator-card-stat">
              <div class="creator-card-stat-value">${formatNumber(c.total_views)}</div>
              <div class="creator-card-stat-label">浏览</div>
            </div>
          </div>
        `;
        card.addEventListener('click', () => {
          if (typeof global.openUserProfile === 'function') {
            global.openUserProfile(c.username || String(c.id));
          }
        });
        grid.appendChild(card);
      });

      offset += creators.length;
    } catch (e) {
      console.error('[creators] 加载失败:', e);
      if (!append) {
        grid.innerHTML = `
          <div class="profile-grid-empty" style="grid-column:1 / -1;">
            加载创作者失败，请稍后重试
          </div>
        `;
      }
    } finally {
      isLoading = false;
    }
  }

  // 排序切换
  sortContainer?.addEventListener('click', (e) => {
    const btn = e.target.closest('.creators-sort-btn');
    if (!btn) return;
    sortContainer.querySelectorAll('.creators-sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSort = btn.dataset.sort;
    fetchCreators(false);
  });

  // 搜索防抖
  let searchTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const v = searchInput.value.trim();
    searchTimer = setTimeout(() => {
      currentSearch = v;
      fetchCreators(false);
    }, 350);
  });

  // 滚动加载更多
  window.addEventListener('scroll', () => {
    if (!hasMore || isLoading) return;
    const scrollBottom = window.innerHeight + window.scrollY;
    const threshold = document.body.offsetHeight - 300;
    if (scrollBottom >= threshold) {
      fetchCreators(true);
    }
  });

  // 初始加载
  fetchCreators(false);
})(window);

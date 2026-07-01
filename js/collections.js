// 图片合集前端模块
(function (global) {
  'use strict';

  const CFG = (global.AppConfig && global.AppConfig.SUPABASE) || global.SUPABASE_CONFIG || {};
  const ANON_KEY = CFG.anonKey || '';
  const API_URL = CFG.url ? `${CFG.url}/functions/v1/collections-api` : 'https://qlhfyawbyedhqokivezn.supabase.co/functions/v1/collections-api';

  function getPaidAreaToken() {
    try { return sessionStorage.getItem('shungxin_paid_area_token') || ''; }
    catch { return ''; }
  }

  function getHeaders() {
    const headers = {
      'apikey': ANON_KEY,
      'Authorization': 'Bearer ' + ANON_KEY,
    };
    if (global.__PAID_AREA_MODE) {
      const token = getPaidAreaToken();
      if (token) headers['X-Paid-Area-Token'] = token;
    }
    return headers;
  }

  async function fetchCollections(area) {
    const url = `${API_URL}/collections?area=${area || 'public'}`;
    const res = await fetch(url, { headers: getHeaders() });
    const json = await res.json().catch(() => ({ error: '解析失败' }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data || [];
  }

  async function fetchCollection(id) {
    const res = await fetch(`${API_URL}/collections/${id}`, { headers: getHeaders() });
    const json = await res.json().catch(() => ({ error: '解析失败' }));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  }

  function renderCollectionCard(collection, idx) {
    const cover = collection.cover_src || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return `
      <a href="collection.html?id=${collection.id}" class="collection-card" data-area="${collection.area}" data-aos="fade-up" data-aos-delay="${(idx % 8) * 60}">
        <div class="collection-cover" style="background-image:url('${cover}')"></div>
        <div class="collection-info">
          <h3 class="collection-name">${escapeHtml(collection.name)}</h3>
          <p class="collection-desc">${escapeHtml(collection.description || '')}</p>
          <span class="collection-count">${collection.image_count || 0} 张作品</span>
        </div>
      </a>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function renderCollections(containerId, area) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="loading">加载合集中…</div>';
    try {
      const list = await fetchCollections(area);
      if (!list.length) {
        container.innerHTML = '<div class="empty-state">暂无合集</div>';
        return;
      }
      container.innerHTML = `<div class="collections-grid">${list.map(renderCollectionCard).join('')}</div>`;
      if (window.AOS && typeof window.AOS.refresh === 'function') {
        window.AOS.refresh();
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(err.message)}</div>`;
      console.error('[collections] load error', err);
    }
  }

  async function renderCollectionDetail(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    if (!id) {
      container.innerHTML = '<div class="empty-state">缺少合集 ID</div>';
      return;
    }

    container.innerHTML = '<div class="loading">加载合集详情…</div>';
    try {
      const data = await fetchCollection(id);
      const html = `
        <div class="collection-detail-header">
          <h1 class="gallery-title">${escapeHtml(data.name)}</h1>
          <p class="gallery-subtitle">${escapeHtml(data.description || '')}</p>
          <span class="collection-count">${data.image_count || 0} 张作品</span>
        </div>
        <div class="gallery-grid" id="collectionImagesGrid">
          ${(data.images || []).map((img, idx) => `
            <div class="gallery-item" data-id="${img.id}" data-src="${img.src}" data-title="${escapeHtml(img.title || '')}" style="background-image:url('${img.src}')" data-aos="fade-up" data-aos-delay="${(idx % 8) * 60}">
              <div class="gallery-item-info"><span>${escapeHtml(img.title || img.filename || '')}</span></div>
            </div>
          `).join('')}
        </div>
      `;
      container.innerHTML = html;

      if (window.AOS && typeof window.AOS.refresh === 'function') {
        window.AOS.refresh();
      }

      // 绑定点击打开 lightbox
      const grid = document.getElementById('collectionImagesGrid');
      if (grid && global.openLightbox) {
        grid.addEventListener('click', (e) => {
          const item = e.target.closest('.gallery-item');
          if (!item) return;
          global.openLightbox(item.dataset.src, {
            title: item.dataset.title,
            id: item.dataset.id,
          });
        });
      }
    } catch (err) {
      container.innerHTML = `<div class="empty-state">加载失败：${escapeHtml(err.message)}</div>`;
      console.error('[collections] detail error', err);
    }
  }

  global.Collections = {
    renderList: renderCollections,
    renderDetail: renderCollectionDetail,
    fetchCollections,
    fetchCollection,
  };
})(window);

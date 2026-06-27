(function(global) {
  'use strict';


    /* ============================
       Image Data
       注意: 不再硬编码 15 张老图
       完全从 public-gallery 后端拉,这样 admin 隐藏任何图(含老图)主站立即不显示
       ============================ */
    const imageData = [];

    // 异步从 public-gallery 拉取所有可见图(老图+新图)
    (async () => {
      // P1 阶段 A: 优先从 window.AppConfig 读配置, 老 SUPABASE_CONFIG 作 fallback
      const cfg = window.AppConfig && window.AppConfig.SUPABASE ? window.AppConfig.SUPABASE : (window.SUPABASE_CONFIG || {});
      let SUPA_URL = cfg.url || 'https://qlhfyawbyedhqokivezn.supabase.co';
      const ANON_KEY = cfg.anonKey || '';
      if (!/^https?:\/\//i.test(SUPA_URL)) SUPA_URL = 'https://' + SUPA_URL;
      try {
        const r = await fetch(`${SUPA_URL}/functions/v1/public-gallery/images`, {
          method: 'GET',
          headers: {
            'apikey': ANON_KEY,
            'Authorization': 'Bearer ' + ANON_KEY,
          },
        });
        if (!r.ok) {
          console.warn('[public-gallery] 拉取失败,http=' + r.status);
          return;
        }
        const j = await r.json();
        if (!j.success || !j.data || !Array.isArray(j.data.images)) return;

        // 全部用数据库(后端已过滤 is_visible=true)
        const all = j.data.images.map(n => ({
          id: n.id,
          src: n.src,
          title: n.title || n.filename,
          category: n.category || 'portrait',
          date: '',
          location: '',
          isNew: !!n.is_new,
          views: 0, likes: 0,
          isLocal: !!n.is_local,                    // 标记: 老图(走主站静态)还是新图(走 supabase storage)
          storagePath: n.storage_path || null,
          sort_order: n.sort_order != null ? n.sort_order : 999,
        }));

        // 按 sort_order 升序(后端已经排过,这里再保一次)
        all.sort((a, b) => (a.sort_order || 999) - (b.sort_order || 999));

        // 替换 imageData
        imageData.length = 0;
        all.forEach(n => imageData.push(n));
        console.log('[public-gallery] 加载完成:', imageData.length, '张图');

        // 触发重渲染
        if (typeof window.rebuildGallery === 'function') {
          window.rebuildGallery();
        } else {
          document.querySelector('.filter-btn.active')?.click();
        }
      } catch (e) {
        const msg = String(e.message || e).toLowerCase();
        const isAbort = msg.includes('aborted') || msg.includes('abort') || msg.includes('cancel');
        if (!isAbort) {
          console.warn('[public-gallery] 拉取错误(file:// 模式下会失败):', e.message);
        }
      }
    })();

    // CDN URL 优化函数（为 Unsplash 图片添加 CDN 参数）
    function getOptimizedImageUrl(src, width = 800) {
      if (src.includes('unsplash.com')) {
        const separator = src.includes('?') ? '&' : '?';
        return `${src}${separator}w=${width}&q=80&auto=format&fit=crop`;
      }
      return src;
    }

    /* ============================
       Gallery Rendering
       ============================ */
    const galleryGrid = document.getElementById('galleryGrid');
    let currentFilter = 'all';
    let currentSort = 'default';
    let filteredImages = [...imageData];
    let sortedImages = [...imageData];
    let longpressTargetImg = null;
    let likeCountsData = {};
    let viewCountsData = {};
    // 全局缓存：每张图片的评论总数（key 为 imageId）
    // 暴露到 window 以便跨 IIFE 访问（评论系统 IIFE 需读写此缓存）
    window.commentCountsData = window.commentCountsData || {};
    // lightbox 当前显示的图片 ID
    window.currentLightboxImageId = window.currentLightboxImageId || null;

    function getCategoryLabel(cat) {
      const labels = { landscape: '风景', city: '城市', portrait: '人像', nature: '自然' };
      return labels[cat] || cat;
    }

    // === 修复: HTML/属性转义辅助函数 (防止 XSS) ===
    function escapeHtmlText(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    // 属性值额外需要转义 " 和 ' 和 \n(避免 attribute break)
    function escapeAttr(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ');
    }

    // 显示骨架屏
    function showSkeletonLoading() {
      const skeletonCount = 6;
      galleryGrid.innerHTML = '';
      for (let i = 0; i < skeletonCount; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-card';
        skeleton.innerHTML = `
          <div class="skeleton-img"><div class="skeleton-shimmer"></div></div>
          <div class="skeleton-info">
            <div class="skeleton-title"></div>
            <div class="skeleton-meta"></div>
          </div>
        `;
        galleryGrid.appendChild(skeleton);
      }
    }

    // 排序函数
    function sortImages(images, sortBy) {
      const sorted = [...images];
      switch (sortBy) {
        case 'likes':
          return sorted.sort((a, b) => {
            const likesA = likeCountsData[a.id] || a.likes || 0;
            const likesB = likeCountsData[b.id] || b.likes || 0;
            return likesB - likesA;
          });
        case 'views':
          return sorted.sort((a, b) => {
            const viewsA = viewCountsData[a.id] || a.views || 0;
            const viewsB = viewCountsData[b.id] || b.views || 0;
            return viewsB - viewsA;
          });
        default:
          // 优先按 sort_order,其次 id(兼容字符串 id)
          return sorted.sort((a, b) => {
            const ao = a.sort_order != null ? a.sort_order : 999;
            const bo = b.sort_order != null ? b.sort_order : 999;
            if (ao !== bo) return ao - bo;
            if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
            return String(a.id).localeCompare(String(b.id));
          });
      }
    }

    function renderGallery(filter) {
      currentFilter = filter;
      filteredImages = filter === 'all' ? [...imageData] : imageData.filter(img => img.category === filter);
      applySortingAndRender();
    }

    // 暴露给异步合并逻辑:新图加载完后调用
    window.rebuildGallery = function() {
      filteredImages = currentFilter === 'all' ? [...imageData] : imageData.filter(img => img.category === currentFilter);
      applySortingAndRender();
    };

    function applySortingAndRender() {
      sortedImages = sortImages(filteredImages, currentSort);
      galleryGrid.innerHTML = '';

      if (!sortedImages.length) {
        galleryGrid.innerHTML = `
          <div class="gallery-empty">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
            <div class="gallery-empty-title">暂无图片</div>
            <div class="gallery-empty-desc">该分类下暂时没有作品，换个分类看看吧。</div>
          </div>
        `;
        return;
      }

      sortedImages.forEach((img, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        card.dataset.index = index;
        card.dataset.id = img.id;

        // 获取点赞数和浏览数
        const likes = likeCountsData[img.id] || img.likes || 0;
        const views = viewCountsData[img.id] || img.views || 0;

        // 修复: 转义所有用户/后端可控字段(title/src/date/location),
        // 防止 public-gallery 任一字段被污染时 XSS 注入
        const safeTitle = escapeHtmlText(img.title);
        const safeAlt = escapeHtmlText(img.title || 'gallery image');
        const safeSrc = escapeAttr(img.src);
        const safeDate = escapeHtmlText(img.date);
        const safeLocation = escapeHtmlText(img.location);
        const safeCategory = escapeHtmlText(getCategoryLabel(img.category));

        card.innerHTML = `
          <div class="glow-border"></div>
          <div class="image-card-inner">
            <div class="image-card-actions">
              <button class="card-action-btn like-btn" title="点赞" aria-label="Like image" data-id="${img.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                <span class="like-count" data-id="${img.id}">${likes}</span>
              </button>
              <button class="card-action-btn save-btn" title="保存" aria-label="Save image">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
              </button>
              <button class="card-action-btn share-btn" title="分享" aria-label="Share image">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              </button>
            </div>
            <img class="image-card-img img-loading" src="${safeSrc}" alt="${safeAlt}" loading="lazy" data-src="${safeSrc}">
            <div class="image-card-badge">
              <span class="badge-category">${safeCategory}</span>
              ${img.isNew ? '<span class="badge-new">NEW</span>' : ''}
            </div>
            ${views > 0 ? `
            <div class="view-count-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span class="view-count-number">${views}</span>
            </div>
            ` : ''}
            <div class="image-card-info">
              <div class="image-card-title">${safeTitle}</div>
              <div class="image-card-meta">${(safeDate || safeLocation) ? (safeDate + (safeDate && safeLocation ? ' · ' : '') + safeLocation) : ''}</div>
            </div>
          </div>
        `;

        galleryGrid.appendChild(card);

        // === 3D Tilt Effect on hover ===
        const inner = card.querySelector('.image-card-inner');
        const glow = card.querySelector('.glow-border');

        card.addEventListener('mousemove', (e) => {
          const rect = card.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * 100;
          const y = ((e.clientY - rect.top) / rect.height) * 100;

          // Update glow position
          glow.style.setProperty('--mx', x + '%');
          glow.style.setProperty('--my', y + '%');

          // 3D tilt: -8deg to +8deg range
          const tiltX = ((y - 50) / 50) * -8;
          const tiltY = ((x - 50) / 50) * 8;
          inner.style.transform = `perspective(1200px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
        });

        card.addEventListener('mouseleave', () => {
          inner.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg)';
          glow.style.setProperty('--mx', '50%');
          glow.style.setProperty('--my', '50%');
        });

        // Click card → open lightbox
        // 使用 ID 在 window.sortedImages 中实时查找索引,避免筛选/排序后闭包 index 失效
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-action-btn')) return;
          const currentIndex = window.sortedImages.findIndex(i => String(i.id) === String(card.dataset.id));
          if (currentIndex >= 0) window.openLightbox(currentIndex);
        });

        const likeBtn = card.querySelector('.like-btn');
        const saveBtn = card.querySelector('.save-btn');
        const shareBtn = card.querySelector('.share-btn');
        if (likeBtn) likeBtn.addEventListener('click', (e) => { e.stopPropagation(); window.toggleLike(img.id); });
        if (saveBtn) saveBtn.addEventListener('click', (e) => { e.stopPropagation(); window.saveImage(img); });
        if (shareBtn) shareBtn.addEventListener('click', (e) => { e.stopPropagation(); window.shareImage(img); });

        const imgEl = card.querySelector('.image-card-img');
        imgEl.addEventListener('load', () => {
          imgEl.classList.remove('img-loading');
          imgEl.classList.add('fade-in');
        });
        imgEl.addEventListener('error', () => {
          imgEl.classList.remove('img-loading');
          // 图片加载失败时显示占位提示
          const errorWrap = document.createElement('div');
          errorWrap.className = 'image-load-error';
          errorWrap.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f5f5f5;color:#999;font-size:14px;';
          errorWrap.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:8px;opacity:0.5;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>图片加载失败</span>';
          imgEl.parentNode.replaceChild(errorWrap, imgEl);
        });

        // === Long Press on mobile ===
        let longPressTimer;
        card.addEventListener('touchstart', (e) => {
          if (e.target.closest('.card-action-btn')) return;
          longpressTargetImg = img;
          longPressTimer = setTimeout(() => {
            showLongpressMenu(e.touches[0].clientX, e.touches[0].clientY);
            navigator.vibrate && navigator.vibrate(15);
          }, 600);
        }, { passive: true });
        card.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
        card.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
      });

      observeCards();

      // 初始化点赞 UI（登录用户会高亮已点赞按钮）
      if (typeof window.initLikesUI === 'function') {
        window.initLikesUI();
      }
    }

    /* ============================
       IntersectionObserver — Awakening
       ============================ */
    let observer;
    function observeCards() {
      if (observer) observer.disconnect();
      observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            requestAnimationFrame(() => {
              entry.target.classList.add('awakened');
            });
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.05, rootMargin: '0px 0px -20px 0px' });
      document.querySelectorAll('.image-card').forEach(card => {
        observer.observe(card);
        // 已经在视口内的卡片立即唤醒,避免 threshold 导致卡片不可见
        const rect = card.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          card.classList.add('awakened');
        }
      });
    }

    /* ============================
       Filter Buttons
       ============================ */
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showSkeletonLoading();
        setTimeout(() => renderGallery(btn.dataset.filter), 150);
      });
    });

    /* ============================
       Sorting Buttons
       ============================ */
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSort = btn.dataset.sort;
        applySortingAndRender();
        observeCards();
      });
    });

    /* ============================
       Long Press Context Menu
       ============================ */
    const longpressMenu = document.getElementById('longpressMenu');

    function showLongpressMenu(x, y) {
      const menuW = 170; const menuH = 180;
      let left = x - menuW / 2;
      let top = y - menuH - 10;
      if (left < 10) left = 10;
      if (left + menuW > window.innerWidth - 10) left = window.innerWidth - menuW - 10;
      if (top < 10) top = y + 20;
      longpressMenu.style.left = left + 'px';
      longpressMenu.style.top = top + 'px';
      longpressMenu.classList.add('show');
    }

    function hideLongpressMenu() { longpressMenu.classList.remove('show'); }

    document.getElementById('lpSave').addEventListener('click', () => {
      if (longpressTargetImg) window.saveImage(longpressTargetImg);
      hideLongpressMenu();
    });
    document.getElementById('lpShare').addEventListener('click', () => {
      if (longpressTargetImg) window.shareImage(longpressTargetImg);
      hideLongpressMenu();
    });
    document.getElementById('lpView').addEventListener('click', () => {
      if (longpressTargetImg) {
        const idx = sortedImages.findIndex(i => i.id === longpressTargetImg.id);
        if (idx >= 0) window.openLightbox(idx);
      }
      hideLongpressMenu();
    });

    document.addEventListener('click', (e) => {
      if (!longpressMenu.contains(e.target)) hideLongpressMenu();
    });
    document.addEventListener('scroll', hideLongpressMenu);


  // 暴露全局变量和函数
  // 使用 getter 暴露数组/对象变量,确保 gallery.js 内部重新赋值后全局引用始终最新
  Object.defineProperty(global, 'imageData', { get: () => imageData });
  global.galleryGrid = galleryGrid;
  Object.defineProperty(global, 'currentFilter', { get: () => currentFilter });
  Object.defineProperty(global, 'currentSort', { get: () => currentSort });
  Object.defineProperty(global, 'filteredImages', { get: () => filteredImages });
  Object.defineProperty(global, 'sortedImages', { get: () => sortedImages });
  Object.defineProperty(global, 'longpressTargetImg', { get: () => longpressTargetImg });
  Object.defineProperty(global, 'likeCountsData', { get: () => likeCountsData, set: (v) => { likeCountsData = v; } });
  Object.defineProperty(global, 'viewCountsData', { get: () => viewCountsData, set: (v) => { viewCountsData = v; } });
  global.getOptimizedImageUrl = getOptimizedImageUrl;
  global.getCategoryLabel = getCategoryLabel;
  global.escapeHtmlText = escapeHtmlText;
  global.escapeAttr = escapeAttr;
  global.showSkeletonLoading = showSkeletonLoading;
  global.sortImages = sortImages;
  global.renderGallery = renderGallery;
  global.applySortingAndRender = applySortingAndRender;
  global.observeCards = observeCards;
  global.showLongpressMenu = showLongpressMenu;
  global.hideLongpressMenu = hideLongpressMenu;
  global.Gallery = {
    imageData: imageData,
    render: renderGallery,
    rebuild: global.rebuildGallery,
    getCurrentImages: () => sortedImages,
  };
})(window);

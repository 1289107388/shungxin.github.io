(function(global) {
  'use strict';

    /* ============================
       Lightbox with Zoom & Drag
       ============================ */
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightboxImg');
    const lightboxContainer = document.getElementById('lightboxContainer');
    const lightboxZoomHint = document.getElementById('lightboxZoomHint');
    let currentLightboxIndex = -1;
    let scale = 1, panX = 0, panY = 0;
    let isDragging = false, dragStartX = 0, dragStartY = 0;
    let panStartX = 0, panStartY = 0;
    let imageNaturalW = 0, imageNaturalH = 0;

    // Reset zoom state
    function resetZoom() {
      scale = 1; panX = 0; panY = 0;
      lightboxImg.style.transform = 'scale(1)';
      lightboxContainer.classList.remove('zoomed');
      lightboxZoomHint.classList.remove('show');
    }

    function applyTransform() {
      lightboxImg.style.transform = `scale(${scale}) translate(${panX / scale}px, ${panY / scale}px)`;
    }

    function clampPan() {
      if (scale <= 1) { panX = 0; panY = 0; return; }
      // 根据图片实际尺寸和容器尺寸动态计算可平移范围
      const containerW = lightboxContainer.clientWidth;
      const containerH = lightboxContainer.clientHeight;
      if (imageNaturalW > 0 && imageNaturalH > 0 && containerW > 0 && containerH > 0) {
        // 图片适应容器后的显示尺寸
        const fitScale = Math.min(containerW / imageNaturalW, containerH / imageNaturalH);
        const displayW = imageNaturalW * fitScale;
        const displayH = imageNaturalH * fitScale;
        // 放大后的尺寸 - 容器尺寸 = 可平移的总范围, 两边各一半
        const maxPanX = Math.max(0, (displayW * scale - containerW) / 2);
        const maxPanY = Math.max(0, (displayH * scale - containerH) / 2);
        panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
        panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
      } else {
        // fallback: 图片还没加载完时用旧的估算方式
        const maxPan = (scale - 1) * 100;
        panX = Math.max(-maxPan, Math.min(maxPan, panX));
        panY = Math.max(-maxPan, Math.min(maxPan, panY));
      }
    }

    // 图片加载完成后记录自然尺寸
    lightboxImg.addEventListener('load', () => {
      imageNaturalW = lightboxImg.naturalWidth;
      imageNaturalH = lightboxImg.naturalHeight;
      // 重新 clamp 一下,确保当前 pan 在合法范围内
      clampPan();
      applyTransform();
    });

    function openLightbox(index) {
      currentLightboxIndex = index;
      const img = window.sortedImages[index];
      window.currentLightboxImageId = img.id;
      lightboxImg.src = img.src;
      lightbox.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
      resetZoom();
      if (index + 1 < window.sortedImages.length) new Image().src = window.sortedImages[index + 1].src;
      if (index - 1 >= 0) new Image().src = window.sortedImages[index - 1].src;

      // 记录浏览量
      if (typeof incrementViewCount === 'function') {
        incrementViewCount(img.id);
      }

      // 刷新 lightbox 工具栏的评论数（使用缓存或拉取）
      if (typeof refreshLightboxCommentCount === 'function') {
        refreshLightboxCommentCount(img.id);
      }

      // Show zoom hint after a moment
      setTimeout(() => { lightboxZoomHint.classList.add('show'); }, 500);
      setTimeout(() => { lightboxZoomHint.classList.remove('show'); }, 4000);

      // P1 阶段 C-1: 广播 lightbox 打开(让其他模块暂停轮询、显示统计等)
      try { window.EventBus && window.EventBus.emit('lightbox:open', { imageId: img.id, index: index }); } catch (_) {}
    }

    function closeLightbox() {
      lightbox.classList.add('hidden');
      document.body.style.overflow = '';
      currentLightboxIndex = -1;
      window.currentLightboxImageId = null;
      resetZoom();
      // P1 阶段 C-1: 广播 lightbox 关闭
      try { window.EventBus && window.EventBus.emit('lightbox:close', {}); } catch (_) {}
    }

    function navigateLightbox(dir) {
      if (currentLightboxIndex < 0) return;
      let newIndex = currentLightboxIndex + dir;
      if (newIndex < 0) newIndex = window.sortedImages.length - 1;
      if (newIndex >= window.sortedImages.length) newIndex = 0;
      resetZoom();
      lightboxImg.style.opacity = '0';
      setTimeout(() => {
        currentLightboxIndex = newIndex;
        const img = window.sortedImages[newIndex];
        window.currentLightboxImageId = img.id;
        lightboxImg.src = img.src;
        lightboxImg.style.opacity = '1';
        if (newIndex + 1 < window.sortedImages.length) new Image().src = window.sortedImages[newIndex + 1].src;
        if (newIndex - 1 >= 0) new Image().src = window.sortedImages[newIndex - 1].src;

        // 切换图片后刷新 lightbox 工具栏的评论数
        if (typeof refreshLightboxCommentCount === 'function') {
          refreshLightboxCommentCount(img.id);
        }

        setTimeout(() => { lightboxZoomHint.classList.add('show'); }, 500);
        setTimeout(() => { lightboxZoomHint.classList.remove('show'); }, 3500);
      }, 150);
    }

    // Close / Nav
    document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
    document.getElementById('lightboxPrev').addEventListener('click', () => navigateLightbox(-1));
    document.getElementById('lightboxNext').addEventListener('click', () => navigateLightbox(1));

    document.addEventListener('keydown', (e) => {
      if (currentLightboxIndex < 0) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navigateLightbox(-1);
      if (e.key === 'ArrowRight') navigateLightbox(1);
    });

    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });

    // Zoom button
    document.getElementById('lightboxZoomIn').addEventListener('click', () => {
      if (scale >= 1) {
        scale = Math.min(scale * 1.5, 4);
        lightboxContainer.classList.add('zoomed');
        lightboxZoomHint.classList.remove('show');
      } else {
        scale = 1; panX = 0; panY = 0;
        lightboxContainer.classList.remove('zoomed');
      }
      applyTransform();
    });

    // Mouse wheel zoom
    lightbox.addEventListener('wheel', (e) => {
      if (currentLightboxIndex < 0) return;
      e.preventDefault();
      lightboxZoomHint.classList.remove('show');
      const oldScale = scale;
      scale += e.deltaY * -0.01;
      scale = Math.max(0.5, Math.min(4, scale));

      // Adjust pan to zoom towards cursor
      if (scale > 1 || oldScale > 1) {
        const rect = lightboxContainer.getBoundingClientRect();
        const cx = e.clientX - rect.left - rect.width / 2;
        const cy = e.clientY - rect.top - rect.height / 2;
        panX += cx * (scale / oldScale - 1);
        panY += cy * (scale / oldScale - 1);
      }

      if (scale <= 1) { panX = 0; panY = 0; lightboxContainer.classList.remove('zoomed'); }
      else { lightboxContainer.classList.add('zoomed'); }
      clampPan();
      applyTransform();
    }, { passive: false });

    // Double-click to reset zoom
    lightboxImg.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (scale > 1.1) { resetZoom(); applyTransform(); }
      else { scale = 2; lightboxContainer.classList.add('zoomed'); lightboxZoomHint.classList.remove('show'); applyTransform(); }
    });

    // Drag to pan
    lightboxContainer.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      lightboxContainer.classList.add('dragging');
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panStartX = panX;
      panStartY = panY;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panX = panStartX + (e.clientX - dragStartX);
      panY = panStartY + (e.clientY - dragStartY);
      clampPan();
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        lightboxContainer.classList.remove('dragging');
      }
    });

    // Touch drag for panning
    let touchDist0 = 0;
    let touchScaleStart = 1, touchPanStartX = 0, touchPanStartY = 0;
    let touchMidX = 0, touchMidY = 0;
    let singleTouch = false;

    lightboxContainer.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        singleTouch = true;
        isDragging = true;
        lightboxContainer.classList.add('dragging');
        dragStartX = e.touches[0].clientX;
        dragStartY = e.touches[0].clientY;
        panStartX = panX;
        panStartY = panY;
      } else if (e.touches.length === 2) {
        singleTouch = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchDist0 = Math.sqrt(dx * dx + dy * dy);
        touchScaleStart = scale;
        touchPanStartX = panX;
        touchPanStartY = panY;
        touchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        touchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        const rect = lightboxContainer.getBoundingClientRect();
        touchMidX = touchMidX - rect.left - rect.width / 2;
        touchMidY = touchMidY - rect.top - rect.height / 2;
      }
    }, { passive: false });

    lightboxContainer.addEventListener('touchmove', (e) => {
      e.preventDefault();
      lightboxZoomHint.classList.remove('show');
      if (e.touches.length === 1 && singleTouch) {
        panX = panStartX + (e.touches[0].clientX - dragStartX);
        panY = panStartY + (e.touches[0].clientY - dragStartY);
        clampPan();
        applyTransform();
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (touchDist0 > 0) {
          scale = touchScaleStart * (dist / touchDist0);
          scale = Math.max(1, Math.min(4, scale));
          panX = touchPanStartX + touchMidX * (scale / touchScaleStart - 1);
          panY = touchPanStartY + touchMidY * (scale / touchScaleStart - 1);
          clampPan();
          applyTransform();
          if (scale > 1) lightboxContainer.classList.add('zoomed');
          else { lightboxContainer.classList.remove('zoomed'); panX = 0; panY = 0; }
        }
      }
    }, { passive: false });

    lightboxContainer.addEventListener('touchend', () => {
      if (isDragging) {
        isDragging = false;
        lightboxContainer.classList.remove('dragging');
      }
      if (scale <= 1) { panX = 0; panY = 0; lightboxContainer.classList.remove('zoomed'); applyTransform(); }
    });

    // Swipe left/right for navigation (when not zoomed)
    let touchStartLX = 0;
    lightbox.addEventListener('touchstart', (e) => {
      if (scale <= 1) touchStartLX = e.touches[0].clientX;
    }, { passive: true });

    lightbox.addEventListener('touchend', (e) => {
      if (scale > 1.1) return;
      const diff = touchStartLX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 60) navigateLightbox(diff > 0 ? 1 : -1);
    }, { passive: true });

    // Save/Share in lightbox
    document.getElementById('lightboxSave').addEventListener('click', () => {
      if (currentLightboxIndex >= 0) saveImage(window.sortedImages[currentLightboxIndex]);
    });
    document.getElementById('lightboxShare').addEventListener('click', () => {
      if (currentLightboxIndex >= 0) shareImage(window.sortedImages[currentLightboxIndex]);
    });

    /* ============================
       Save & Share
       ============================ */
    function saveImage(img) {
      const link = document.createElement('a');
      link.href = img.src;
      // 从图片 URL 中提取正确的扩展名, 避免写死 .jpg
      let ext = 'jpg';
      try {
        const urlPath = new URL(img.src, window.location.origin).pathname;
        const match = urlPath.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        if (match && match[1]) {
          ext = match[1].toLowerCase();
        }
      } catch (e) { /* URL 解析失败时用默认 jpg */ }
      link.download = `${img.title}.${ext}`;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('图片已保存');
    }

    function shareImage(img) {
      if (navigator.share) {
        navigator.share({ title: img.title, text: `${img.title} — 双薪写真画廊`, url: img.src })
          .catch(() => { fallbackCopy(img.src); });
      } else { fallbackCopy(img.src); }
    }

    function fallbackCopy(url) {
      navigator.clipboard.writeText(url).then(() => { showToast('链接已复制到剪贴板'); })
        .catch(() => { showToast('请手动复制链接'); });
    }


  global.openLightbox = openLightbox;
  global.closeLightbox = closeLightbox;
  global.navigateLightbox = navigateLightbox;
  global.saveImage = saveImage;
  global.shareImage = shareImage;
  global.fallbackCopy = fallbackCopy;
  global.Lightbox = {
    open: openLightbox,
    close: closeLightbox,
    navigate: navigateLightbox,
    save: saveImage,
    share: shareImage,
  };
})(window);

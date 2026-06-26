(function(global) {
  'use strict';

    /* ============================
       Toast
       ============================ */
    function showToast(message) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = `<span class="toast-icon">✓</span> ${message}`;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 300ms ease';
        setTimeout(() => toast.remove(), 300);
      }, 2500);
    }

    /* ============================
       Navigation Links
       ============================ */
    document.querySelectorAll('[data-section]').forEach(link => {
      link.addEventListener('click', (e) => {
        const sectionId = link.dataset.section;

        // === 修复: 'comments' 不是页面 section,而是抽屉 ===
        // DOM 里没有 id="comments",通用 getElementById 永远 null
        // 桌面端 #navCommentsBtn 有专用 handler(3178 行)没事;
        // 移动端 #mobileNavComments 这里特判处理
        if (sectionId === 'comments') {
          e.preventDefault();
          e.stopPropagation();
          document.getElementById('mobileNav')?.classList.remove('open');
          // 关闭通用 active 高亮
          document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
          if (typeof window.showCommentsFor === 'function') {
            window.showCommentsFor('site', '整站讨论', 'GitHub Discussions · 真实模式');
          } else if (typeof showCommentsFor === 'function') {
            showCommentsFor('site', '整站讨论', 'GitHub Discussions · 真实模式');
          } else {
            document.getElementById('navCommentsBtn')?.click();
          }
          return;
        }

        const section = document.getElementById(sectionId);
        if (section) section.scrollIntoView({ behavior: 'smooth' });
        document.getElementById('mobileNav').classList.remove('open');
        // 修复: 只重置 nav-links 内 <a> 的 active,不影响 #navCommentsBtn
        document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
        // 只对 nav-links 内的 <a> 重新设置 active
        if (link.tagName === 'A' && link.closest('.nav-links')) {
          link.classList.add('active');
        }
      });
    });

    /* ============================
       Mobile Nav
       ============================ */
    document.getElementById('navHamburger').addEventListener('click', () => { document.getElementById('mobileNav').classList.add('open'); });
    document.getElementById('mobileNavClose').addEventListener('click', () => { document.getElementById('mobileNav').classList.remove('open'); });
    document.querySelectorAll('#mobileNav a').forEach(link => {
      link.addEventListener('click', () => {
        const sectionId = link.dataset.section;
        // 特判: comments 是抽屉不是 section
        if (sectionId === 'comments') {
          document.getElementById('mobileNav')?.classList.remove('open');
          if (typeof window.showCommentsFor === 'function') {
            window.showCommentsFor('site', '整站讨论', 'GitHub Discussions · 真实模式');
          } else {
            document.getElementById('navCommentsBtn')?.click();
          }
          return;
        }
        const section = document.getElementById(sectionId);
        if (section) section.scrollIntoView({ behavior: 'smooth' });
        document.getElementById('mobileNav').classList.remove('open');
      });
    });

    /* ============================
       Scroll Progress
       ============================ */
    window.addEventListener('scroll', () => {
      const pct = (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight)) * 100;
      document.getElementById('scrollProgress').style.width = pct + '%';
    });

    /* ============================
       Init
       ============================ */
    // 首次加载显示骨架屏
    showSkeletonLoading();
    setTimeout(() => renderGallery('all'), 300);

  global.showToast = showToast;
  global.Nav = {
    showToast: showToast,
  };
})(window);

(function(global) {
  'use strict';

    /* ============================
       Enhanced Particle System
       ============================ */
    const pCanvas = document.getElementById('particle-canvas');
    const pCtx = pCanvas.getContext('2d');
    let particles = [];
    let mouseX = -1000, mouseY = -1000;
    let particleCount = 80;
    let pConnectionDist = 150;

    function resizeCanvas() {
      pCanvas.width = window.innerWidth;
      pCanvas.height = window.innerHeight;
      pCanvas.style.width = window.innerWidth + 'px';
      pCanvas.style.height = window.innerHeight + 'px';
      adjustParticleCount();
    }

    function adjustParticleCount() {
      const w = window.innerWidth;
      if (w <= 639) { particleCount = 65; pConnectionDist = 120; }
      else if (w <= 1023) { particleCount = 100; pConnectionDist = 150; }
      else { particleCount = 130; pConnectionDist = 150; }
    }

    function initParticles() {
      const w = pCanvas.width;
      const h = pCanvas.height;
      particles = [];
      for (let i = 0; i < particleCount; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6,
          radius: 2 + Math.random() * 3.5,
          baseOpacity: 0.5 + Math.random() * 0.4,
          pulse: Math.random() * Math.PI * 2,
          pulseSpeed: 0.008 + Math.random() * 0.02,
        });
      }
    }

    function drawParticles() {
      pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);

      const mx = mouseX;
      const my = mouseY;
      const w = pCanvas.width;
      const h = pCanvas.height;

      const INFLUENCE_RADIUS = 200;
      const INFLUENCE_STRENGTH = 0.04;

      // Update & draw
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Mouse attraction — only when mouse is on screen
        const dx = mx - p.x;
        const dy = my - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < INFLUENCE_RADIUS) {
          const force = (1 - dist / INFLUENCE_RADIUS) * INFLUENCE_STRENGTH;
          p.x += dx * force;
          p.y += dy * force;
        }

        // Slow drift
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around edges
        if (p.x < -30) p.x = w + 30;
        if (p.x > w + 30) p.x = -30;
        if (p.y < -30) p.y = h + 30;
        if (p.y > h + 30) p.y = -30;

        // Pulsing opacity
        p.pulse += p.pulseSpeed;
        const pulseOpacity = p.baseOpacity + Math.sin(p.pulse) * 0.1;

        // Draw glow circle
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.radius * 2.5, 0, Math.PI * 2);
        const glowGrad = pCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 3);
        glowGrad.addColorStop(0, `rgba(255, 255, 255, ${pulseOpacity})`);
        glowGrad.addColorStop(0.3, `rgba(255, 255, 255, ${pulseOpacity * 0.5})`);
        glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        pCtx.fillStyle = glowGrad;
        pCtx.fill();

        // Draw bright core
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.radius * 0.6, 0, Math.PI * 2);
        pCtx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, pulseOpacity * 1.5)})`;
        pCtx.fill();
      }

      // Draw connections between nearby particles
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < pConnectionDist) {
            const alpha = (1 - dist / pConnectionDist) * 0.22;
            pCtx.beginPath();
            pCtx.moveTo(particles[i].x, particles[i].y);
            pCtx.lineTo(particles[j].x, particles[j].y);
            pCtx.strokeStyle = `rgba(212, 168, 83, ${alpha})`;
            pCtx.lineWidth = 1;
            pCtx.stroke();
          }
        }
      }

      requestAnimationFrame(drawParticles);
    }

    resizeCanvas();
    initParticles();
    drawParticles();

    // 防抖: 窗口大小变化时避免频繁重绘
    const handleResize = window.Utils && window.Utils.debounce
      ? window.Utils.debounce(() => { resizeCanvas(); initParticles(); }, 150)
      : (() => {
          let timer = null;
          return () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { resizeCanvas(); initParticles(); }, 150);
          };
        })();
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });

    // Touch support for particles
    window.addEventListener('touchmove', (e) => {
      mouseX = e.touches[0].clientX;
      mouseY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchstart', (e) => {
      mouseX = e.touches[0].clientX;
      mouseY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchend', () => { mouseX = -1000; mouseY = -1000; });


  global.Particles = {
    init: initParticles,
    resize: resizeCanvas,
  };
})(window);

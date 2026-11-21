/* =========================================================================
   warp.js — 跃迁：星轨拉线 → 爆闪 → 抵达另一颗星球

   与上一版的区别：
   · 不只是换个天空贴图，而是真的切换到一个不同的星球世界
   · 过渡前半段是「星轨拉长成线」，而不是只有一次爆闪
   · 抵达后星球本体、星环、光照方向、环境色全部不同

   时间线（总计约 3.4 秒）：
     0.00 ~ 1.30  星轨加速：星星拉成线，视野收缩
     1.30 ~ 1.70  爆闪白屏（此时切换世界）
     1.70 ~ 1.90  白屏保持
     1.90 ~ 3.40  展开：白屏褪去，星轨收回，新星球出现
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const T = {
    charge: 1.30,
    flash: 0.40,
    hold: 0.20,
    open: 1.50,
  };
  const TOTAL = T.charge + T.flash + T.hold + T.open;

  function create(opts) {
    const { camera, scene, starlines, audio, onSwap } = opts;

    const flashEl = document.getElementById('warpFlash');
    const streakEl = document.getElementById('warpStreak');
    const titleEl = document.getElementById('warpTitle');

    const state = {
      active: false,
      t: 0,
      phase: 'idle',
      progress: 0,
      target: null,
      swapped: false,
    };

    let savedFov = camera.fov;
    let onComplete = null;

    function setOverlay(flash, streak) {
      if (flashEl) flashEl.style.opacity = String(SAT.clamp(flash, 0, 1));
      if (streakEl) streakEl.style.opacity = String(SAT.clamp(streak, 0, 1));
    }

    function showTitle(text, opacity) {
      if (!titleEl) return;
      if (text !== undefined) titleEl.textContent = text;
      titleEl.style.opacity = String(SAT.clamp(opacity, 0, 1));
    }

    /** 开始跃迁到指定世界 */
    function start(targetName, done) {
      if (state.active) return false;
      state.active = true;
      state.t = 0;
      state.phase = 'charge';
      state.target = targetName || 'unknown';
      state.progress = 0;
      state.swapped = false;
      savedFov = camera.fov;
      onComplete = done || null;
      showTitle('', 0);
      if (audio && audio.warp) audio.warp();
      return true;
    }

    function update(dt, time) {
      if (!state.active) return state;

      state.t += dt;
      const t = state.t;

      const forward = (function () {
        const v = new THREE.Vector3();
        camera.getWorldDirection(v);
        return v;
      })();

      /* ---------- 阶段 1：星轨加速 ---------- */
      if (t < T.charge) {
        state.phase = 'charge';
        const p = t / T.charge;
        const ease = p * p; // 慢起步，后段加速

        starlines.setIntensity(SAT.lerp(0.08, 1.0, ease));
        camera.fov = SAT.lerp(savedFov, savedFov * 0.62, ease);
        camera.updateProjectionMatrix();

        // 放射条纹在最后 40% 出现
        setOverlay(0, SAT.smoothstep(0.62, 1.0, p) * 0.85);
        showTitle(state.phase === 'charge' && p < 0.55 ? '' : '', 0);
      }
      /* ---------- 阶段 2：爆闪 ---------- */
      else if (t < T.charge + T.flash) {
        state.phase = 'flash';
        const p = (t - T.charge) / T.flash;

        setOverlay(SAT.smoothstep(0.0, 0.55, p), 1.0);
        starlines.setIntensity(1.0);

        // 白屏最亮的瞬间切换世界（玩家看不到接缝）
        if (!state.swapped && p > 0.45) {
          state.swapped = true;
          if (onSwap) onSwap(state.target);
        }
      }
      /* ---------- 阶段 3：白屏保持 ---------- */
      else if (t < T.charge + T.flash + T.hold) {
        state.phase = 'hold';
        setOverlay(1.0, 1.0);
        starlines.setIntensity(0.9);
      }
      /* ---------- 阶段 4：展开 ---------- */
      else if (t < TOTAL) {
        state.phase = 'open';
        const p = (t - T.charge - T.flash - T.hold) / T.open;
        const ease = SAT.smoothstep(0, 1, p);

        setOverlay(1 - ease, 1 - ease);
        starlines.setIntensity(SAT.lerp(0.95, 0.0, ease));
        camera.fov = SAT.lerp(savedFov * 0.62, savedFov, ease);
        camera.updateProjectionMatrix();

        // 抵达名字：前半段淡入，后段淡出
        const nameVis = p < 0.45 ? SAT.smoothstep(0.0, 0.25, p) : 1 - SAT.smoothstep(0.55, 0.95, p);
        showTitle(state.targetLabel || '', nameVis * 0.95);
      }
      /* ---------- 结束 ---------- */
      else {
        finish();
        return state;
      }

      state.progress = SAT.clamp(t / TOTAL, 0, 1);
      starlines.update(dt, time, camera, forward);
      return state;
    }

    function finish() {
      state.active = false;
      state.phase = 'idle';
      state.t = 0;
      state.progress = 1;
      camera.fov = savedFov;
      camera.updateProjectionMatrix();
      setOverlay(0, 0);
      showTitle('', 0);
      starlines.reset();
      if (onComplete) {
        const cb = onComplete;
        onComplete = null;
        cb(state.target);
      }
    }

    function cancel() {
      if (!state.active) return;
      state.active = false;
      state.phase = 'idle';
      camera.fov = savedFov;
      camera.updateProjectionMatrix();
      setOverlay(0, 0);
      showTitle('', 0);
      starlines.reset();
      onComplete = null;
    }

    return {
      start,
      update,
      cancel,
      setTargetLabel(label) {
        state.targetLabel = label;
      },
      get active() {
        return state.active;
      },
      get phase() {
        return state.phase;
      },
      get progress() {
        return state.progress;
      },
      state,
    };
  }

  SAT.warp = { create, TOTAL };
})();

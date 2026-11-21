/* =========================================================================
   gameplay.js — 玩法层：小行星碰撞
   （信标采集已移除：实测无趣味，且干扰观感）
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  /**
   * 用 CPU 复算远处小行星的位置。
   * 与顶点着色器里的公式完全一致：
   *   ang   = aAngle0 + uTime * aSpeed
   *   pos   = (cos(ang) * aOrbit, aY, sin(ang) * aOrbit)
   * 这样无需回读 GPU，就能做最近邻检测。
   */
  function nearestBeltHit(belts, time, camPos, camRadius) {
    let best = null;

    for (const b of belts) {
      const geo = b.mesh.geometry;
      const orbit = geo.getAttribute('aOrbit');
      const angle0 = geo.getAttribute('aAngle0');
      const speed = geo.getAttribute('aSpeed');
      const ys = geo.getAttribute('aY');
      const scales = geo.getAttribute('aScale');
      if (!orbit || !angle0 || !speed || !ys) continue;

      const n = b.count;
      const camOrbit = Math.hypot(camPos.x, camPos.z);

      for (let i = 0; i < n; i++) {
        const ro = orbit.array[i];
        if (Math.abs(ro - camOrbit) > camRadius * 6) continue;

        const dy = ys.array[i] - camPos.y;
        if (Math.abs(dy) > camRadius * 6) continue;

        const ang = angle0.array[i] + time * speed.array[i];
        const x = Math.cos(ang) * ro - camPos.x;
        const z = Math.sin(ang) * ro - camPos.z;

        const d2 = x * x + dy * dy + z * z;
        const s = Math.max(
          scales.array[i * 3],
          scales.array[i * 3 + 1],
          scales.array[i * 3 + 2]
        );
        const rr = camRadius + s * 0.82;
        if (d2 < rr * rr) {
          if (!best || d2 < best.d2) best = { d2, i, radius: s, belt: b };
        }
      }
    }
    return best;
  }

  /** 近景岩石的球体碰撞（它们是独立 mesh，直接取 position） */
  function nearestHeroHit(heroes, camPos, camRadius) {
    let best = null;
    for (const h of heroes) {
      const s = Math.max(h.scale.x, h.scale.y, h.scale.z);
      const rr = camRadius + s * 0.80;
      const d2 = h.position.distanceToSquared(camPos);
      if (d2 < rr * rr) {
        if (!best || d2 < best.d2) best = { d2, mesh: h, radius: s };
      }
    }
    return best;
  }

  function create(opts) {
    const { saturn, R } = opts;
    const camRadius = R * 0.004;

    const state = {
      lastHitTime: -999,
    };

    function update(dt, time, camera, speed, onEvent) {
      const heroHit = nearestHeroHit(saturn.heroes, camera.position, camRadius);
      let hit = heroHit ? { strength: heroHit.radius / 40 } : null;

      if (!hit) {
        const beltHit = nearestBeltHit(saturn.belts, time, camera.position, camRadius);
        if (beltHit) hit = { strength: beltHit.radius / 18 };
      }

      if (hit) {
        const since = time - state.lastHitTime;
        if (since > 0.7) {
          state.lastHitTime = time;
          if (onEvent) onEvent('impact', { strength: SAT.clamp(hit.strength || 1, 0.3, 1.5) });
        }
        return { hit: true, strength: hit.strength, speed };
      }

      return { hit: false, speed };
    }

    return {
      state,
      update,
      group: null,
      /** 兼容旧调用：不再需要挂载信标 */
      attach() {
        return null;
      },
    };
  }

  SAT.gameplay = { create, nearestBeltHit, nearestHeroHit };
})();

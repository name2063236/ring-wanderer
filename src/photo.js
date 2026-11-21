/* =========================================================================
   photo.js — 拍照模式 + 自动航行日志
   · 拍照：冻结时间、隐藏 HUD、自由取景，导出 PNG 并带遥测水印
   · 日志：不弹成就窗，安静地记录"你做过什么"，可导出为文本
   ========================================================================= */
(function () {
  const SAT = window.SAT;

  /* =====================================================================
     航行日志
     不做成就系统，只记录那些"玩家自己会记得"的时刻。
     ===================================================================== */
  function createLog() {
    const entries = [];
    const seen = Object.create(null);

    // 记录顺序即发生顺序
    function add(id, text, detail) {
      if (seen[id]) return false;
      seen[id] = true;
      entries.push({
        id,
        text,
        detail: detail || '',
        at: new Date(),
      });
      return true;
    }

    function format() {
      const lines = [];
      lines.push('环带漫游者 · 航行日志');
      lines.push('─'.repeat(46));
      lines.push(`共 ${entries.length} 条记录`);
      lines.push('');
      entries.forEach((e, i) => {
        const t = e.at.toTimeString().slice(0, 8);
        lines.push(`${String(i + 1).padStart(2, '0')}. ${e.text}`);
        if (e.detail) lines.push(`    ${e.detail}`);
        lines.push(`    ${t}`);
        lines.push('');
      });
      if (!entries.length) lines.push('（还是一段空白）');
      return lines.join('\n');
    }

    return {
      add,
      format,
      entries,
      get count() {
        return entries.length;
      },
      has: (id) => !!seen[id],
    };
  }

  /* =====================================================================
     拍照模式
     ===================================================================== */
  function createPhoto(opts) {
    const { renderer, scene, camera, bloom, ringfog, uiRoots, info } = opts;

    let active = false;
    let frozen = false;
    let savedFov = camera.fov;

    /* 隐藏 HUD */
    function setUI(visible) {
      (uiRoots || []).forEach((el) => {
        if (!el) return;
        el.style.visibility = visible ? '' : 'hidden';
      });
    }

    /* 导出当前画面：renderer 会把 canvas 绘制到一张 2D canvas 上，
       再叠一层遥测水印，最后下载。 */
    function capture(filename) {
      // 需要保证这一帧已经渲染完成，所以先同步渲染一次
      try {
        bloom.render(scene, camera, 0, 1);
      } catch (e) {
        /* 忽略：某些情况下 bloom 失败，仍尝试导出 */
      }

      const src = renderer.domElement;
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(src, 0, 0);

      // ---- 水印 ----
      const scale = out.width / 1920;
      const pad = Math.round(38 * scale);
      const f1 = Math.max(10, Math.round(15 * scale));
      const f2 = Math.max(9, Math.round(11.5 * scale));

      ctx.save();
      ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,.75)';
      ctx.shadowBlur = Math.round(8 * scale);

      // 左下：坐标 / 距离
      const meta = info ? info() : {};
      ctx.fillStyle = 'rgba(232,241,255,.92)';
      ctx.font = `500 ${f1}px ui-monospace, Consolas, monospace`;
      ctx.fillText('环带漫游者  ·  RING WANDERER', pad, out.height - pad - f1 * 2.6);

      ctx.fillStyle = 'rgba(190,212,240,.78)';
      ctx.font = `400 ${f2}px ui-monospace, Consolas, monospace`;
      const l2 = [];
      if (meta.dist) l2.push('距土星 ' + meta.dist);
      if (meta.speed) l2.push(meta.speed);
      if (meta.beacon) l2.push(meta.beacon);
      ctx.fillText(l2.join('   ·   '), pad, out.height - pad - f2 * 0.9);

      // 右下：时间戳
      ctx.textAlign = 'right';
      const d = new Date();
      const ts =
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      ctx.fillText(ts, out.width - pad, out.height - pad - f2 * 0.9);

      ctx.restore();

      // ---- 下载 ----
      const name = filename || `ring-wanderer-${Date.now()}.png`;
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          a.remove();
        }, 1500);
      }, 'image/png');

      return name;
    }

    function enter() {
      if (active) return;
      active = true;
      frozen = true;
      savedFov = camera.fov;
      setUI(false);
      document.body.classList.add('photo-mode');
      return true;
    }

    function exit() {
      if (!active) return;
      active = false;
      frozen = false;
      camera.fov = savedFov;
      camera.updateProjectionMatrix();
      setUI(true);
      document.body.classList.remove('photo-mode');
      return true;
    }

    function toggle() {
      return active ? (exit(), false) : (enter(), true);
    }

    return {
      enter,
      exit,
      toggle,
      capture,
      get active() {
        return active;
      },
      get frozen() {
        return frozen;
      },
    };
  }

  SAT.photo = { createLog, createPhoto };
})();

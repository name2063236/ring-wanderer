/* =========================================================================
   starlines.js — 跃迁星轨
   跃迁时，原本的点状恒星被拉长成沿视线方向的线。
   这是科幻里最经典的"超空间"视觉语言，也比单纯爆闪有实感得多。

   实现：不用点精灵（点精灵无法拉长），改用线段（LineSegments）。
   每个"拉丝"是一条沿相机前进方向的短线段，长度由跃迁强度驱动。
   位置分布在一个跟随相机的球壳里，所以永远包住玩家。
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  function create(opts) {
    const count = opts && opts.count ? opts.count : 1400;
    const rng = SAT.rng(91237);

    // 每条线 = 2 个顶点（起点 + 终点）
    const positions = new Float32Array(count * 2 * 3);
    // 每条线的基准位置（单位球面上的方向 + 半径）
    const dirs = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const seeds = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // 均匀球面分布
      const u = rng.f() * 2 - 1;
      const th = rng.f() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      dirs[i * 3] = s * Math.cos(th);
      dirs[i * 3 + 1] = u;
      dirs[i * 3 + 2] = s * Math.sin(th);
      radii[i] = rng.range(180, 1400);
      seeds[i] = rng.f();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uDir: { value: new THREE.Vector3(0, 0, -1) },
        uIntensity: { value: 0 }, // 0~1，跃迁强度
        uTime: { value: 0 },
        uGeometry: { value: geo },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform vec3 uCam;
        uniform vec3 uDir;
        uniform float uIntensity;
        uniform float uTime;
        varying float vAlpha;

        // 方向数组与半径通过 attribute 传入不方便（线段要成对移动），
        // 这里用一个稳定的伪随机还原每条线的方向：直接用顶点自身位置做基准，
        // 由 JS 每帧写入 positions，所以这里只需要做拉伸与亮度。
        void main(){
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;

          float d = length(position - uCam);
          vAlpha = smoothstep(30.0, 260.0, d) * (0.35 + 0.65 * aSeed);
          vAlpha *= uIntensity;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main(){
          if (vAlpha < 0.01) discard;
          gl_FragColor = vec4(vec3(0.86, 0.93, 1.0) * vAlpha, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 50;
    lines.name = 'starlines';

    const state = {
      intensity: 0,
      target: 0,
    };

    const _v = new THREE.Vector3();
    const _fwd = new THREE.Vector3();

    /**
     * 每帧更新线段位置。
     * 思路：每条线从 dir*radius 出发，沿「远离相机中心」的方向拉出一段长度。
     * 跃迁越强，拉丝越长，同时整体半径收缩（像是被吸进去）。
     */
    function update(dt, time, camera, forward) {
      state.intensity = SAT.damp(state.intensity, state.target, 5, dt);

      const p = geo.attributes.position.array;
      const I = state.intensity;

      _fwd.copy(forward);
      void _fwd;

      // 半径随强度向内压缩：制造"事物朝你涌来"的速度感
      const shrink = 1 - I * 0.45;
      // 拉丝长度：强度越高越长
      const stretch = I * I * 900;

      const cx = camera.position.x;
      const cy = camera.position.y;
      const cz = camera.position.z;

      for (let i = 0; i < count; i++) {
        const dx = dirs[i * 3];
        const dy = dirs[i * 3 + 1];
        const dz = dirs[i * 3 + 2];
        const r = radii[i] * shrink;

        // 起点
        const x0 = cx + dx * r;
        const y0 = cy + dy * r;
        const z0 = cz + dz * r;

        // 终点：沿「从相机指向该点」的方向再往外拉
        // 这样拉丝的透视方向永远朝屏幕外，符合超空间观感
        const len = stretch * (0.35 + seeds[i] * 0.9);
        const x1 = cx + dx * (r + len);
        const y1 = cy + dy * (r + len);
        const z1 = cz + dz * (r + len);

        p[i * 6] = x0;
        p[i * 6 + 1] = y0;
        p[i * 6 + 2] = z0;
        p[i * 6 + 3] = x1;
        p[i * 6 + 4] = y1;
        p[i * 6 + 5] = z1;
      }

      geo.attributes.position.needsUpdate = true;

      mat.uniforms.uCam.value.copy(camera.position);
      mat.uniforms.uTime.value = time;
      mat.uniforms.uIntensity.value = state.intensity;

      lines.visible = I > 0.005;
    }

    /** 设置强度目标（0~1），会平滑过渡 */
    function setIntensity(v) {
      state.target = SAT.clamp(v, 0, 1);
    }

    /** 立即归零（跃迁结束时用） */
    function reset() {
      state.target = 0;
      state.intensity = 0;
      mat.uniforms.uIntensity.value = 0;
      lines.visible = false;
    }

    return {
      mesh: lines,
      update,
      setIntensity,
      reset,
      get intensity() {
        return state.intensity;
      },
      state,
    };
  }

  SAT.starlines = { create };
})();

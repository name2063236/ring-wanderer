/* =========================================================================
   ringfog.js — 环带内部体积雾
   · 玩家钻进环带时，按「距环平面 / 环径向范围」计算密度
   · 密度同时驱动：屏幕雾化、能见度、冰粒粒子
   · 不需要新几何——环带本身就是那个体积，这里只是给它"物质"
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  /* 全屏雾化：叠加一层带噪声的雾。
     注意：无雾时也必须把底图原样输出到屏幕——因为调用方已经把 bloom 的结果
     画进了离屏 RT，屏幕这时候还是空的。 */
  const fogVert = /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  const fogFrag = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tScene;
    uniform float uDensity;
    uniform float uTime;
    uniform vec3  uTint;

    ${SAT.GLSL.hash}
    ${SAT.GLSL.noise3}

    void main(){
      vec3 base = texture2D(tScene, vUv).rgb;

      if (uDensity < 0.002) {
        gl_FragColor = vec4(base, 1.0);
        return;
      }

      vec2 uv = vUv;
      float n = fbm3(vec3(uv * 3.5, uTime * 0.04), 3) * 0.5 + 0.5;
      vec2 warpUv = uv + vec2(n - 0.5, 0.0) * 0.0025 * uDensity;
      vec3 warped = texture2D(tScene, warpUv).rgb;

      vec2 c = uv - 0.5;
      float dist = length(c);
      float depthFog = smoothstep(0.05, 0.75, dist);
      float grain = fbm3(vec3(uv * 26.0, uTime * 0.7), 2) * 0.5 + 0.5;

      float fog = uDensity * (0.35 + 0.65 * depthFog) * (0.55 + 0.45 * grain);
      fog = clamp(fog, 0.0, 0.92);

      vec3 fogCol = uTint * (0.55 + 0.45 * grain);
      vec3 col = mix(warped, fogCol, fog);
      col += fogCol * fog * 0.22;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* 冰粒粒子：只在环带内部出现 */
  function makeIceMotes(count, R, ringThickness) {
    const rng = SAT.rng(31337);
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const ang = rng.f() * Math.PI * 2;
      const ru = rng.range(1.10, 2.42);
      const rad = ru * R;
      const y = rng.gauss(0, ringThickness * 1.1);
      pos[i * 3] = Math.cos(ang) * rad;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(ang) * rad;
      seed[i] = rng.f();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uDensity: { value: 0 },
        uTime: { value: 0 },
        uPixel: { value: Math.min(window.devicePixelRatio, 2) },
        uRange: { value: 1400 },
      },
      vertexShader: /* glsl */ `
        uniform vec3 uCam;
        uniform float uDensity;
        uniform float uTime;
        uniform float uPixel;
        uniform float uRange;
        attribute float aSeed;
        varying float vAlpha;

        void main(){
          vec3 rel = mod(position - uCam + uRange, uRange * 2.0) - uRange;
          vec3 wp = uCam + rel;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;

          float d = length(rel);
          float near = smoothstep(6.0, 60.0, d);
          float far = smoothstep(uRange, uRange * 0.4, d);

          vAlpha = near * far * uDensity * (0.35 + 0.65 * aSeed);
          vAlpha *= 0.55 + 0.45 * sin(uTime * 3.0 + aSeed * 50.0);

          gl_PointSize = (0.8 + aSeed * 2.0) * uPixel * (260.0 / max(-mv.z, 1.0));
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p) * 2.0;
          if (r > 1.0) discard;
          float a = smoothstep(1.0, 0.1, r) * vAlpha;
          gl_FragColor = vec4(vec3(0.86, 0.92, 1.0) * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.name = 'iceMotes';
    return pts;
  }

  function create(opts) {
    const { R, ringNormal, renderer } = opts;
    const ringThickness = opts.ringThickness || 62;

    const motes = makeIceMotes(2600, R, ringThickness);

    /* ---- 全屏合成：用裸 quad + 正交相机，但显式关闭 autoClear ---- */
    const quadScene = new THREE.Scene();
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fogMat = new THREE.ShaderMaterial({
      vertexShader: fogVert,
      fragmentShader: fogFrag,
      uniforms: {
        tScene: { value: null },
        uDensity: { value: 0 },
        uTime: { value: 0 },
        uTint: { value: new THREE.Color(0.62, 0.70, 0.82) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fogMat);
    quad.frustumCulled = false;
    quadScene.add(quad);

    const state = {
      density: 0,
      raw: 0,
      inRing: false,
      depth: 0,
    };

    const _v = new THREE.Vector3();
    const _n = new THREE.Vector3();

    /** 计算玩家处的环带密度 */
    function sampleDensity(camPos) {
      _n.copy(ringNormal).normalize();

      const h = Math.abs(camPos.dot(_n));
      const halfT = ringThickness * 0.5;
      const vert = 1.0 - SAT.smoothstep(halfT * 1.0, halfT * 4.0, h);

      // 环平面内的径向距离
      _v.copy(camPos).addScaledVector(_n, -camPos.dot(_n));
      const rInPlane = _v.length() / R;

      const inRadial =
        SAT.smoothstep(1.02, 1.16, rInPlane) * (1.0 - SAT.smoothstep(2.38, 2.60, rInPlane));

      let bandDensity = 0.55;
      if (rInPlane > 1.53 && rInPlane < 1.95) bandDensity = 1.0;
      else if (rInPlane > 2.03 && rInPlane < 2.35) bandDensity = 0.72;
      else if (rInPlane > 1.28 && rInPlane <= 1.53) bandDensity = 0.42;

      const d = vert * inRadial * bandDensity;
      state.depth = h / Math.max(halfT, 1);
      state.inRing = d > 0.05;
      return SAT.clamp(d, 0, 1);
    }

    function update(dt, time, camera) {
      const raw = sampleDensity(camera.position);
      state.raw = raw;
      state.density = SAT.damp(state.density, raw, 3.5, dt);

      motes.material.uniforms.uCam.value.copy(camera.position);
      motes.material.uniforms.uDensity.value = state.density;
      motes.material.uniforms.uTime.value = time;

      fogMat.uniforms.uDensity.value = state.density * 0.78;
      fogMat.uniforms.uTime.value = time;

      return state;
    }

    /**
     * 把 bloom 的结果合成到屏幕（可选叠加雾）。
     * 这是最后一道合成，必须无条件把画面输出到屏幕，
     * 否则无雾时屏幕会是全黑。
     */
    function composite(tSceneTexture, target) {
      fogMat.uniforms.tScene.value = tSceneTexture;

      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
      renderer.autoClear = prevAutoClear;
      return true;
    }

    /** 离开土星世界时调用：把雾与冰粒彻底复位 */
    function hide() {
      state.density = 0;
      state.raw = 0;
      state.inRing = false;
      fogMat.uniforms.uDensity.value = 0;
      motes.material.uniforms.uDensity.value = 0;
    }

    return {
      state,
      motes,
      update,
      composite,
      hide,
      get density() {
        return state.density;
      },
    };
  }

  SAT.ringfog = { create };
})();

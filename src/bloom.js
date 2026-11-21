/* =========================================================================
   bloom.js — 轻量泛光（亮部提取 → 降采样模糊 → 叠加），让恒星与环光晕更真实
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const quadVert = /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  const brightFrag = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uThreshold;
    uniform float uSoft;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float w = smoothstep(uThreshold, uThreshold + uSoft, lum);
      gl_FragColor = vec4(c * w, 1.0);
    }
  `;

  const blurFrag = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 uDir;      // 像素步长（已含半径）
    void main(){
      // 9 tap 高斯
      vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
      sum += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * 0.316216;
      sum += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * 0.316216;
      sum += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * 0.070270;
      sum += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * 0.070270;
      gl_FragColor = vec4(sum, 1.0);
    }
  `;

  const compositeFrag = /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tScene;
    uniform sampler2D tBloom1;
    uniform sampler2D tBloom2;
    uniform sampler2D tBloom3;
    uniform float uStrength;
    uniform float uTime;
    uniform vec2  uResolution;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

    void main(){
      vec3 base = texture2D(tScene, vUv).rgb;
      vec3 b = texture2D(tBloom1, vUv).rgb * 0.55
             + texture2D(tBloom2, vUv).rgb * 0.85
             + texture2D(tBloom3, vUv).rgb * 1.25;
      vec3 col = base + b * uStrength;

      // 轻微色散（边缘更明显）
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      float ca = r2 * 0.0028;
      col.r = mix(col.r, texture2D(tScene, vUv + d * ca).r, 0.55);
      col.b = mix(col.b, texture2D(tScene, vUv - d * ca).b, 0.55);

      // 暗角 + 颗粒
      float vig = smoothstep(1.25, 0.32, length(d) * 1.42);
      col *= mix(0.62, 1.0, vig);
      float g = hash(vUv * uResolution + fract(uTime) * 137.0) - 0.5;
      col += g * 0.016;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function create(renderer, opts) {
    const o = Object.assign(
      {
        threshold: 0.72,
        soft: 0.45,
        strength: 1.0,
        scale: 0.5,
      },
      opts || {}
    );

    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(quadGeo, null);
    quad.frustumCulled = false;
    quadScene.add(quad);

    const rtOpts = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };

    const sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const mkRT = () => new THREE.WebGLRenderTarget(1, 1, Object.assign({}, rtOpts));
    const l1a = mkRT(), l1b = mkRT(), l2a = mkRT(), l2b = mkRT(), l3a = mkRT(), l3b = mkRT();

    // 后处理钩子：允许在 bloom 之后叠加额外效果（如环带体积雾）
    const afterHook = { enabled: false, fn: null };
    const compositeRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    const brightMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: brightFrag,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: o.threshold }, uSoft: { value: o.soft } },
      depthTest: false,
      depthWrite: false,
    });

    const blurMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: blurFrag,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    });

    const compositeMat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: compositeFrag,
      uniforms: {
        tScene: { value: null },
        tBloom1: { value: null },
        tBloom2: { value: null },
        tBloom3: { value: null },
        uStrength: { value: o.strength },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });

    function drawPass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    }

    function setSize(w, h) {
      const sw = Math.max(2, Math.floor(w * o.scale));
      const sh = Math.max(2, Math.floor(h * o.scale));
      sceneRT.setSize(w, h);
      compositeRT.setSize(w, h);
      l1a.setSize(sw, sh); l1b.setSize(sw, sh);
      l2a.setSize(Math.max(2, sw >> 1), Math.max(2, sh >> 1));
      l2b.setSize(Math.max(2, sw >> 1), Math.max(2, sh >> 1));
      l3a.setSize(Math.max(2, sw >> 2), Math.max(2, sh >> 2));
      l3b.setSize(Math.max(2, sw >> 2), Math.max(2, sh >> 2));
      compositeMat.uniforms.uResolution.value.set(w, h);
    }

    function blur(src, dstA, dstB, radiusPx) {
      const w = dstA.width, h = dstA.height;
      blurMat.uniforms.tDiffuse.value = src.texture;
      blurMat.uniforms.uDir.value.set(radiusPx / w, 0);
      drawPass(blurMat, dstA);
      blurMat.uniforms.tDiffuse.value = dstA.texture;
      blurMat.uniforms.uDir.value.set(0, radiusPx / h);
      drawPass(blurMat, dstB);
      return dstB;
    }

    return {
      sceneRT,
      setSize,
      get strength() {
        return o.strength;
      },
      /** 设置面板调用：调整泛光强度 */
      setStrength(v) {
        o.strength = SAT.clamp(v, 0, 4);
      },
      /** 注册一个在 bloom 之后执行的合成钩子：fn(texture) 负责画到屏幕 */
      setAfterHook(fn) {
        afterHook.fn = fn;
        afterHook.enabled = typeof fn === 'function';
      },
      render(scene, camera, time, strengthScale) {
        renderer.setRenderTarget(sceneRT);
        renderer.clear();
        renderer.render(scene, camera);

        brightMat.uniforms.tDiffuse.value = sceneRT.texture;
        drawPass(brightMat, l1a);

        blur(l1a.texture, l1a, l1b, 1.0);
        blur(l1b.texture, l2a, l2b, 1.6);
        blur(l2b.texture, l3a, l3b, 2.4);

        compositeMat.uniforms.tScene.value = sceneRT.texture;
        compositeMat.uniforms.tBloom1.value = l1b.texture;
        compositeMat.uniforms.tBloom2.value = l2b.texture;
        compositeMat.uniforms.tBloom3.value = l3b.texture;
        compositeMat.uniforms.uTime.value = time;
        compositeMat.uniforms.uStrength.value = o.strength * (strengthScale === undefined ? 1 : strengthScale);

        // 有后处理钩子时，先输出到中间 RT，再交给钩子做最终合成
        if (afterHook.enabled) {
          drawPass(compositeMat, compositeRT);
          renderer.setRenderTarget(null);
          afterHook.fn(compositeRT.texture);
        } else {
          drawPass(compositeMat, null);
        }
      },
    };
  }

  SAT.bloom = { create };
})();

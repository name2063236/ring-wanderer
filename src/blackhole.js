/* =========================================================================
   blackhole.js — 引力透镜黑洞（光线追踪版）

   设计思路（关键区别）：
   旧版是「黑球 + 环形盘 + 描边」三个几何体拼在一起，
   所以看起来像贴片，没有环绕感。

   这版改为对每个像素做**光线偏折积分**：
     1. 从相机出发沿视线方向发射一条光线
     2. 每步施加引力加速度 a = -1.5·h²·r / r⁵（史瓦西时空的光子测地线）
     3. 光线进入视界 → 该像素为黑
     4. 光线穿过吸积盘 → 按体积密度累加发光
     5. 光线逃逸 → 采样星空（方向已被偏折）

   「环绕感」是这么自然产生的：
   盘在我们前方的部分直接可见（横穿画面的一条亮带）；
   盘在黑洞**背后**的部分本该被挡住，但引力把光线弯了过来，
   于是它的像出现在黑洞的上方和下方，形成拱弧。
   两者叠加，就是《星际穿越》里那个把黑洞整个包住的光环。

   因为我们逐像素积分，光子环（光线绕行多圈）、
   多重像、背景星空扭曲全都是**副产物**，不需要单独建模。
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const vert = /* glsl */ `
    varying vec3 vWorldPos;
    varying vec2 vUv;
    void main(){
      vUv = uv;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  const frag = /* glsl */ `
    precision highp float;

    varying vec3 vWorldPos;
    varying vec2 vUv;

    uniform vec3  uCamPos;
    uniform vec3  uBhPos;
    uniform float uRs;          // 史瓦西半径（世界单位）
    uniform float uDiskIn;      // 盘内缘，单位：rs
    uniform float uDiskOut;     // 盘外缘
    uniform float uTime;
    uniform float uBright;
    uniform float uHalf;        // 画布半宽（世界单位），用于边缘淡出
    uniform sampler2D uSky;     // 背景星空（等距柱状）
    uniform float uHasSky;
    uniform vec3  uDiskHot;
    uniform vec3  uDiskMid;
    uniform vec3  uDiskCool;
    uniform float uTanX;        // 视锥水平半角正切
    uniform float uTanY;        // 视锥垂直半角正切

    #define PI 3.14159265359
    #define STEPS 260

    /* ---------------- 噪声 ---------------- */
    float hash21(vec2 p){
      p = fract(p * vec2(127.31, 311.7));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }
    float noise2(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm2(vec2 p){
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++){ s += a * noise2(p); p *= 2.03; a *= 0.5; }
      return s;
    }

    /* 等距柱状投影采样坐标 */
    vec2 dirToUv(vec3 d){
      float lon = atan(d.z, d.x);
      float lat = asin(clamp(d.y, -1.0, 1.0));
      return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
    }

    /* 没有星空贴图时的过程式星点（应急） */
    vec3 procStars(vec3 d){
      float a = atan(d.z, d.x) / (2.0 * PI) + 0.5;
      float b = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI;
      vec2 uv = vec2(a, b) * vec2(220.0, 110.0);
      vec2 cell = floor(uv);
      float h = hash21(cell);
      if (h > 0.985) {
        vec2 f = fract(uv) - 0.5;
        float dist = length(f);
        float br = (h - 0.985) / 0.015;
        return vec3(0.85, 0.90, 1.0) * smoothstep(0.28, 0.0, dist) * br * 1.6;
      }
      return vec3(0.0);
    }

    void main(){
      /* 光线起点与方向。
         quad 被放在「相机前方 PLANE_DIST 处、朝向与相机一致」，
         所以 (vWorldPos - uCamPos) 天然就是该像素的真实视线方向。 */
      vec3 ro = (uCamPos - uBhPos) / uRs;
      vec3 rd = normalize(vWorldPos - uCamPos);

      /* 角动量平方：沿测地线守恒，先算一次 */
      vec3 hvec = cross(ro, rd);
      float h2 = dot(hvec, hvec);

      vec3 p = ro;
      vec3 v = rd;

      vec3 accum = vec3(0.0);
      float absorbed = 0.0;
      float transmittance = 1.0;

      for (int i = 0; i < STEPS; i++) {
        float r2 = dot(p, p);
        float r = sqrt(r2);

        /* 进入视界：被吞掉 */
        if (r < 1.0) { absorbed = 1.0; break; }

        /* 逃逸判定：已经走远且正在远离 */
        if (r > 42.0 && dot(p, v) > 0.0) break;

        /* 自适应步长：靠近黑洞时更细，保证盘面与光子环的精度 */
        float dt = clamp(r * 0.030, 0.008, 0.55);

        /* 进入盘所在半径范围时进一步细分，否则细丝纹理会被平均掉 */
        float rr0 = length(p.xz);
        if (rr0 > uDiskIn * 0.85 && rr0 < uDiskOut * 1.1) {
          dt = min(dt, 0.11);
        }

        /* ---------- 吸积盘：体积采样 ---------- */
        float rr = length(p.xz);
        if (rr > uDiskIn * 0.88 && rr < uDiskOut * 1.06) {
          /* 盘的半厚度：外圈更厚（薄雾感），内圈极薄 */
          float t01 = clamp((rr - uDiskIn) / (uDiskOut - uDiskIn), 0.0, 1.0);
          float hgt = 0.030 + 0.16 * pow(t01, 1.8);

          float vert = exp(-(p.y * p.y) / (hgt * hgt));
          if (vert > 0.004) {
            /* 径向包络：内缘陡起，外缘缓慢消失 */
            float edge = smoothstep(0.0, 0.045, t01)
                       * (1.0 - smoothstep(0.45, 1.0, t01));

            /* 开普勒差动 + 湍流细丝 */
            float ang = atan(p.z, p.x);
            float omega = 2.2 / pow(max(rr / uDiskIn, 0.45), 1.5);
            float ph = ang - uTime * omega;

            float turb = fbm2(vec2(ph * 3.4, rr * 1.35));
            float fila = fbm2(vec2(ph * 13.0, rr * 4.6));
            float fine = fbm2(vec2(ph * 34.0, rr * 11.0));
            float dens = edge * vert * (0.40 + 0.78 * turb) * (0.70 + 0.52 * fila) * (0.82 + 0.32 * fine);

            /* 温度随半径下降：内白热 → 橙 → 暗红 */
            vec3 em = mix(uDiskHot, uDiskMid, smoothstep(0.0, 0.11, t01));
            em = mix(em, uDiskCool, smoothstep(0.13, 0.72, t01));

            /* 内缘额外增亮（最内稳定圆轨道附近温度最高） */
            em *= 1.0 + 3.4 * exp(-t01 * 22.0);

            /* 光学厚度：越靠内越不透明，形成自遮挡 */
            float sigma = dens * 3.1;
            vec3 contrib = em * sigma * dt * uBright;

            accum += contrib * transmittance;
            transmittance *= exp(-sigma * dt * 0.55);
          }
        }

        /* ---------- 引力加速度（光子测地线）---------- */
        vec3 a = -1.5 * h2 * p / (r2 * r2 * r);
        v += a * dt;
        p += v * dt;
      }

      /* ---------- 背景：被偏折的星空 ---------- */
      vec3 skyCol = vec3(0.0);
      if (absorbed < 0.5) {
        vec3 dir = normalize(v);
        if (uHasSky > 0.5) {
          skyCol = texture2D(uSky, dirToUv(dir)).rgb;
        } else {
          skyCol = procStars(dir);
        }
        /* 靠近黑洞的方向略微拉亮，模拟强透镜区的星流 */
        float prox = pow(clamp(dot(normalize(ro), dir), 0.0, 1.0), 60.0);
        skyCol *= 1.0 + prox * 0.6;
      }

      vec3 col = accum + skyCol * transmittance * (1.0 - absorbed);

      /* 柔和的胶片式饱和，避免高光死白一片 */
      col = 1.0 - exp(-col * 1.05);

      /* 暗角：把注意力收拢到黑洞本身 */
      float vig = 1.0 - 0.50 * pow(length(vWorldPos - uCamPos) / max(uHalf, 1.0), 2.0);
      col *= clamp(vig, 0.35, 1.0);

      /* 这个 quad 铺满整个屏幕，内部自己采样星空，
         所以不需要边缘淡出——淡化反而会和背后的天空球重影。 */
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ------------------------------------------------------------------ */
  function create(R) {
    const group = new THREE.Group();
    group.name = 'world_blackhole';

    /* 视界半径：明显放大。相机距离约 9.5 rs 时，
       阴影（视觉半径 2.6 rs）约占画面宽度的 1/3。 */
    const rs = R * 0.55;

    const diskIn = 2.7;
    const diskOut = 7.2;

    const uniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uBhPos: { value: new THREE.Vector3(0, 0, 0) },
      uRs: { value: rs },
      uDiskIn: { value: diskIn },
      uDiskOut: { value: diskOut },
      uTime: { value: 0 },
      uBright: { value: 1.6 },
      uHalf: { value: rs * 17.0 },
      uSky: { value: null },
      uHasSky: { value: 0 },
      uDiskHot: { value: new THREE.Color(1.0, 0.96, 0.90) },
      uDiskMid: { value: new THREE.Color(1.0, 0.58, 0.20) },
      uDiskCool: { value: new THREE.Color(0.72, 0.16, 0.04) },
      uTanX: { value: 0.5 },
      uTanY: { value: 0.35 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    const quadGeo = new THREE.PlaneGeometry(2, 2); // 单位平面，靠 scale 控制大小
    const quad = new THREE.Mesh(quadGeo, mat);
    quad.name = 'bhLensing';
    quad.frustumCulled = false;
    quad.renderOrder = 3;
    group.add(quad);

    /* 世界坐标下的盘平面为 XZ（Y 向上）。
       相机从低仰角观察即可得到接近侧视的构图。 */
    const sunDir = new THREE.Vector3(0.0, 0.15, 0.99).normalize();

    const _fwd = new THREE.Vector3();
    const _bhWorld = new THREE.Vector3();
    const PLANE_DIST = rs * 6.0; // quad 放在相机前方这个距离

    return {
      group,
      def: { id: 'blackhole', name: '深渊', subtitle: '引力透镜与吸积盘' },

      /* 供 main.js 使用：推荐机位（低仰角，接近侧视） */
      camOffset: new THREE.Vector3(-0.92, 0.10, -0.38).normalize(),
      camDistMul: 7.4,

      sunDir,
      rs,
      /* 兼容旧自检的字段（新实现里它们只是标记） */
      disk: { isVolumetric: true },
      horizon: { isRaymarched: true },

      /** 跃迁重新烘焙星空后，把新贴图换上 */
      setSkyTexture(tex) {
        uniforms.uSky.value = tex || null;
        uniforms.uHasSky.value = tex ? 1 : 0;
      },

      update(dt, time, camera) {
        group.getWorldPosition(_bhWorld);

        /* quad 放在相机正前方固定距离，且与相机朝向完全一致，
           这样它的四个角正好对应视锥的四个角。 */
        camera.getWorldDirection(_fwd);
        quad.position.copy(camera.position).addScaledVector(_fwd, PLANE_DIST);
        quad.quaternion.copy(camera.quaternion);
        quad.updateMatrixWorld();

        const tanY = Math.tan((camera.fov * Math.PI) / 360);
        const tanX = tanY * camera.aspect;

        /* 平面尺寸按视锥算，略微放大以覆盖边缘 */
        quad.scale.set(PLANE_DIST * tanX * 2.02, PLANE_DIST * tanY * 2.02, 1);

        uniforms.uCamPos.value.copy(camera.position);
        uniforms.uBhPos.value.copy(_bhWorld);
        uniforms.uTanX.value = tanX * 1.01;
        uniforms.uTanY.value = tanY * 1.01;
        uniforms.uHalf.value = Math.max(rs * diskOut * 1.2, camera.position.distanceTo(_bhWorld));
        uniforms.uTime.value = time;
        void dt;
      },
    };
  }

  SAT.blackhole = { create };
})();

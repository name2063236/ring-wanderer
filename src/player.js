/* =========================================================================
   player.js — 第一人称飞行控制
   WASD 平移 / Space 上升 / Shift 下降 / 鼠标锁定视角 / Q E 滚转 / F 加速

   姿态用「四元数」表示，所有旋转都作用在机体自身的坐标轴上：
   - 鼠标横向 -> 绕机体上轴（永远是屏幕水平方向，与滚转角度无关）
   - 鼠标纵向 -> 绕机体右轴（永远是屏幕垂直方向，与滚转角度无关）
   - Q / E   -> 绕机体视轴（真正的横滚，可以无限翻滚）
   因此不管翻转了多少圈、是否倒飞，鼠标的手感都完全一致，也不存在角度墙。
   ========================================================================= */
(function () {
  const SAT = window.SAT;
  const THREE = window.THREE;

  const ROLL_SPEED = 1.15; // 弧度/秒

  function create(camera, domElement) {
    const state = {
      quat: new THREE.Quaternion(), // 权威姿态（无欧拉角、无万向锁）
      velocity: new THREE.Vector3(),
      speed: 0,
      boosting: false,
      locked: false,
      enabled: false,
      sensitivity: 0.00165, // 0.0022 × 0.75
      shake: 0,
      rollTotal: 0, // 累计滚转弧度（不取模，仅用于自检 / HUD）
      pendingDx: 0, // 本帧待处理的鼠标增量
      pendingDy: 0,
      carryDx: 0, // 超出单帧上限、留到下一帧继续消耗的余量
      carryDy: 0,
      spikeDrops: 0, // 被判定为异常尖峰而丢弃的事件数（诊断用）
      spikeGuard: true, // 是否启用尖峰防护（设置面板可关）
      keys: Object.create(null),
    };

    const baseSpeed = 105; // 单位/秒
    const boostMul = 8.5;
    const clampRadius = SAT.CONST.R * 1.08;

    const AXIS_X = new THREE.Vector3(1, 0, 0);
    const AXIS_Y = new THREE.Vector3(0, 1, 0);
    const AXIS_Z = new THREE.Vector3(0, 0, 1);
    const WORLD_UP = new THREE.Vector3(0, 1, 0);
    const REF_Z = new THREE.Vector3(0, 0, 1);
    const REF_X = new THREE.Vector3(1, 0, 0);

    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const wish = new THREE.Vector3();
    const tmp = new THREE.Vector3();

    const _q = new THREE.Quaternion();
    const _e = new THREE.Euler(0, 0, 0, 'XYZ');
    const _fwd = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const _m4 = new THREE.Matrix4();

    /* ---------------- 姿态工具 ---------------- */

    /** 绕「机体自身」的某个轴旋转（右乘 = 局部坐标系旋转） */
    function rotateLocal(axis, angle) {
      if (!angle) return;
      _q.setFromAxisAngle(axis, angle);
      state.quat.multiply(_q).normalize();
    }

    /**
     * 由「朝向 + 参考上方向」构造无滚转的姿态。
     * 相机的本地轴：+X 右、+Y 上、-Z 前，所以基矩阵列是 (right, up, -forward)。
     */
    function setForward(dir, upRef) {
      _fwd.copy(dir).normalize();

      // right = forward × upRef
      _right.crossVectors(_fwd, upRef);
      if (_right.lengthSq() < 1e-10) {
        // 朝向与参考上方向平行（正上/正下），换一个参考轴避免退化
        _right.crossVectors(_fwd, REF_Z);
        if (_right.lengthSq() < 1e-10) _right.crossVectors(_fwd, REF_X);
      }
      _right.normalize();

      // up = right × forward
      _up.crossVectors(_right, _fwd).normalize();

      _fwd.negate(); // 相机看向 -Z
      _m4.makeBasis(_right, _up, _fwd);
      state.quat.setFromRotationMatrix(_m4).normalize();
    }

    function getForward(out) {
      return (out || new THREE.Vector3()).set(0, 0, -1).applyQuaternion(state.quat);
    }
    function getUp(out) {
      return (out || new THREE.Vector3()).set(0, 1, 0).applyQuaternion(state.quat);
    }
    function getRight(out) {
      return (out || new THREE.Vector3()).set(1, 0, 0).applyQuaternion(state.quat);
    }
    /** 世界水平面上的航向角，供罗盘使用 */
    function getHeading() {
      getForward(tmp);
      return Math.atan2(-tmp.x, -tmp.z);
    }

    /* ---------------- 输入 ---------------- */

    function onKeyDown(e) {
      const code = e.code;
      state.keys[code] = true;
      if (['Space', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) {
        e.preventDefault();
      }
      if (!state.enabled) return;
      if (code === 'KeyR') {
        // 复位：保持当前朝向，只把滚转摆正（视线方向不变）
        getForward(tmp);
        setForward(tmp, WORLD_UP);
        state.rollTotal = 0;
        state.velocity.set(0, 0, 0);
      }
    }

    function onKeyUp(e) {
      state.keys[e.code] = false;
    }

    /**
     * 鼠标视角：始终绕机体自身轴，与当前滚转角度解耦。
     *
     * 指针锁定下浏览器的 movementX/Y 偶尔会给出异常尖峰（切换窗口、系统输入法、
     * 高回报率鼠标丢包、触控板手势都会触发），单个事件就能把视角甩到别处，
     * 这正是"视角每隔一段时间突然跳到别的地方"的来源。
     *
     * 防护分两级，逐事件判定（正常输入完全不受影响）：
     *   - 超过 DROP_EVENT：几乎不可能是真实操作，整条丢弃
     *   - 超过 MAX_EVENT：限幅到上限
     * 再对"每帧累计"设一个宽松上限，避免多事件叠加成一次瞬移。
     */
    const MAX_EVENT = 220; // 单个事件允许的最大像素位移
    const DROP_EVENT = 480; // 超过此值的单事件判为异常，直接丢弃
    const MAX_PER_FRAME = 380; // 单帧位移上限（约 34°，覆盖正常快甩；超出的直接丢弃）

    function applyLook(dx, dy) {
      // 设置面板可关闭尖峰防护（用于对比 / 排错）
      if (!state.spikeGuard) {
        state.pendingDx += dx;
        state.pendingDy += dy;
        return;
      }

      const aDx = Math.abs(dx);
      const aDy = Math.abs(dy);

      // 单事件尖峰：直接丢弃，不做任何旋转
      if (aDx > DROP_EVENT || aDy > DROP_EVENT) {
        state.spikeDrops++;
        return;
      }

      // 中等异常：限幅到物理上可能的范围
      if (aDx > MAX_EVENT) dx = Math.sign(dx) * MAX_EVENT;
      if (aDy > MAX_EVENT) dy = Math.sign(dy) * MAX_EVENT;

      state.pendingDx += dx;
      state.pendingDy += dy;
    }

    function flushLook(dt) {
      const totalX = state.pendingDx;
      const totalY = state.pendingDy;
      state.pendingDx = 0;
      state.pendingDy = 0;

      /* ---- 关键修复：超限即丢弃，不再顺延到后续帧 ----

         之前的"余量顺延"是跳变的主因：
         一帧内积压 2000px 时，本帧只施加 420px，
         剩下的 1580px 排到后续帧继续消耗 ——
         结果是**鼠标已经停了，画面还在自己转**，
         手感上就是"视角突然甩出去一大截"。
         现在超出的部分直接丢弃：宁可极端快甩损失一点行程，
         也绝不允许输入延迟到下一帧。 */

      /* 异常长帧（切世界、编译着色器、系统卡顿）：
         这一帧的累积位移全部作废。
         否则卡顿结束后会把积压的几百像素一次性释放，
         表现为"卡一下之后视角猛跳"。 */
      if (dt > 0.15) return;

      let dx = totalX;
      let dy = totalY;

      if (state.spikeGuard) {
        const cap = MAX_PER_FRAME;
        if (dx > cap) dx = cap;
        else if (dx < -cap) dx = -cap;
        if (dy > cap) dy = cap;
        else if (dy < -cap) dy = -cap;
      }

      const s = state.sensitivity;
      if (dx) rotateLocal(AXIS_Y, -dx * s);
      if (dy) rotateLocal(AXIS_X, -dy * s);
    }
    function onMouseMove(e) {
      if (!state.locked) return;
      applyLook(e.movementX || 0, e.movementY || 0);
    }

    function onPointerLockChange() {
      const locked = document.pointerLockElement === domElement;
      state.locked = locked;
      // 解锁即视为暂停：松开所有按键、停止推进（惯性会让飞船缓慢滑行到停）
      state.enabled = locked;
      // 丢弃暂停期间积累的鼠标位移，避免重新锁定时视角突然跳走
      state.pendingDx = 0;
      state.pendingDy = 0;
      state.carryDx = 0;
      state.carryDy = 0;
      if (!locked) {
        state.keys = Object.create(null);
        state.boosting = false;
      }
      if (window.SAT.onLockChange) window.SAT.onLockChange(locked);
    }

    // 切换标签页 / 最小化再回来时，浏览器可能补发一段巨大的位移，这里一并丢弃
    document.addEventListener('visibilitychange', () => {
      state.pendingDx = 0;
      state.pendingDy = 0;
    });

    document.addEventListener('keydown', onKeyDown, { passive: false });
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('blur', () => {
      state.keys = Object.create(null);
    });

    /* ---------------- 初始姿态 ---------------- */

    function lookAt(target) {
      tmp.copy(target).sub(camera.position).normalize();
      setForward(tmp, WORLD_UP);
      camera.quaternion.copy(state.quat);
    }

    /* ---------------- 每帧更新 ---------------- */

    function update(dt, time) {
      const k = state.keys;
      const active = state.enabled;

      // 先把本帧累积的鼠标位移以"限幅后"的方式施加到姿态上
      flushLook(dt);

      // 滚转：绕机体视轴，无角度上限（Q 向右倾，E 向左倾）
      const rollInput = (k['KeyQ'] ? 1 : 0) - (k['KeyE'] ? 1 : 0);
      if (rollInput !== 0) {
        const delta = rollInput * ROLL_SPEED * dt;
        rotateLocal(AXIS_Z, delta);
        state.rollTotal += delta;
      }

      // 机体坐标系
      getForward(forward);
      getRight(right);

      const fwdIn = (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0);
      const sideIn = (k['KeyD'] ? 1 : 0) - (k['KeyA'] ? 1 : 0);
      // Space 上升、Shift 下降，都是沿世界 Y 轴
      const upIn = (k['Space'] ? 1 : 0) - (k['ShiftLeft'] || k['ShiftRight'] ? 1 : 0);

      wish.set(0, 0, 0);
      if (active) {
        wish.addScaledVector(forward, fwdIn);
        wish.addScaledVector(right, sideIn);
        wish.y += upIn; // 世界 Y 轴，与滚转无关
        if (wish.lengthSq() > 0) wish.normalize();
      }

      const boosting = active && (k['KeyF'] || k['ControlLeft']) && wish.lengthSq() > 0;
      state.boosting = boosting;
      const maxSpeed = baseSpeed * (boosting ? boostMul : 1);
      const accel = boosting ? 2.4 : 4.2;

      // 有输入时加速逼近，无输入时缓慢滑行（真空惯性）
      const lam = wish.lengthSq() > 0 ? accel : 0.45;
      state.velocity.x = SAT.damp(state.velocity.x, wish.x * maxSpeed, lam, dt);
      state.velocity.y = SAT.damp(state.velocity.y, wish.y * maxSpeed, lam, dt);
      state.velocity.z = SAT.damp(state.velocity.z, wish.z * maxSpeed, lam, dt);

      camera.position.addScaledVector(state.velocity, dt);

      // 不允许穿进土星
      const d = camera.position.length();
      if (d < clampRadius) {
        camera.position.multiplyScalar(clampRadius / Math.max(d, 1e-3));
        state.velocity.multiplyScalar(0.25);
      }

      state.speed = state.velocity.length();

      // 先落权威姿态，再叠加镜头微震（微震不污染 state.quat）
      camera.quaternion.copy(state.quat);

      const shakeAmt = boosting ? 0.0016 : 0.00045;
      state.shake = SAT.damp(state.shake, shakeAmt, 3, dt);
      if (state.shake > 1e-5) {
        const sx = (Math.sin(time * 37.1) + Math.sin(time * 61.7) * 0.5) * state.shake;
        const sy = (Math.cos(time * 43.3) + Math.cos(time * 71.9) * 0.5) * state.shake;
        _e.set(sx, sy, 0);
        _q.setFromEuler(_e);
        camera.quaternion.multiply(_q).normalize();
      }

      return { boosting, speed: state.speed, roll: state.rollTotal };
    }

    /* ---------------- 供自动化测试直接注入 ---------------- */

    function testInput(keys, mouse) {
      state.enabled = true;
      state.locked = true;
      if (keys) for (const k in keys) state.keys[k] = keys[k];
      if (mouse) applyLook(mouse.dx || 0, mouse.dy || 0);
    }

    return {
      state,
      update,
      lookAt,
      testInput,
      getForward,
      getUp,
      getRight,
      getHeading,
      /** 触屏模式：没有指针锁定，手动开启输入 */
      setEnabled(on) {
        state.enabled = !!on;
        if (!on) state.keys = Object.create(null);
      },
      /** 设置面板调用：开关鼠标尖峰防护 */
      setSpikeGuard(on) {
        state.spikeGuard = !!on;
        state.pendingDx = 0;
        state.pendingDy = 0;
      },
      requestLock() {
        if (domElement.requestPointerLock) {
          const p = domElement.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      },
      exitLock() {
        if (document.pointerLockElement) document.exitPointerLock();
      },
      get locked() {
        return state.locked;
      },
    };
  }

  SAT.player = { create };
})();

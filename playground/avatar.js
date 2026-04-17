// ── Avatar: Living Orb System ───────────────────────────────────────────
// Two layers: user presence → texture, Ojaq mode → behavior, depth → cohesion

function map(v, lo, hi, oLo, oHi) {
  return oLo + ((v - lo) / (hi - lo)) * (oHi - oLo);
}

const MODE_CONFIG = {
  hold:      { speedMul: 0.3, cohesionMul: 0.8, brightMul: 0.7 },
  reflect:   { speedMul: 1.0, cohesionMul: 1.0, brightMul: 1.0 },
  challenge: { speedMul: 1.2, cohesionMul: 1.3, brightMul: 1.1 },
  celebrate: { speedMul: 1.5, cohesionMul: 0.7, brightMul: 1.5 },
  sit:       { speedMul: 0.4, cohesionMul: 1.2, brightMul: 0.5 },
};

class Orb {
  constructor(cx, cy, scale) {
    const s = scale || 1;
    this.x = cx + (Math.random() - 0.5) * 160 * s;
    this.y = cy + (Math.random() - 0.5) * 160 * s;
    this.vx = (Math.random() - 0.5) * 0.5;
    this.vy = (Math.random() - 0.5) * 0.5;
    this.baseR = (8 + Math.random() * 16) * s;
    this.phase = Math.random() * Math.PI * 2;
    this.orbitR = (30 + Math.random() * 70) * s;
  }

  update(cx, cy, params) {
    const { speed, cohesion, angularity, brightness, harmony, warmth, depth } = params;

    // Pull toward center
    const dx = cx - this.x, dy = cy - this.y;
    const pull = cohesion * 0.025;
    this.vx += dx * pull;
    this.vy += dy * pull;

    // Orbital — always some motion even at low harmony
    this.phase += speed * 0.015;
    const orbitForce = 0.3 + harmony * 0.5;
    this.vx += Math.cos(this.phase) * orbitForce;
    this.vy += Math.sin(this.phase * 0.7) * orbitForce;

    this.vx *= 0.93;
    this.vy *= 0.93;
    this.x += this.vx * speed;
    this.y += this.vy * speed;

    // Store render params
    this._r = this.baseR * (0.9 + depth * 0.3);
    this._brightness = brightness;
    this._warmth = warmth;
    this._angularity = angularity;
  }

  draw(ctx, t) {
    const r = this._r * (1 + Math.sin(t * 2 + this.phase) * 0.15);
    const hue = this._warmth * 40 + (1 - this._warmth) * 240;
    const sat = 35 + this._warmth * 25;
    const alpha = 0.2 + this._brightness * 0.5;  // always visible, brighter with engagement

    // Glow
    const grad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r * 3);
    grad.addColorStop(0, `hsla(${hue}, ${sat}%, 70%, ${alpha})`);
    grad.addColorStop(0.5, `hsla(${hue}, ${sat}%, 60%, ${alpha * 0.2})`);
    grad.addColorStop(1, `hsla(${hue}, ${sat}%, 50%, 0)`);
    ctx.beginPath();
    ctx.arc(this.x, this.y, r * 3, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Core
    ctx.beginPath();
    if (this._angularity > 0.6) {
      const sides = 4 + Math.floor((1 - this._angularity) * 5);
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2 + this.phase * 0.3;
        const px = this.x + Math.cos(a) * r;
        const py = this.y + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = `hsla(${hue}, ${sat - 10}%, 75%, ${alpha * 0.7})`;
    ctx.fill();
  }
}

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // Idle state feels alive — not zero, not intense. Breathing.
    this.target = { energy: 30, confidence: 50, resistance: 5, engagement: 40, congruence: 60, sentiment: 0.1 };
    this.current = { ...this.target };
    this.mode = 'reflect';
    this.depth = 0;
    this.t = 0;
    this.orbs = [];
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._animate();
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    this.canvas.width = w * devicePixelRatio;
    this.canvas.height = h * devicePixelRatio;
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this.w = w;
    this.h = h;
    if (this.orbs.length === 0) {
      const cx = w / 2, cy = h / 2;
      // Scale orbs relative to smallest dimension (400px = 1.0 baseline)
      const scale = Math.min(w, h) / 400;
      this.orbs = Array.from({ length: 12 }, () => new Orb(cx, cy, scale));
    }
  }

  setPresence(p) { this.target = { ...p }; this._settling = false; }
  setMode(m) { this.mode = m; }
  setDepth(d) { this.depth = d; }

  /** Slow-fade from current state toward a damped rest — keeps the
   *  emotional fingerprint of wherever the session ended, just softer. */
  settleToRest(durationMs = 2500) {
    this._settling = true;
    this._settleStart = performance.now();
    this._settleDuration = durationMs;
    this._settleFrom = { ...this.current };
    this._settleTarget = {
      energy:     this.current.energy * 0.2,      // low but echoing
      confidence: this.current.confidence,          // structural, unchanged
      resistance: this.current.resistance * 0.4,    // doesn't fully release
      engagement: this.current.engagement * 0.3,    // quiet presence
      congruence: this.current.congruence,          // structural, unchanged
      sentiment:  this.current.sentiment * 0.6,     // warmth carries forward
    };
    this.mode = 'hold';
  }

  _animate() {
    this.t += 0.016;

    // Settling animation — smooth ease-out over duration
    if (this._settling) {
      const elapsed = performance.now() - this._settleStart;
      const t = Math.min(1, elapsed / this._settleDuration);
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
      for (const k of Object.keys(this._settleTarget)) {
        this.current[k] = this._settleFrom[k] + (this._settleTarget[k] - this._settleFrom[k]) * ease;
      }
      if (t >= 1) {
        this._settling = false;
        this.target = { ...this._settleTarget };
      }
    } else {
      // Normal smooth interpolation
      for (const k of Object.keys(this.target)) {
        if (typeof this.current[k] === 'number') {
          this.current[k] += (this.target[k] - this.current[k]) * 0.04;
        }
      }
    }

    const { energy, confidence, resistance, engagement, congruence, sentiment } = this.current;
    const mc = MODE_CONFIG[this.mode] || MODE_CONFIG.reflect;

    const params = {
      speed:      map(energy, 0, 100, 0.6, 2.5) * mc.speedMul,
      cohesion:   map(confidence, 0, 100, 0.2, 1.0) * mc.cohesionMul * (0.5 + this.depth * 0.5),
      angularity: map(resistance, 0, 100, 0, 1),
      brightness: map(engagement, 0, 100, 0.4, 1.0) * mc.brightMul,
      harmony:    map(congruence, 0, 100, 0.2, 1),
      warmth:     map(sentiment, -1, 1, 0, 1),
      depth:      this.depth,
    };

    const cx = this.w / 2, cy = this.h / 2;

    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const orb of this.orbs) {
      orb.update(cx, cy, params);
      orb.draw(this.ctx, this.t);
    }

    requestAnimationFrame(() => this._animate());
  }
}

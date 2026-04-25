// ── Avatar: Living Orb System ───────────────────────────────────────────
// Two layers: user presence → texture, Ojaq mode → behavior, depth → cohesion

function map(v, lo, hi, oLo, oHi) {
  return oLo + ((v - lo) / (hi - lo)) * (oHi - oLo);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Hue lerp that always takes the shorter arc on the color wheel.
function shortArcHueLerp(a, b, t) {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  else if (diff < -180) diff += 360;
  return ((a + diff * t) % 360 + 360) % 360;
}

function hexToHsl(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let hue = 0, sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r)      hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else                hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { hue, sat: sat * 100 };
}

const MODE_CONFIG = {
  hold:      { speedMul: 0.3, cohesionMul: 0.8, brightMul: 0.7 },
  reflect:   { speedMul: 1.0, cohesionMul: 1.0, brightMul: 1.0 },
  challenge: { speedMul: 1.2, cohesionMul: 1.3, brightMul: 1.1 },
  celebrate: { speedMul: 1.5, cohesionMul: 0.7, brightMul: 1.5 },
  sit:       { speedMul: 0.4, cohesionMul: 1.2, brightMul: 0.5 },
};

// Plutchik 8-class → orb hue map. Hues sit roughly on the wheel:
// joy (yellow) → trust (green-yellow) → fear (green) → surprise (cyan) →
// sadness (blue) → disgust (purple) → anger (red) → anticipation (orange).
// neutral = null falls back to sentiment-based hue (no override).
const PLUTCHIK_HUES = {
  joy:           50,   // warm yellow
  trust:         100,  // light green
  fear:          140,  // dark green
  surprise:      190,  // cyan
  sadness:       220,  // blue
  disgust:       285,  // purple
  anger:         0,    // red
  anticipation:  30,   // orange
  neutral:       null, // no override
};
const EMOTION_SAT = 55;  // how saturated emotion-tinted orbs are

class Orb {
  constructor(cx, cy, scale) {
    const s = scale || 1;
    this.phase = Math.random() * Math.PI * 2;
    this.orbitR = (30 + Math.random() * 70) * s;
    // Born already on the orbital path — no scatter-and-converge phase.
    // The opening seconds need a meditative alignment, not chaotic settling.
    this.x = cx + Math.cos(this.phase) * this.orbitR;
    this.y = cy + Math.sin(this.phase * 0.7) * this.orbitR * 0.6;
    this.vx = 0;
    this.vy = 0;
    this.baseR = (8 + Math.random() * 16) * s;
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
    this._speakerHue = params.speakerHue || 0;
    this._speakerSat = params.speakerSat || 0;
    this._speakerStrength = params.speakerStrength || 0;
    this._emotionHue = params.emotionHue || 0;
    this._emotionSat = params.emotionSat || 0;
    this._emotionStrength = params.emotionStrength || 0;
    this._birthOpacity = params.birthOpacity ?? 1;
  }

  draw(ctx, t) {
    const r = this._r * (1 + Math.sin(t * 2 + this.phase) * 0.15);
    // Hue stack — three layers, applied in order:
    //   1) sentiment-based baseline (cold blue ↔ warm orange from /analyze)
    //   2) emotion-based override (Plutchik hue from realtime SER stream)
    //   3) speaker-based tint (multi-speaker: one hue per voice)
    // Each layer's strength gates the lerp; with all strengths at 0 we
    // fall back to the sentiment baseline (existing behavior preserved).
    const sentimentHue = this._warmth * 40 + (1 - this._warmth) * 240;
    const sentimentSat = 35 + this._warmth * 25;
    let hue = shortArcHueLerp(sentimentHue, this._emotionHue, this._emotionStrength);
    let sat = lerp(sentimentSat, this._emotionSat, this._emotionStrength);
    hue = shortArcHueLerp(hue, this._speakerHue, this._speakerStrength);
    sat = lerp(sat, this._speakerSat, this._speakerStrength);
    const alpha = (0.2 + this._brightness * 0.5) * this._birthOpacity;  // always visible, brighter with engagement; faded during birth

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
    this.speakerHue = 0;
    this.speakerSat = 0;
    this.speakerStrength = 0;
    this._colorTween = null;
    // Emotion-driven hue (independent channel from speaker color).
    this.emotionHue = 0;
    this.emotionSat = 0;
    this.emotionStrength = 0;
    this._emotionTween = null;
    // Frame-count fade-in for a meditative entrance (~1.5s @ 60fps).
    // Prevents the first second from feeling like the orbs are crashing into existence.
    this._birthFrames = 0;
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

  /** Tint the orb toward a Plutchik emotion. Updates from the realtime
   *  SER stream — strength scales with intensity (0.5 floor so even soft
   *  reads register, capped at 0.85 so emotion doesn't fully obliterate
   *  speaker tint when both are active). emotion='neutral' (or unknown)
   *  fades strength to 0 and the orb falls back to sentiment baseline. */
  setEmotion(emotion, intensity = 0.5, fadeMs = 700) {
    const targetHue = PLUTCHIK_HUES[emotion];
    const fromHue = this.emotionHue;
    const fromSat = this.emotionSat;
    const fromStrength = this.emotionStrength;
    let toHue, toSat, toStrength;
    if (targetHue == null) {
      // neutral / unknown — fade out, hold last hue so transition is smooth
      toHue = fromHue;
      toSat = fromSat;
      toStrength = 0;
    } else {
      toHue = targetHue;
      toSat = EMOTION_SAT;
      toStrength = Math.max(0.5, Math.min(0.85, 0.5 + (intensity || 0) * 0.4));
    }
    this._emotionTween = {
      fromHue, fromSat, fromStrength,
      toHue, toSat, toStrength,
      start: performance.now(),
      duration: fadeMs,
    };
  }

  /** Tint the orb toward a speaker-specific color. hex=null clears the tint.
   *  Sentiment stays the primary signal (strength maxes at 0.5). */
  setSpeakerColor(hex, fadeMs = 700) {
    const fromHue = this.speakerHue;
    const fromSat = this.speakerSat;
    const fromStrength = this.speakerStrength;
    let toHue, toSat, toStrength;
    if (hex == null) {
      // Fade out — hold current hue/sat frozen, drop strength to 0 so no extra rotation during the fade
      toHue = fromHue;
      toSat = fromSat;
      toStrength = 0;
    } else {
      const { hue, sat } = hexToHsl(hex);
      toHue = hue;
      toSat = sat;
      toStrength = 0.5;
    }
    this._colorTween = {
      fromHue, fromSat, fromStrength,
      toHue, toSat, toStrength,
      start: performance.now(),
      duration: fadeMs,
    };
  }

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

    // Speaker color tween — independent of presence/settle animations
    if (this._colorTween) {
      const ct = this._colorTween;
      const t = Math.min(1, (performance.now() - ct.start) / ct.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.speakerHue      = shortArcHueLerp(ct.fromHue, ct.toHue, ease);
      this.speakerSat      = lerp(ct.fromSat, ct.toSat, ease);
      this.speakerStrength = lerp(ct.fromStrength, ct.toStrength, ease);
      if (t >= 1) this._colorTween = null;
    }

    // Emotion color tween — same shape, independent channel
    if (this._emotionTween) {
      const et = this._emotionTween;
      const t = Math.min(1, (performance.now() - et.start) / et.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.emotionHue      = shortArcHueLerp(et.fromHue, et.toHue, ease);
      this.emotionSat      = lerp(et.fromSat, et.toSat, ease);
      this.emotionStrength = lerp(et.fromStrength, et.toStrength, ease);
      if (t >= 1) this._emotionTween = null;
    }

    const { energy, confidence, resistance, engagement, congruence, sentiment } = this.current;
    const mc = MODE_CONFIG[this.mode] || MODE_CONFIG.reflect;

    // Birth fade-in — orbs emerge from invisible to natural opacity over ~1.5s.
    // Once fully born, this stays at 1 forever and is a no-op.
    this._birthFrames++;
    const birthOpacity = Math.min(1, this._birthFrames / 90);

    const params = {
      speed:      map(energy, 0, 100, 0.6, 2.5) * mc.speedMul,
      cohesion:   map(confidence, 0, 100, 0.2, 1.0) * mc.cohesionMul * (0.5 + this.depth * 0.5),
      angularity: map(resistance, 0, 100, 0, 1),
      brightness: map(engagement, 0, 100, 0.4, 1.0) * mc.brightMul,
      harmony:    map(congruence, 0, 100, 0.2, 1),
      warmth:     map(sentiment, -1, 1, 0, 1),
      depth:      this.depth,
      speakerHue:      this.speakerHue,
      speakerSat:      this.speakerSat,
      speakerStrength: this.speakerStrength,
      emotionHue:      this.emotionHue,
      emotionSat:      this.emotionSat,
      emotionStrength: this.emotionStrength,
      birthOpacity,
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

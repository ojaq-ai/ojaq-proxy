// ── Presence extraction + emotion mapping ───────────────────────────────

export function extractPresence(textBuf) {
  // Try fenced ```json block first, then any {..."presence"...} object
  const m = textBuf.match(/```json\s*([\s\S]*?)```/i)
         || textBuf.match(/```\s*([\s\S]*?)```/);
  const raw = m ? m[1] : textBuf.match(/\{[\s\S]*"presence"[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.trim());
    if (!obj.presence) return null;
    return obj;
  } catch { return null; }
}

export function mapEmotion(p) {
  const { resistance = 0, energy = 0, engagement = 0, sentiment = 0, confidence = 0, congruence = 0 } = p;

  // Score each state — highest score wins. No more falling through to neutral.
  const scores = {
    warning:   (resistance > 60 && sentiment < -0.3) ? resistance * 1.2 + Math.abs(sentiment) * 40 : 0,
    alert:     (resistance > 40 || energy > 60) ? Math.max(resistance, energy) : 0,
    insight:   (engagement > 50 && sentiment > 0.1) ? engagement * 0.8 + sentiment * 30 : 0,
    listening: (energy > 20 || engagement > 30) ? (energy + engagement) * 0.5 : 0,
  };

  let best = 'neutral';
  let bestScore = 10; // neutral threshold — anything above this wins
  for (const [emotion, score] of Object.entries(scores)) {
    if (score > bestScore) { best = emotion; bestScore = score; }
  }

  // Intensity: dominant signal strength, always meaningful
  const intensity = clamp(Math.max(energy, engagement, resistance, confidence * 0.5));

  return { emotion: best, intensity };
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

// Sparkline data (last N presence reports)
export class PresenceHistory {
  constructor(maxLen = 20) {
    this.maxLen = maxLen;
    this.entries = [];
  }

  push(presence) {
    this.entries.push({ ...presence, t: Date.now() });
    if (this.entries.length > this.maxLen) this.entries.shift();
  }

  // Returns array of values for a given dimension
  series(dim) {
    return this.entries.map(e => e[dim] ?? 0);
  }
}

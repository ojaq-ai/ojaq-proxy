// ── Presence extraction + emotion mapping ───────────────────────────────

export function extractPresence(textBuf) {
  const m = textBuf.match(/```json\s*([\s\S]*?)```/i);
  const raw = m ? m[1] : textBuf.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj.presence) return null;
    return obj;
  } catch { return null; }
}

export function mapEmotion(p) {
  const { resistance = 0, energy = 0, engagement = 0, sentiment = 0, confidence = 0 } = p;
  if (resistance > 80 && sentiment < -0.5)
    return { emotion: 'warning', intensity: clamp(resistance) };
  if (resistance > 60 || energy > 75)
    return { emotion: 'alert', intensity: clamp(Math.max(resistance, energy)) };
  if (engagement > 70 && sentiment > 0.3)
    return { emotion: 'insight', intensity: clamp(engagement) };
  if (confidence < 40 && energy > 30)
    return { emotion: 'listening', intensity: clamp(energy) };
  return { emotion: 'neutral', intensity: 0 };
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

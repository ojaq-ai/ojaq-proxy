// ── Session Conductor ───────────────────────────────────────────────────
// Watches presence data and sends [CMD:] commands to shape the session.

export class SessionConductor {
  constructor(framework) {
    this.framework = framework;
    this.phase = 'arrival';
    this.mode = 'reflect';
    this.startTime = Date.now();
    this.presenceHistory = [];
    this.depth = 0;
    this._listeners = [];
  }

  onChange(fn) { this._listeners.push(fn); }
  _emit() { for (const fn of this._listeners) fn({ phase: this.phase, mode: this.mode, depth: this.depth }); }

  onPresence(presence, sendCmd) {
    this.presenceHistory.push({ ...presence, t: Date.now() });
    const elapsed = Date.now() - this.startTime;
    const turnCount = this.presenceHistory.length;

    // Don't send any commands during the first 3 turns — let the session settle
    if (turnCount <= 3) {
      this._emit();
      return;
    }
    const prev = this.presenceHistory.length > 1
      ? this.presenceHistory[this.presenceHistory.length - 2] : null;
    let changed = false;

    // ── phase transitions ──
    const pw = this.framework.phaseWeights;

    if (this.phase === 'arrival' && elapsed > (pw.arrival?.durationMs || 120000)) {
      this.phase = 'exploration';
      changed = true;
    }

    if (this.phase === 'exploration' && prev) {
      const congruenceDrop = prev.congruence - presence.congruence > 25;
      const resistanceSpike = presence.resistance > 70 && prev.resistance < 40;
      const energyShift = Math.abs(presence.energy - prev.energy) > 30;
      if (congruenceDrop || resistanceSpike || energyShift) {
        this.phase = 'deepen';
        this.depth = Math.min(1, this.depth + 0.3);
        sendCmd('[CMD:phase:deepen]');
        changed = true;
      }
    }

    if (this.phase === 'deepen') {
      if (presence.energy < 50 && presence.resistance < 30 && presence.congruence > 60) {
        this.phase = 'exploration';
        changed = true;
      }
    }

    if (pw.integrate?.triggerAfterMs && elapsed > pw.integrate.triggerAfterMs
        && this.phase !== 'integrate' && this.phase !== 'close') {
      this.phase = 'integrate';
      sendCmd('[CMD:phase:integrate]');
      changed = true;
    }

    if (pw.close?.triggerAfterMs && elapsed > pw.close.triggerAfterMs
        && this.phase !== 'close') {
      this.phase = 'close';
      sendCmd('[CMD:phase:close]');
      changed = true;
    }

    // ── mode transitions ──
    const newMode = this._pickMode(presence);
    if (newMode !== this.mode) {
      this.mode = newMode;
      sendCmd(`[CMD:mode:${newMode}]`);
      changed = true;
    }

    // ── depth ──
    if (presence.engagement > 70 && presence.congruence > 60) {
      this.depth = Math.min(1, this.depth + 0.05);
      changed = true;
    }

    if (changed) this._emit();
  }

  _pickMode(p) {
    const prefs = this.framework.modePreferences;
    const avoid = prefs.avoid || [];

    if (p.sentiment < -0.5 && p.resistance < 30 && !avoid.includes('sit'))
      return 'sit';
    if (p.resistance > 70 || p.energy < 20)
      return 'hold';
    if (p.congruence > 80 && p.engagement > 80 && p.sentiment > 0.3)
      return 'celebrate';
    const ct = prefs.challengeThreshold;
    if (ct && p.confidence > ct.confidence && p.congruence < ct.congruence && !avoid.includes('challenge'))
      return 'challenge';
    return 'reflect';
  }

  get elapsed() { return Date.now() - this.startTime; }
}

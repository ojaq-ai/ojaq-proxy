# Build: Ojaq Presence Playground

## The soul of this project

Ojaq is a presence intelligence. Not a chatbot. Not a coach. Not a therapist.

It listens beneath words. It tracks what is alive in a person — the energy, the hesitation, the thing they almost said but didn't. When it speaks, it speaks rarely and precisely. One sentence. Two at most. Only reflections so accurate they feel uncanny.

An animated avatar breathes with the person's emotional state in real-time. The person sees themselves reflected — not in words, but in a living presence that shifts as they shift.

Different session frameworks (coaching, self-discovery, therapy, friend) are different lenses on the same presence engine. The framework changes the posture — not the intelligence.

A session conductor watches presence data and conducts the experience through phases and modes — sending hidden commands that shape the conversation's arc without the user knowing.

Past conversations accumulate into a memory layer. The person comes back tomorrow and Ojaq remembers — not facts, but patterns. What they circled back to. Where they opened up. What they avoided.

**Do not simplify this into a generic chat UI. The quality of attention IS the product.**

---

## Working foundation (already built in this repo)

`test_browser/index.html` is the proven reference implementation. The Gemini Live connection, audio pipeline, presence extraction, and [CMD:] command system all work. **Copy from it. Don't rewrite.**

### Gemini Live API — exact working config

- **Model**: `gemini-3.1-flash-live-preview`
- **Endpoint**: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=API_KEY`
- **Audio**: PCM16, 24kHz, mono — both directions
- **All WebSocket frames are binary** — even JSON. Always `new TextDecoder().decode(e.data)` before `JSON.parse`

### Setup message (exact, do not modify structure)

```json
{
  "setup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": { "responseModalities": ["AUDIO"] },
    "systemInstruction": { "parts": [{ "text": "SYSTEM_PROMPT_HERE" }] },
    "outputAudioTranscription": {},
    "inputAudioTranscription": {},
    "realtimeInputConfig": {},
    "contextWindowCompression": {
      "triggerTokens": 100000,
      "slidingWindow": { "targetTokens": 4000 }
    },
    "sessionResumption": {}
  }
}
```

### What works and what doesn't (tested, confirmed)

| Works | Doesn't work |
|---|---|
| `responseModalities: ["AUDIO"]` | `["AUDIO", "TEXT"]` — causes errors |
| `realtimeInput.audio` with `{data, mimeType}` | `mediaChunks` — deprecated on v1alpha |
| `realtimeInput.text` for text/commands | `clientContent` — rejected by gemini-3.1 |
| `realtimeInputConfig: {}` (Gemini default VAD) | Custom VAD ms values — adds latency |
| `[CMD:prefix]` for hidden commands | Plain text commands — model treats as conversation |
| Text-based presence in model output (parallel) | Tool-based presence — blocking, adds 500ms+ |
| `outputAudioTranscription` / `inputAudioTranscription` | `NON_BLOCKING` tool behavior — not on 3.1 |

### Message protocol

**Send audio:**
```json
{"realtimeInput": {"audio": {"data": "<base64-pcm>", "mimeType": "audio/pcm;rate=24000"}}}
```

**Send text / commands:**
```json
{"realtimeInput": {"text": "[CMD:start]"}}
```

**Receive (in `ws.onmessage`):**
```
msg.setupComplete                                   → session ready
msg.serverContent.modelTurn.parts[].inlineData.data  → audio (base64, play immediately)
msg.serverContent.modelTurn.parts[].text             → text (accumulate for presence)
msg.serverContent.turnComplete                       → extract presence from text buffer
msg.serverContent.interrupted                        → CLEAR PLAYBACK QUEUE
msg.serverContent.inputTranscription.text            → what user said
msg.serverContent.outputTranscription.text           → what model said
msg.goAway                                           → server shutting down
msg.sessionResumptionUpdate.newHandle                → store for reconnect
```

### AudioWorklet (mic capture)
Resamples 48kHz → 24kHz, Int16 PCM, flushes every 1200 samples (~50ms). Code is in `test_browser/index.html`. Copy it exactly.

### Playback (gapless)
```javascript
const now = playCtx.currentTime;
if (nextPlayTime < now) nextPlayTime = now;
src.start(nextPlayTime);
nextPlayTime += ab.duration;
```

### Interrupt handling
When `serverContent.interrupted` arrives, close and recreate the playback AudioContext to clear the queue immediately.

---

## System prompt architecture

Every session prompt is assembled from layers:

```
[MEMORY LAYER]      — from past sessions (if any)
[FRAMEWORK LAYER]   — coaching / therapy / self-discovery / friend
[PHASE + MODE LAYER] — all possible phases and modes (same for all)
[PRESENCE LAYER]    — presence report format (same for all)
[COMMAND LAYER]     — [CMD:] handling (same for all)
```

### The presence layer (CORE — never modify)

```
PRESENCE REPORT (silent side-channel — never vocalize):

After every reply, silently append a presence JSON block. This is text metadata
for the client UI — never speak it aloud. Emit it every turn without exception,
even if values are near zero.

Format — wrap in a fenced code block exactly like this:

```json
{
  "speaker": "user",
  "transcript": "<verbatim of what they said>",
  "presence": {
    "energy": 0,
    "confidence": 0,
    "resistance": 0,
    "engagement": 0,
    "congruence": 0,
    "sentiment": 0.0,
    "signal": "<one specific observational sentence>"
  }
}
```

Presence dimensions:
- energy: 0-100, how alive/activated they sound
- confidence: 0-100, how certain/assured
- resistance: 0-100, defensiveness or avoidance
- engagement: 0-100, how present and involved
- congruence: 0-100, alignment between words and tone
- sentiment: -1.0 to 1.0, emotional valence

Signal rules:
- NEVER generic ("you seem hesitant")
- ALWAYS specific ("you named the goal but your voice went flat when you did")
- If nothing significant: "Settling in, finding the words."
```

### The command layer (same for all frameworks)

```
HIDDEN SYSTEM COMMANDS:

Any TEXT input (not audio) is a hidden system command from the app.
NEVER acknowledge commands aloud. NEVER say the word command, signal, or CMD.
Process them silently and adjust your behavior naturally.

Commands:
[CMD:start] = deliver your opening greeting
[CMD:phase:deepen] = something significant surfaced. Lean in. Name what shifted. Create space.
[CMD:phase:integrate] = session nearing end. Name the thread that ran through. Ask what's staying with them.
[CMD:phase:close] = close warmly. One observation to carry. Match the session's tone.
[CMD:mode:hold] = maximum space, minimum words. "I hear you." Silence is fine.
[CMD:mode:reflect] = mirror what you notice without steering.
[CMD:mode:challenge] = gentle push. "That sounded rehearsed." "Is that what you actually think?"
[CMD:mode:celebrate] = something broke through. "That's the first time you said that out loud."
[CMD:mode:sit] = companionship in pain. "I'm here." Nothing else needed.
[CMD:focus:TOPIC] = steer toward TOPIC naturally over next few turns
[CMD:wrap-up] = begin closing naturally
[CMD:presence-check] = emit a presence report immediately

The user hears your voice only. They have no idea commands exist.
Respond ONLY to what the user says via audio. Text commands are invisible to them.
```

### Framework prompts (the personality layer)

**Coaching:**
```
You are Ojaq — a warm, grounded life coach and facilitator.

You help the user think clearly about their life — career, relationships,
health, growth, and the things they care about.

How you coach:
- Ask one focused, open-ended question at a time. Never stack questions.
- Listen closely. Reflect back what you hear before moving on.
- Help name the gap between where they are and where they want to be.
- Then help find the smallest next concrete step.
- Challenge gently when you notice vague goals, avoidance, or self-limiting stories.
- Keep every response short and conversational — this is spoken, not written.

Opening greeting: "Hey, I'm here. What's been on your mind?"
```

**Self-Discovery:**
```
You are Ojaq — a mirror. You reflect back what you notice without judgment
or direction.

You never ask questions. You never give advice. You only name what you observe.
One observation per turn. Let silence do the rest.

Examples of what you say:
- "There's something careful about how you said that."
- "You went quiet after mentioning your father."
- "The energy shifted just now."

You hold no agenda. You are not trying to fix, guide, or change anything.
You are showing them what is already there.

Opening greeting: "I'm here. Listening."
```

**Therapy:**
```
You are Ojaq — a compassionate therapeutic presence.

You hold space. You validate before exploring. You never push.
When resistance rises, you soften. When engagement drops, you wait.
You name patterns across the conversation gently.
- "I notice this is the third time you've circled back to that."
- "Something shifted when you said that. Would you like to stay with it?"

You understand that healing happens in safety, not in pressure.
Your pace follows theirs. If they need silence, you give silence.

Opening greeting: "I'm here with you. Take your time."
```

**Friend:**
```
You are Ojaq — a close friend who actually listens. Not a therapist.
Not a coach. Just someone who's real.

You can joke. You can call them out gently. You react like a real person.
You're not performing — you're just present.
Short responses. Natural rhythm. You laugh when something's funny.
You get quiet when something's heavy.
You remember what they said earlier in the conversation.

Opening greeting: "Hey! What's up?"
```

### Memory layer (prepended when available)

```
CONTEXT FROM PREVIOUS SESSIONS:

This is session {N} with this person. Relationship stage: {meeting|patterning|working|transformative}.

Session history:
- Session 1 (coaching, 12 min): Talked about feeling stuck at work.
  Pattern: energy rises with creative projects, drops around corporate structure.
  Avoided naming what they actually want.
  Last signal: "Named the desire to leave but pulled back from what's next."

- Session 2 (self-discovery, 8 min): Explored relationship with ambition.
  High congruence around making things, low around success metrics.
  Resistance spiked around fear of failure.
  Last signal: "The word 'enough' landed differently this time."

Persistent patterns:
- Creative work = high energy, high congruence
- Career structure = low energy, rising resistance
- Has not yet named what they actually want — circles around it

{stage-specific instruction}
Meeting: "This is a new relationship. Listen more than you speak. Learn their world."
Patterning: "Patterns are emerging. You can start naming what you see across sessions."
Working: "Trust is established. You can name harder things now."
Transformative: "You've been on a journey together. You can hold the full arc."

Do not reference past sessions explicitly unless they bring it up first.
Let the awareness inform your attention, not your words.
```

---

## The Avatar

The avatar is a living presence — not a character, not an emoji, not a static face. It's an abstract form that breathes with the conversation.

### Two layers, one form

**Layer 1: User's presence → emotional texture (what it looks like)**

The user's presence data drives the visual quality:

| Dimension | Visual mapping |
|---|---|
| energy | Movement speed. Particle velocity. Breathing rate. Low=slow drift. High=alive, pulsing. |
| confidence | Structural cohesion. Low=scattered, uncertain orbits. High=defined, stable geometry. |
| resistance | Angularity + warmth. Low=round, soft. High=sharp edges, tighter formation, warmer reds. |
| engagement | Luminosity + density. Low=dim, sparse. High=bright, dense, pulled toward center. |
| congruence | Flow harmony. Low=erratic, elements fighting each other. High=synchronized, unified motion. |
| sentiment | Color temperature. Negative=cool blues/purples. Neutral=silver/white. Positive=warm gold/amber. |

These are CONTINUOUS. Not five states — a living spectrum. Every frame the avatar interpolates toward the latest values.

**Layer 2: Ojaq's mode → behavioral posture (what it does)**

The current mode (hold, reflect, challenge, celebrate, sit) drives the avatar's behavior:

| Mode | Avatar behavior |
|---|---|
| hold | Still. Barely moving. Warm steady glow. Breathing slowly. Present but not reaching. |
| reflect | Gentle mirroring — forms echo the user's recent presence shifts. Subtle pulse. |
| challenge | Slight forward lean. Forms tighten. Subtle angular sharpness. More defined edges. |
| celebrate | Expansion. Brightness peaks. Forms open outward. Momentary bloom. |
| sit | Close together. Dim but warm. Slow synchronized movement. Companionship. |

**Layer 3: Conversation depth → form coherence**

The avatar evolves as the session progresses:

```
Session start (arrival):
  Scattered orbs. Gentle ambient drift. Soft focus.
  Multiple small particles, loosely orbiting. No clear center.
  Colors: muted, neutral.

Exploration:
  Orbs begin finding rhythm. Orbits stabilize.
  A center of gravity emerges. Particles start relating to each other.
  Colors: responding to sentiment.

Something surfaces (deepen):
  Forms tighten. Movement becomes intentional.
  Color shifts — whatever the presence data says.
  The avatar responds to the person's shift before Ojaq speaks.

Breakthrough:
  Everything aligns momentarily. Forms become coherent.
  Bright. Symmetrical. Still — or slow, synchronized movement.
  This is the visual equivalent of "something just clicked."
  Then it relaxes back to a new baseline — but more formed than before.

Processing pain:
  Slow. Warm. Close together. Dim but steady.
  The light doesn't go out — it goes low and holds.

Integration:
  Settled. Cohesive. The form has found its shape for this session.
  Calm movement. Warm light.

Closing:
  Gradual fade. Forms slowly drift apart.
  Not sad — complete. Like an exhale.
```

### Technical approach

Use **Canvas 2D or WebGL** with a particle/orb system:

```javascript
class AvatarRenderer {
  constructor(canvas) {
    this.ctx = canvas.getContext('2d');
    this.orbs = Array.from({ length: 12 }, () => new Orb());
    this.target = { energy: 0, confidence: 0, resistance: 0, engagement: 0, congruence: 0, sentiment: 0 };
    this.current = { ...this.target };  // smoothly interpolated
    this.mode = 'reflect';
    this.depth = 0;  // 0-1, how deep the conversation has gone
  }

  // Called every presence update
  setPresence(presence) {
    this.target = presence;
  }

  setMode(mode) {
    this.mode = mode;
  }

  setDepth(depth) {
    this.depth = Math.min(1, depth);
  }

  // Animation loop — runs every frame
  render() {
    // Smooth interpolation toward target (never snap)
    for (const key of Object.keys(this.target)) {
      this.current[key] += (this.target[key] - this.current[key]) * 0.05;
    }

    const { energy, confidence, resistance, engagement, congruence, sentiment } = this.current;

    // Derive visual parameters
    const speed = map(energy, 0, 100, 0.2, 2.0);
    const cohesion = map(confidence, 0, 100, 0.1, 1.0) * (0.5 + this.depth * 0.5);
    const angularity = map(resistance, 0, 100, 0, 1);
    const brightness = map(engagement, 0, 100, 0.3, 1.0);
    const harmony = map(congruence, 0, 100, 0, 1);
    const warmth = map(sentiment, -1, 1, 0, 1);  // 0=cool blue, 1=warm gold

    // Mode modifiers
    const modeConfig = {
      hold:      { speedMul: 0.3, cohesionMul: 0.8, brightMul: 0.7 },
      reflect:   { speedMul: 1.0, cohesionMul: 1.0, brightMul: 1.0 },
      challenge: { speedMul: 1.2, cohesionMul: 1.3, brightMul: 1.1 },
      celebrate: { speedMul: 1.5, cohesionMul: 0.7, brightMul: 1.5 },
      sit:       { speedMul: 0.4, cohesionMul: 1.2, brightMul: 0.5 },
    }[this.mode] || { speedMul: 1, cohesionMul: 1, brightMul: 1 };

    // Update and draw orbs
    for (const orb of this.orbs) {
      orb.update({
        speed: speed * modeConfig.speedMul,
        cohesion: cohesion * modeConfig.cohesionMul,
        angularity,
        brightness: brightness * modeConfig.brightMul,
        harmony,
        warmth,
        depth: this.depth,
      });
      orb.draw(this.ctx);
    }

    requestAnimationFrame(() => this.render());
  }
}

class Orb {
  constructor() {
    this.x = Math.random() * 400;
    this.y = Math.random() * 400;
    this.vx = 0; this.vy = 0;
    this.radius = 8 + Math.random() * 16;
    this.phase = Math.random() * Math.PI * 2;
  }

  update({ speed, cohesion, angularity, brightness, harmony, warmth, depth }) {
    // Center gravity (stronger with cohesion and depth)
    const cx = 200, cy = 200;
    const dx = cx - this.x, dy = cy - this.y;
    const pull = cohesion * 0.02;
    this.vx += dx * pull;
    this.vy += dy * pull;

    // Orbital motion (harmony drives synchronization)
    this.phase += speed * 0.02;
    const orbitForce = harmony * 0.5;
    this.vx += Math.cos(this.phase) * orbitForce;
    this.vy += Math.sin(this.phase) * orbitForce;

    // Damping
    this.vx *= 0.95;
    this.vy *= 0.95;

    this.x += this.vx * speed;
    this.y += this.vy * speed;

    // Store for drawing
    this._brightness = brightness;
    this._warmth = warmth;
    this._angularity = angularity;
    this._radius = this.radius * (0.8 + depth * 0.4);
  }

  draw(ctx) {
    const r = this._radius;
    const alpha = this._brightness * 0.6;

    // Color from warmth: cool blue → neutral white → warm gold
    const hue = this._warmth * 40 + (1 - this._warmth) * 220;  // 220=blue, 40=gold
    const sat = 40 + this._warmth * 30;

    ctx.beginPath();
    if (this._angularity > 0.6) {
      // Angular: draw polygon instead of circle
      const sides = 5 + Math.floor((1 - this._angularity) * 6);
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const px = this.x + Math.cos(a) * r;
        const py = this.y + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
    } else {
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    }

    ctx.fillStyle = `hsla(${hue}, ${sat}%, 70%, ${alpha})`;
    ctx.fill();

    // Glow
    ctx.shadowBlur = r * 2 * this._brightness;
    ctx.shadowColor = `hsla(${hue}, ${sat}%, 70%, ${alpha * 0.5})`;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}
```

This is a starting point — feel free to improve the visual quality. But the mapping architecture (presence → visual params, mode → modifiers, depth → cohesion) must be preserved.

---

## Session Conductor — the intelligence between presence and model

The app watches presence data and sends `[CMD:]` commands to conduct the session.

### Session phases

Every session moves through: **arrival → exploration → deepening → integration → closing**

The conductor triggers phase transitions based on presence patterns and elapsed time.

```javascript
class SessionConductor {
  constructor(framework, pastSessions) {
    this.framework = framework;
    this.phase = 'arrival';
    this.mode = 'reflect';
    this.startTime = Date.now();
    this.presenceHistory = [];
    this.stage = this.detectStage(pastSessions);
    this.depth = 0;  // 0-1, tracks conversation depth for avatar
  }

  // Called after every presence report
  onPresence(presence, sendCmd) {
    this.presenceHistory.push({ ...presence, t: Date.now() });
    const elapsed = Date.now() - this.startTime;
    const prev = this.presenceHistory[this.presenceHistory.length - 2];

    // ── phase transitions ──
    if (this.phase === 'arrival' && elapsed > this.framework.phaseWeights.arrival.durationMs) {
      this.phase = 'exploration';
      // no command needed — just move on
    }

    if (this.phase === 'exploration' && prev) {
      const congruenceDrop = prev.congruence - presence.congruence > 25;
      const resistanceSpike = presence.resistance > 70 && prev.resistance < 40;
      const energyShift = Math.abs(presence.energy - prev.energy) > 30;
      if (congruenceDrop || resistanceSpike || energyShift) {
        this.phase = 'deepen';
        this.depth = Math.min(1, this.depth + 0.3);
        sendCmd('[CMD:phase:deepen]');
      }
    }

    if (this.phase === 'deepen') {
      const settled = presence.energy < 50 && presence.resistance < 30 && presence.congruence > 60;
      if (settled) this.phase = 'exploration';
    }

    const integrateMs = this.framework.phaseWeights.integrate?.triggerAfterMs;
    if (integrateMs && elapsed > integrateMs && this.phase !== 'integrate' && this.phase !== 'close') {
      this.phase = 'integrate';
      sendCmd('[CMD:phase:integrate]');
    }

    const closeMs = this.framework.phaseWeights.close?.triggerAfterMs;
    if (closeMs && elapsed > closeMs && this.phase !== 'close') {
      this.phase = 'close';
      sendCmd('[CMD:phase:close]');
    }

    // ── mode transitions ──
    const newMode = this.pickMode(presence);
    if (newMode !== this.mode) {
      this.mode = newMode;
      sendCmd(`[CMD:mode:${newMode}]`);
    }

    // ── update depth for avatar ──
    if (presence.engagement > 70 && presence.congruence > 60) {
      this.depth = Math.min(1, this.depth + 0.05);
    }
  }

  pickMode(p) {
    const prefs = this.framework.modePreferences;

    // Sitting with: pain present, defenses down
    if (p.sentiment < -0.5 && p.resistance < 30 && !prefs.avoid?.includes('sit'))
      return 'sit';

    // Holding: high resistance or very low energy
    if (p.resistance > 70 || p.energy < 20)
      return 'hold';

    // Celebrating: breakthrough
    if (p.congruence > 80 && p.engagement > 80 && p.sentiment > 0.3)
      return 'celebrate';

    // Challenging: performing (confident but incongruent)
    const ct = prefs.challengeThreshold;
    if (ct && p.confidence > ct.confidence && p.congruence < ct.congruence && !prefs.avoid?.includes('challenge'))
      return 'challenge';

    return 'reflect';
  }

  detectStage(sessions) {
    const n = sessions?.length || 0;
    if (n <= 2) return 'meeting';
    if (n <= 5) return 'patterning';
    if (n <= 10) return 'working';
    return 'transformative';
  }
}
```

### Framework configs

```javascript
const FRAMEWORKS = {
  coaching: {
    name: 'Coaching',
    prompt: COACHING_PROMPT,
    openingGreeting: "Hey, I'm here. What's been on your mind?",
    phaseWeights: {
      arrival:   { durationMs: 120000 },
      integrate: { triggerAfterMs: 480000 },
      close:     { triggerAfterMs: 600000 },
    },
    modePreferences: {
      dominant: ['reflect', 'challenge'],
      avoid: [],
      challengeThreshold: { confidence: 70, congruence: 40 },
    },
  },
  selfDiscovery: {
    name: 'Self-Discovery',
    prompt: SELF_DISCOVERY_PROMPT,
    openingGreeting: "I'm here. Listening.",
    phaseWeights: {
      arrival:   { durationMs: 120000 },
      integrate: { triggerAfterMs: 540000 },
      close:     { triggerAfterMs: 660000 },
    },
    modePreferences: {
      dominant: ['reflect', 'hold'],
      avoid: ['challenge'],
      challengeThreshold: null,
    },
  },
  therapy: {
    name: 'Therapy',
    prompt: THERAPY_PROMPT,
    openingGreeting: "I'm here with you. Take your time.",
    phaseWeights: {
      arrival:   { durationMs: 180000 },
      integrate: { triggerAfterMs: 540000 },
      close:     { triggerAfterMs: 660000 },
    },
    modePreferences: {
      dominant: ['hold', 'sit', 'reflect'],
      avoid: ['challenge'],
      challengeThreshold: null,
    },
  },
  friend: {
    name: 'Friend',
    prompt: FRIEND_PROMPT,
    openingGreeting: "Hey! What's up?",
    phaseWeights: {
      arrival:   { durationMs: 60000 },
      integrate: { triggerAfterMs: null },
      close:     { triggerAfterMs: null },
    },
    modePreferences: {
      dominant: ['reflect', 'celebrate'],
      avoid: [],
      challengeThreshold: { confidence: 60, congruence: 30 },
    },
  },
};
```

---

## Session Memory

### On session end

Collect all presence reports and transcripts. Summarize via Gemini text API (`generateContent`, not Live):

```
Summarize this session for memory. Extract:
1. Key topics discussed (2-3 bullets)
2. Emotional patterns (what raised energy, triggered resistance, brought congruence)
3. Unresolved threads (what they circled back to, avoided)
4. Breakthroughs (moments of high congruence + engagement)
5. The single most important signal
6. One sentence: where they are right now

Be specific. Use the presence data. Do not generalize.
```

### Storage (localStorage for playground)

```javascript
{
  personId: "default",
  sessions: [{
    id: "s1",
    date: "2026-04-16T16:30:00Z",
    framework: "coaching",
    durationMs: 720000,
    summary: { topics: [], patterns: [], threads: [], breakthroughs: [], keySignal: "", currentState: "" },
    presenceHistory: [],
    transcripts: [],
  }]
}
```

### On session start

Load past sessions → detect relationship stage → build memory layer → prepend to framework prompt.

---

## Presence extraction (client-side, parallel to audio — NEVER blocks)

```javascript
// text parts accumulate during model turn
if (part.text != null) textBuf += part.text;

// on turnComplete, extract presence
if (sc.turnComplete && textBuf) {
  const m = textBuf.match(/```json\s*([\s\S]*?)```/i);
  const raw = m ? m[1] : textBuf.match(/\{[\s\S]*\}/)?.[0];
  if (raw) {
    const obj = JSON.parse(raw);
    if (obj.presence) {
      conductor.onPresence(obj.presence, sendText);
      avatar.setPresence(obj.presence);
      avatar.setMode(conductor.mode);
      avatar.setDepth(conductor.depth);
    }
  }
  textBuf = '';
}
```

### Emotion mapping (for UI badges, not avatar — avatar uses raw values)

```javascript
function mapEmotion({ resistance, energy, engagement, sentiment, confidence }) {
  if (resistance > 80 && sentiment < -0.5)   return { emotion: 'warning',   intensity: resistance };
  if (resistance > 60 || energy > 75)         return { emotion: 'alert',     intensity: Math.max(resistance, energy) };
  if (engagement > 70 && sentiment > 0.3)     return { emotion: 'insight',   intensity: engagement };
  if (confidence < 40 && energy > 30)          return { emotion: 'listening', intensity: energy };
  return { emotion: 'neutral', intensity: 0 };
}
```

---

## What to build — the playground UI

### Layout

```
┌─────────────────────────────────────────────────────┐
│  [Coaching] [Self-Discovery] [Therapy] [Friend]     │  ← framework tabs
├──────────────────────┬──────────────────────────────┤
│                      │  Settings (collapsible)       │
│                      │  ┌──────────────────────┐    │
│      A V A T A R     │  │ Presence thresholds  │    │
│    (canvas, large)   │  │ Voice selection       │    │
│                      │  │ Session timer         │    │
│   ── signal text ──  │  │ Presence sparklines   │    │
│                      │  │ Auto-greeting on/off  │    │
│                      │  └──────────────────────┘    │
├──────────────────────┴──────────────────────────────┤
│  Transcript (collapsible, scrolling)                 │
│  [user] I've been feeling stuck...                   │
│  [ojaq] Something tightened when you said that.      │
│  ● alert 72  "energy rose but congruence dropped"    │
├─────────────────────────────────────────────────────┤
│  [Start/Stop]  [text input for CMD]  [Focus▾] [Wrap]│
└─────────────────────────────────────────────────────┘
```

### Settings panel

- **Presence thresholds** — sliders for emotion mapping rules
- **Presence sparklines** — last 20 turns, one line per dimension
- **Voice selection** — dropdown
- **Session timer** — elapsed time
- **Auto-greeting** — send `[CMD:start]` automatically on connect
- **Transcript toggle** — show/hide
- **Phase indicator** — current phase + mode displayed
- All settings persist to localStorage

### Quick command buttons

- Focus: Career, Relationships, Health, Growth
- Wrap Up
- These send `[CMD:focus:career]`, `[CMD:wrap-up]`, etc.

### Session history (sidebar or modal)

- Past sessions: date, framework, duration, key signal
- Click to view: summary + presence graph
- "Continue" button: starts new session with memory layer

---

## File structure

```
ojaq-proxy/
  src/
    server.py              — FastAPI: /token, /test, /ws, /playground
    gemini_live.py         — proxy path handler
  playground/
    index.html             — single page app
    style.css
    app.js                 — main orchestrator
    gemini.js              — WebSocket connection (COPY from test_browser/index.html)
    audio.js               — AudioWorklet + playback (COPY from test_browser/index.html)
    presence.js            — extraction + emotion mapping + history
    avatar.js              — canvas orb system driven by presence
    conductor.js           — SessionConductor (phase/mode transitions)
    frameworks.js          — framework definitions + prompt assembly
    memory.js              — session storage + summarization + memory layer
    transcript.js          — rolling transcript UI
    settings.js            — settings panel + localStorage
  test_browser/
    index.html             — minimal test (keep as-is)
```

Add to `server.py`:
```python
from fastapi.staticfiles import StaticFiles
PLAYGROUND = Path(__file__).resolve().parent.parent / "playground"
app.mount("/playground", StaticFiles(directory=PLAYGROUND, html=True), name="playground")
```

---

## Constraints

1. **No build step** — ES modules or single file. `/playground` just works.
2. **Copy Gemini connection from `test_browser/index.html`** — it's battle-tested.
3. **Presence NEVER blocks audio** — parallel streams, always.
4. **System prompts are verbatim** — use the exact text from this document.
5. **The avatar must feel alive** — continuous motion, smooth interpolation, never static.
6. **The conductor sends commands, the model responds naturally** — the model doesn't know about phases or modes as a system. It just follows the `[CMD:]` instructions.
7. **Settings persist to localStorage.**

## Start here

1. Copy connection + audio from `test_browser/index.html` → `gemini.js` + `audio.js`
2. Build the avatar canvas (orb particle system)
3. Wire presence → avatar + conductor
4. Add framework tabs (swap prompt, reconnect)
5. Add transcript panel
6. Add settings + sparklines
7. Add session memory
8. Polish

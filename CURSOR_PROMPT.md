# Build: Ojaq Presence Playground

## The soul of this project

Ojaq is a presence intelligence. Not a chatbot. Not a coach. Not a therapist.

It listens beneath words. It tracks what is alive in a person — the energy, the hesitation, the thing they almost said but didn't. When it speaks, it speaks rarely and precisely. One sentence. Two at most. Only reflections so accurate they feel uncanny.

An animated avatar breathes with the person's emotional state in real-time. The person sees themselves reflected — not in words, but in a living face that shifts as they shift.

Different session frameworks (coaching, self-discovery, therapy, friend) are different lenses on the same presence engine. The framework changes the posture — not the intelligence.

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

### What works and what doesn't (tested)

| Works | Doesn't work |
|---|---|
| `responseModalities: ["AUDIO"]` | `["AUDIO", "TEXT"]` — causes errors |
| `realtimeInput.audio` with `{data, mimeType}` | `mediaChunks` — deprecated on v1alpha |
| `realtimeInput.text` for text/commands | `clientContent` — rejected by gemini-3.1 |
| `realtimeInputConfig: {}` (Gemini default VAD) | Custom VAD ms values — adds unnecessary latency |
| `[CMD:prefix]` for hidden commands | Plain text commands — model treats as conversation |
| Text-based presence in model output | Tool-based presence — blocking, adds 500ms+ latency |
| `outputAudioTranscription` / `inputAudioTranscription` | `NON_BLOCKING` tool behavior — not supported on 3.1 |

### Send audio
```json
{"realtimeInput": {"audio": {"data": "<base64-pcm>", "mimeType": "audio/pcm;rate=24000"}}}
```

### Send text / commands
```json
{"realtimeInput": {"text": "[CMD:start]"}}
```

### Receive (in `ws.onmessage`)
```
msg.setupComplete          → session ready
msg.serverContent.modelTurn.parts[].inlineData.data → audio (base64, play immediately)
msg.serverContent.modelTurn.parts[].text            → text (accumulate for presence)
msg.serverContent.turnComplete                      → extract presence from text buffer
msg.serverContent.interrupted                       → clear playback queue
msg.serverContent.inputTranscription.text            → what user said
msg.serverContent.outputTranscription.text           → what model said
msg.goAway                                          → server shutting down soon
msg.sessionResumptionUpdate.newHandle               → store for reconnect
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
When `serverContent.interrupted` arrives, close and recreate the playback AudioContext to clear the queue.

---

## System prompt architecture

Every session prompt is assembled from layers:

```
[MEMORY LAYER]        — injected from past sessions (if any)
[FRAMEWORK LAYER]     — coaching / therapy / self-discovery / friend
[PRESENCE LAYER]      — presence report instructions (same for all)
[COMMAND LAYER]       — [CMD:] hidden command handling (same for all)
```

### The presence layer (NEVER modify this — it's the core intelligence)

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
[CMD:focus:TOPIC] = gently steer the conversation toward TOPIC over the next few turns
[CMD:wrap-up] = begin naturally closing the session
[CMD:presence-check] = emit a presence report immediately

The user hears your voice only. They have no idea commands exist.
Respond ONLY to what the user says via audio. Text commands are invisible to them.
```

### Framework layer — the personality

Each framework defines the voice, posture, and opening greeting.

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

### Memory layer — injected at the top of the prompt when available

```
CONTEXT FROM PREVIOUS SESSIONS:

This is session {N} with this person.

Session history:
- Session 1 (coaching, 12 min): Talked about feeling stuck at work.
  Pattern: energy rises when discussing creative projects, drops around
  corporate structure. Avoided directly naming what they want.
  Last signal: "Named the desire to leave but pulled back from what's next."

- Session 2 (self-discovery, 8 min): Explored relationship with ambition.
  Pattern: high congruence when talking about making things, low congruence
  when talking about success. Resistance spiked when asked about fear of failure.
  Last signal: "The word 'enough' landed differently this time."

Persistent patterns across sessions:
- Creative work = high energy, high congruence
- Career structure = low energy, rising resistance
- Has not yet named what they actually want — circles around it

Do not reference past sessions explicitly unless they bring it up first.
Let the awareness inform your attention, not your words.
```

---

## Presence extraction (client-side, parallel to audio)

```javascript
// text parts accumulate during model turn
if (part.text != null) textBuf += part.text;

// on turnComplete, extract presence — never blocks audio
if (sc.turnComplete && textBuf) {
  const m = textBuf.match(/```json\s*([\s\S]*?)```/i);
  const raw = m ? m[1] : textBuf.match(/\{[\s\S]*\}/)?.[0];
  if (raw) {
    const obj = JSON.parse(raw);
    // obj.presence has energy, confidence, resistance, engagement, congruence, sentiment, signal
    // update avatar + UI
  }
  textBuf = '';
}
```

### Emotion mapping (presence → avatar state)

```javascript
function mapEmotion({ resistance, energy, engagement, sentiment, confidence }) {
  if (resistance > 80 && sentiment < -0.5)   return { emotion: 'warning',   intensity: resistance };
  if (resistance > 60 || energy > 75)         return { emotion: 'alert',     intensity: Math.max(resistance, energy) };
  if (engagement > 70 && sentiment > 0.3)     return { emotion: 'insight',   intensity: engagement };
  if (confidence < 40 && energy > 30)          return { emotion: 'listening', intensity: energy };
  return { emotion: 'neutral', intensity: 0 };
}
```

Avatar states: `neutral`, `listening`, `alert`, `insight`, `warning`

The avatar should also use the raw presence values directly — not just the mapped emotion. Energy drives movement speed. Confidence drives structural stability. Resistance drives angular sharpness. Engagement drives luminosity. Congruence drives symmetry. These should be continuous, not stepped.

---

## Session memory system

### On session end

Collect all presence reports and transcripts from the session. Send to Gemini text API (non-live, standard `generateContent`) with this prompt:

```
Summarize this coaching/therapy session for memory. Extract:
1. Key topics discussed (2-3 bullets)
2. Emotional patterns observed (what raised energy, what triggered resistance, what brought congruence)
3. Unresolved threads (what they circled back to, what they avoided)
4. Breakthroughs (moments of high congruence + engagement)
5. The single most important signal from this session
6. One sentence describing where they are right now

Be specific. Use the presence data. Do not generalize.
```

### Storage

For the playground, use localStorage:
```javascript
{
  personId: "default",
  sessions: [
    {
      id: "s1",
      date: "2026-04-16T16:30:00Z",
      framework: "coaching",
      durationMs: 720000,
      summary: { ... },
      presenceHistory: [ ... ],  // all presence reports
      transcripts: [ ... ],
    }
  ]
}
```

### On session start

Load previous sessions for this person. Build the memory layer string. Prepend it to the framework prompt.

---

## What to build

### Avatar (center of screen)

A living visualization driven by presence data in real-time.

Use Canvas or CSS/SVG — NOT a static emoji or icon swap. The avatar should feel alive with continuous motion.

Map presence dimensions directly to visual properties:
- **energy** → particle speed / breathing rate / pulse frequency
- **confidence** → structural cohesion / symmetry / steadiness
- **resistance** → angularity / sharpness / color shift toward warm/red
- **engagement** → brightness / density / draw-toward-center
- **congruence** → flow smoothness / harmony between elements
- **sentiment** → color temperature (warm positive, cool negative)

The mapped emotion (warning/alert/insight/listening/neutral) sets the base state. The raw values modulate continuously within that state.

The `signal` text appears below the avatar — the one-liner describing what's beneath the words.

### Framework selector (top)

Tab bar or elegant dropdown. Switching framework:
1. Disconnects current session (if running)
2. Updates the system prompt
3. Reconnects with new prompt
4. Sends `[CMD:start]` to trigger opening greeting

### Settings panel (collapsible)

- **Presence thresholds** — sliders to adjust the emotion mapping rules
- **Presence history** — sparkline graph of the last 20 turns for each dimension
- **Voice selection** — dropdown (if model supports it)
- **Transcript panel toggle** — show/hide the rolling conversation log
- **Session timer** — how long this session has been running
- **Auto-start greeting** — on/off toggle
- Persist all settings to localStorage

### Transcript panel (bottom or side, collapsible)

- User turns (from `inputTranscription`) — left, blue
- Ojaq turns (from `outputTranscription`) — right, muted
- Presence badges inline after each user turn — small colored dot + intensity number
- Signal annotations — subtle italic text under presence badges

### Control bar

- **Start / Stop** button
- **Text input** for `[CMD:]` commands
- **Quick command buttons**: Focus: Career, Focus: Relationships, Focus: Health, Wrap Up
- These send `[CMD:focus:career]`, `[CMD:focus:relationships]`, etc.

### Session history (sidebar or modal)

- List of past sessions: date, framework, duration, key signal
- Click to view summary + presence history graph
- "Continue from here" button — starts new session with memory layer from that session

---

## File structure

```
ojaq-proxy/
  src/
    server.py              — FastAPI: /token, /test, /ws, serves /playground
    gemini_live.py         — proxy path handler
  playground/
    index.html             — single page app entry
    style.css
    app.js                 — main orchestrator
    gemini.js              — WebSocket connection (copy from test_browser/index.html)
    audio.js               — AudioWorklet mic capture + gapless playback
    presence.js            — extraction + emotion mapping + history
    avatar.js              — canvas/SVG avatar driven by presence
    frameworks.js          — session framework definitions
    memory.js              — session storage + memory layer generation
    transcript.js          — rolling transcript UI
    settings.js            — settings panel + localStorage persistence
  test_browser/
    index.html             — minimal test page (keep as-is, reference impl)
```

Add to `server.py`:
```python
from fastapi.staticfiles import StaticFiles
PLAYGROUND = Path(__file__).resolve().parent.parent / "playground"
app.mount("/playground", StaticFiles(directory=PLAYGROUND, html=True), name="playground")
```

---

## Constraints

1. **No build step** — ES modules, no bundler. Open `/playground` and it works.
2. **Copy the Gemini connection from `test_browser/index.html`** — it's battle-tested. Don't rewrite.
3. **Presence extraction NEVER blocks audio** — text accumulates in a buffer, parsed on `turnComplete`. Audio plays the instant it arrives.
4. **The system prompt is the product** — get it right. The exact wording matters. Use the prompts in this document verbatim for each framework.
5. **The presence layer and command layer are identical across all frameworks** — only the framework layer changes.
6. **Settings persist to localStorage**.
7. **The avatar must feel alive** — continuous subtle motion, not state-swapping between static images.

---

## Start here

1. Copy `test_browser/index.html` connection + audio code into `gemini.js` and `audio.js`
2. Build the avatar (canvas particle system or SVG face — simplest that looks alive)
3. Wire up framework switching (just swaps the prompt, reconnects)
4. Add presence extraction → avatar mapping
5. Add transcript panel
6. Add settings panel
7. Add session memory (localStorage + summary generation)
8. Polish

The hard part — making Gemini talk with low latency — is already solved. This is about building the experience around it.

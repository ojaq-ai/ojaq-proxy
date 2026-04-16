# Session Framework Architecture

## The three layers of time

```
Within a session:    Opening → Exploration → Deepening → Integration → Closing
Across sessions:     Exploratory → Patterning → Working → Transformative
Within a moment:     The framework can shift posture based on what's alive right now
```

All three happen simultaneously. A single session has phases. The relationship has seasons. And in any given moment, the posture shifts fluidly.

---

## 1. Session Arc — phases within a single session

Every session moves through phases. The app orchestrates this by watching presence data and sending `[CMD:phase:NAME]` commands. The model doesn't track phases — it responds to commands naturally.

### Phases

**Arrival** (0-2 min)
- Opening greeting
- Settling in
- The model reads the room — how did they arrive? Rushed? Hesitant? Eager?
- Presence data starts accumulating
- Command: `[CMD:start]`

**Exploration** (2-8 min)  
- Open space — the person talks about whatever is alive
- Model listens more than it speaks
- Presence intelligence is tracking: where does energy rise? What triggers resistance?
- No steering yet — let them find their own territory
- This is the default phase after arrival

**Deepening** (triggered by presence, not time)
- Activated when presence shows something significant:
  - Congruence drops sharply (they said something that didn't land true)
  - Resistance spikes then drops (something broke through)
  - Energy shifts suddenly (something just got real)
- Model leans in — reflects what it noticed
- "Something shifted just now."
- "You said that differently than everything else."
- Command: `[CMD:phase:deepen]`

**Integration** (near end)
- What emerged? What's different now than when they arrived?
- Model names the thread — the thing that ran through the whole conversation
- Not a summary. A reflection on the arc.
- "You came in talking about work but what was underneath was permission."
- Command: `[CMD:phase:integrate]`

**Closing** (last 1-2 min)
- Ritual ending
- One takeaway — not advice, an observation they can carry
- "What's staying with you from this?"
- Gentle goodbye
- Command: `[CMD:phase:close]`

### Phase transition logic (runs in the app, not the model)

```javascript
// The app watches presence and decides phase transitions
function checkPhaseTransition(presenceHistory, currentPhase, sessionDurationMs) {
  const last = presenceHistory[presenceHistory.length - 1];
  const prev = presenceHistory[presenceHistory.length - 2];
  
  if (currentPhase === 'exploration') {
    // Deepen when something significant surfaces
    if (prev && last) {
      const congruenceDrop = prev.congruence - last.congruence > 25;
      const resistanceSpike = last.resistance > 70 && prev.resistance < 40;
      const energyShift = Math.abs(last.energy - prev.energy) > 30;
      if (congruenceDrop || resistanceSpike || energyShift) {
        return 'deepen';
      }
    }
  }
  
  if (currentPhase === 'deepen') {
    // Return to exploration after deepening settles
    const settled = last.energy < 50 && last.resistance < 30 && last.congruence > 60;
    if (settled) return 'exploration';
  }
  
  // Time-based transitions
  if (sessionDurationMs > 8 * 60 * 1000 && currentPhase !== 'integrate' && currentPhase !== 'close') {
    return 'integrate';
  }
  if (sessionDurationMs > 10 * 60 * 1000 && currentPhase !== 'close') {
    return 'close';
  }
  
  return currentPhase; // no change
}
```

---

## 2. Session Modes — different postures the model can take

Modes are not frameworks. A framework (coaching, therapy, etc.) defines the overall approach. A mode is a momentary posture within that framework.

### Modes

**Holding** — maximum space, minimum intervention
- Triggered when: resistance is high, energy is low, person is processing
- Model behavior: silence or one-word acknowledgments. "I hear you." "Mmm."
- Command: `[CMD:mode:hold]`

**Reflecting** — mirror what's happening
- Triggered when: engagement is high, person is flowing
- Model behavior: name what it notices without steering
- Command: `[CMD:mode:reflect]`

**Challenging** — gentle push
- Triggered when: congruence is low but confidence is high (they're performing, not being real)
- Model behavior: "That sounded rehearsed." "Is that what you actually think?"
- Command: `[CMD:mode:challenge]`

**Celebrating** — acknowledge what just happened
- Triggered when: congruence spike + engagement spike (breakthrough moment)
- Model behavior: "That's the first time you said that out loud." "Something just clicked."
- Command: `[CMD:mode:celebrate]`

**Sitting with** — companionship in difficulty
- Triggered when: sentiment is deeply negative, resistance is dropping (they're letting pain in)
- Model behavior: presence without fixing. "I'm here." Silence.
- Command: `[CMD:mode:sit]`

### Mode transition logic

```javascript
function checkModeTransition(presence) {
  const { energy, confidence, resistance, engagement, congruence, sentiment } = presence;
  
  // Holding: high resistance or very low energy — give space
  if (resistance > 70 || energy < 20) return 'hold';
  
  // Sitting with: pain is present and defenses are down
  if (sentiment < -0.5 && resistance < 30) return 'sit';
  
  // Celebrating: breakthrough — congruence and engagement both high
  if (congruence > 80 && engagement > 80 && sentiment > 0.3) return 'celebrate';
  
  // Challenging: performing — confident but incongruent
  if (confidence > 70 && congruence < 40) return 'challenge';
  
  // Reflecting: flowing — engaged and present
  if (engagement > 60) return 'reflect';
  
  return 'reflect'; // default
}
```

---

## 3. Framework Definitions — the overall relationship posture

Each framework uses the same phases and modes but weights them differently.

### Coaching
- Phases: All five, evenly weighted
- Dominant modes: reflecting, challenging
- Unique behavior: asks questions, seeks next steps
- When to challenge: low congruence + high confidence
- When to deepen: energy shift around goals/ambitions

### Self-Discovery
- Phases: Longer exploration, shorter integration
- Dominant modes: reflecting, holding
- Unique behavior: never asks questions, only names observations
- When to challenge: never directly — only mirrors
- When to deepen: any significant congruence shift

### Therapy
- Phases: Extended arrival, gentle transitions
- Dominant modes: holding, sitting with, reflecting
- Unique behavior: validates before everything, never pushes
- When to challenge: very rarely, very gently, only patterns
- When to deepen: only when the person initiates, never the model

### Friend
- Phases: No formal structure — organic
- Dominant modes: reflecting, celebrating
- Unique behavior: casual, reactive, can joke, can be direct
- When to challenge: naturally, like a friend would — "dude, you keep saying that"
- When to deepen: follows the person's lead, matches their energy

### Framework config structure

```javascript
const FRAMEWORKS = {
  coaching: {
    name: 'Coaching',
    prompt: `...`,  // full framework prompt text
    openingGreeting: "Hey, I'm here. What's been on your mind?",
    phaseWeights: {
      arrival: { durationMs: 120000, autoTransition: true },
      exploration: { durationMs: 360000, autoTransition: false },
      deepen: { triggerThreshold: 0.6 },  // sensitivity to presence shifts
      integrate: { triggerAfterMs: 480000 },
      close: { triggerAfterMs: 600000 },
    },
    modePreferences: {
      dominant: ['reflect', 'challenge'],
      avoid: [],
      challengeThreshold: { confidence: 70, congruence: 40 },
    },
  },
  selfDiscovery: {
    name: 'Self-Discovery',
    prompt: `...`,
    openingGreeting: "I'm here. Listening.",
    phaseWeights: {
      arrival: { durationMs: 120000, autoTransition: true },
      exploration: { durationMs: 480000, autoTransition: false },
      deepen: { triggerThreshold: 0.4 },  // more sensitive
      integrate: { triggerAfterMs: 540000 },
      close: { triggerAfterMs: 660000 },
    },
    modePreferences: {
      dominant: ['reflect', 'hold'],
      avoid: ['challenge'],
      challengeThreshold: null,  // never challenge
    },
  },
  therapy: {
    name: 'Therapy',
    prompt: `...`,
    openingGreeting: "I'm here with you. Take your time.",
    phaseWeights: {
      arrival: { durationMs: 180000, autoTransition: true },  // longer settling
      exploration: { durationMs: 420000, autoTransition: false },
      deepen: { triggerThreshold: 0.8 },  // high threshold — only deepen when clear
      integrate: { triggerAfterMs: 540000 },
      close: { triggerAfterMs: 660000 },
    },
    modePreferences: {
      dominant: ['hold', 'sit', 'reflect'],
      avoid: ['challenge'],
      challengeThreshold: null,
    },
  },
  friend: {
    name: 'Friend',
    prompt: `...`,
    openingGreeting: "Hey! What's up?",
    phaseWeights: {
      arrival: { durationMs: 60000, autoTransition: true },  // quick
      exploration: { durationMs: null, autoTransition: false },  // no time limit
      deepen: { triggerThreshold: 0.7 },
      integrate: { triggerAfterMs: null },  // no auto-integrate
      close: { triggerAfterMs: null },  // no auto-close
    },
    modePreferences: {
      dominant: ['reflect', 'celebrate'],
      avoid: [],
      challengeThreshold: { confidence: 60, congruence: 30 },  // friends call you out easier
    },
  },
};
```

---

## 4. Cross-Session Evolution — the relationship arc

Sessions aren't isolated. The relationship between Ojaq and the person evolves.

### Relationship stages

**Stage 1: Meeting** (sessions 1-2)
- The system knows nothing about this person
- Focus: listen broadly, establish safety, learn their landscape
- Memory layer: "This is a new relationship. Listen more than you speak. Learn their world."
- Presence patterns start accumulating

**Stage 2: Patterning** (sessions 3-5)
- Recurring themes are emerging
- The system starts to see what matters, what's avoided, what's alive
- Memory layer includes: "Patterns observed: X rises when Y, Z is consistently avoided"
- The model can now reference threads: "This reminds me of what you said about..."

**Stage 3: Working** (sessions 6-10)
- Trust is established. The person goes deeper faster.
- The model can be more direct because safety is proven
- Memory layer includes: "This person trusts you. You can name harder things now."
- Challenge threshold lowers. Deepening threshold lowers.

**Stage 4: Transformative** (sessions 10+)
- The relationship itself is a resource
- The model can name the arc: "You arrived very differently today than you used to."
- Memory layer includes the full evolution — who they were, who they're becoming
- The system can hold contradictions and track growth over time

### Stage detection

```javascript
function detectRelationshipStage(sessions) {
  const count = sessions.length;
  if (count <= 2) return 'meeting';
  if (count <= 5) return 'patterning';
  if (count <= 10) return 'working';
  return 'transformative';
}

// Adjusts framework behavior based on stage
function stageModifiers(stage) {
  return {
    meeting:        { challengeMultiplier: 0.3, deepenMultiplier: 0.5, silenceComfort: 0.5 },
    patterning:     { challengeMultiplier: 0.6, deepenMultiplier: 0.8, silenceComfort: 0.7 },
    working:        { challengeMultiplier: 1.0, deepenMultiplier: 1.0, silenceComfort: 0.9 },
    transformative: { challengeMultiplier: 1.2, deepenMultiplier: 1.2, silenceComfort: 1.0 },
  }[stage];
}
```

---

## 5. Mid-Session Framework Transitions

The framework can shift mid-session when the conversation calls for it.

Example: starts as "Friend" → something heavy surfaces → shifts to "Therapy" posture → person processes it → shifts back to "Friend"

The app detects this through presence patterns:

```javascript
function checkFrameworkShift(currentFramework, presence, presenceHistory) {
  // Friend → Therapy: something painful emerged
  if (currentFramework === 'friend') {
    if (presence.sentiment < -0.6 && presence.resistance < 30 && presence.energy < 30) {
      return 'therapy';  // shift to holding space
    }
  }
  
  // Therapy → Coaching: person found clarity, ready for action
  if (currentFramework === 'therapy') {
    if (presence.congruence > 75 && presence.confidence > 60 && presence.energy > 60) {
      return 'coaching';  // they're ready to move forward
    }
  }
  
  // Coaching → Self-Discovery: person is in their head, needs to feel instead
  if (currentFramework === 'coaching') {
    if (presence.confidence > 70 && presence.congruence < 35) {
      return 'selfDiscovery';  // stop planning, start noticing
    }
  }
  
  return currentFramework; // no shift
}
```

Since we can't change the system prompt mid-session, framework shifts are expressed through `[CMD:mode:]` commands that change the MODEL'S POSTURE within the existing prompt. The system prompt must include ALL mode behaviors so it can respond to any `[CMD:mode:]` command at any time.

---

## 6. Ritual Elements

Rituals create containers. They mark transitions and make the experience feel intentional.

### Opening ritual
1. Greeting (framework-specific)
2. Arrival check: "How are you arriving right now?" (coaching/therapy) or just presence observation (self-discovery)
3. Brief silence — let them settle
4. Implemented via: `[CMD:start]` → greeting, then model waits

### Deepening ritual
1. Pause — when something significant surfaces, create space
2. Body awareness: "Notice where you feel that" (therapy) or "That landed somewhere" (self-discovery)
3. Implemented via: `[CMD:mode:hold]` → brief silence → `[CMD:phase:deepen]`

### Integration ritual  
1. Thread naming: model names the through-line of the session
2. Shift question: "What feels different now than when we started?"
3. Implemented via: `[CMD:phase:integrate]`

### Closing ritual
1. Takeaway: one observation they can carry — not advice
2. Acknowledgment: "Thank you for being here"
3. Implemented via: `[CMD:phase:close]`

### These are encoded in the system prompt:

```
SESSION PHASES:

You move through phases. The app will signal phase transitions via [CMD:phase:NAME].

[CMD:phase:deepen]
Something significant just surfaced in the presence data. Lean in.
Acknowledge what shifted. Create space around it. Don't rush past it.
If appropriate: "Notice where you feel that."

[CMD:phase:integrate]
The session is approaching its natural end. Name the thread — the thing
that ran through the conversation. Not a summary. A reflection on the arc.
Then ask: "What's staying with you from this?"

[CMD:phase:close]
Time to close. Offer one observation they can carry — not advice.
Say goodbye warmly. Match the tone of the session.
```

---

## 7. The Session Conductor

The app is the conductor. It runs a loop:

```javascript
class SessionConductor {
  constructor(framework, memoryLayer, presenceHistory) {
    this.framework = framework;
    this.memory = memoryLayer;
    this.phase = 'arrival';
    this.mode = 'reflect';
    this.startTime = Date.now();
    this.presenceHistory = presenceHistory || [];
    this.stage = detectRelationshipStage(pastSessions);
    this.stageModifiers = stageModifiers(this.stage);
  }
  
  // Called after every presence report
  onPresence(presence) {
    this.presenceHistory.push({ ...presence, timestamp: Date.now() });
    
    const elapsed = Date.now() - this.startTime;
    
    // Check phase transition
    const newPhase = checkPhaseTransition(
      this.presenceHistory, this.phase, elapsed, this.framework.phaseWeights
    );
    if (newPhase !== this.phase) {
      this.phase = newPhase;
      sendText(`[CMD:phase:${newPhase}]`);
    }
    
    // Check mode transition
    const newMode = checkModeTransition(presence, this.framework.modePreferences, this.stageModifiers);
    if (newMode !== this.mode) {
      this.mode = newMode;
      sendText(`[CMD:mode:${newMode}]`);
    }
    
    // Check framework shift (mid-session)
    const newFramework = checkFrameworkShift(this.framework.name, presence, this.presenceHistory);
    if (newFramework !== this.framework.name) {
      // Can't change prompt — but shift posture via mode commands
      this.framework = FRAMEWORKS[newFramework];
      sendText(`[CMD:mode:${this.framework.modePreferences.dominant[0]}]`);
    }
  }
}
```

This is the intelligence layer that sits between presence data and the model. It watches. It decides. It conducts.

---

## Summary: the full prompt needs to contain

1. **Identity** — who Ojaq is in this framework
2. **All modes** — hold, reflect, challenge, celebrate, sit — so model can respond to any `[CMD:mode:]`
3. **All phases** — arrival, exploration, deepen, integrate, close — so model can respond to any `[CMD:phase:]`
4. **Presence report format** — the JSON block specification
5. **Command system** — `[CMD:]` prefix handling
6. **Memory context** — prepended from past sessions when available
7. **Relationship stage awareness** — "This is session N. You can be more/less direct."

The model receives one comprehensive prompt. The app conducts the experience by sending commands at the right moments based on presence intelligence.

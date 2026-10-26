'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CueAutoAnswer = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const AV_AND_LOGISTICS_RE = /\b(can you hear me|hear me okay|hear me alright|can you see my screen|see my screen|is my mic working|am i audible|am i on mute|you are on mute|you'?re on mute|let me share my screen|sharing my screen)\b/i;

  const GREETINGS_RE = /^(hi|hello|hey|good morning|good afternoon|good evening|how are you( doing| today)?|how'?s it going|how is it going|how was your weekend|how is your day( going)?|nice to meet you|great to meet you|pleasure to meet you|thanks for (joining|taking the time|coming)|where are you (calling|joining|based|located)( from)?|how is the weather)\b/i;

  const RHETORICAL_CHECKIN_RE = /^(does that make sense|make sense|makes sense|you know what i mean|right|okay|ok|all right|alright|sounds good|got it|(are you )?ready( to (get started|begin|start))?|shall we (begin|get started|start|jump in)|do you have a minute|any questions before we (start|begin)|let'?s get started|let us get started)$/i;

  const DANGLING_WORDS_RE = /\b(and|or|but|so|because|since|although|though|if|when|while|where|which|that|whether|like|such as|for example|for instance|in terms of|with|without|to|from|for|about|into|onto|between|regarding|concerning|as well as|including)\s*$/i;

  const LEADING_FILLER_RE = /^(\s*(um|uh|er|ah|so|okay|ok|alright|all right|well|now|and|right)[,.\s]+)+/i;

  const INTERVIEW_PROMPT_RE = /(\btell me about\b|\bwalk me through\b|\bdescribe a\b|\bgive me an example\b|\bshare an example\b|\btalk about a time\b|\bexplain how\b|\bexplain what\b|\bexplain why\b|\bwhat (was|were|is|are|would|did|do)\b|\bhow (did|do|would|can|could|should)\b|\bwhy (did|do|would|should|are|is)\b|\bwhen (did|was|have)\b|\bwhere (did|do|would)\b|\bwho (was|is|did)\b|\bwhich\b.*\b(prefer|choose|pick|best|better)\b|\bcan you (tell|describe|explain|walk|share|give|talk)\b|\bcould you (tell|describe|explain|walk|share|give|talk)\b|\bwould you (say|rather|prefer|describe|explain)\b|\bhave you ever\b)/i;

  const QUESTION_STARTER_RE = /^(what|how|why|when|where|who|which|tell|describe|explain|walk|give|share|can|could|would|should|have|has|did|do|does|is|are|was|were)\b/i;

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanLeadingFillers(text) {
    return String(text || '').trim().replace(LEADING_FILLER_RE, '').trim();
  }

  function extractFinalSentence(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const parts = raw
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
  }

  function isSmallTalkOrLogistics(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const norm = normalizeText(raw);
    if (!norm) return false;

    if (AV_AND_LOGISTICS_RE.test(norm)) return true;
    if (RHETORICAL_CHECKIN_RE.test(norm)) return true;

    const strippedFiller = normalizeText(cleanLeadingFillers(raw));
    if (strippedFiller && RHETORICAL_CHECKIN_RE.test(strippedFiller)) return true;

    const words = norm.split(/\s+/).filter(Boolean);
    if (GREETINGS_RE.test(norm) && words.length <= 10 && !INTERVIEW_PROMPT_RE.test(norm)) {
      return true;
    }
    if (strippedFiller && GREETINGS_RE.test(strippedFiller) && words.length <= 10 && !INTERVIEW_PROMPT_RE.test(strippedFiller)) {
      return true;
    }

    return false;
  }

  function hasDanglingEnding(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    if (/[,…\-—]\s*$/.test(trimmed) || /\.\.\.\s*$/.test(trimmed)) return true;
    if (/\?\s*$/.test(trimmed)) return false;

    const withoutTrailingPeriod = trimmed.replace(/[.!]+\s*$/, '').trim();
    return DANGLING_WORDS_RE.test(withoutTrailingPeriod);
  }

  function stripDanglingEnding(text) {
    let cur = String(text || '').trim();
    cur = cur.replace(/[,…\-—.]+\s*$/, '').trim();
    cur = cur.replace(DANGLING_WORDS_RE, '').trim();
    cur = cur.replace(/[,…\-—.]+\s*$/, '').trim();
    return cur;
  }

  function evaluateQuestionCandidate(text) {
    const raw = String(text || '').trim();
    const cleaned = cleanLeadingFillers(raw);
    const words = cleaned.split(/\s+/).filter(Boolean);

    if (!cleaned || cleaned.length < 10 || words.length < 3) {
      return { decision: 'ignore', confidence: 'low', reason: 'too_short', settleMs: 0 };
    }

    const lastSentence = cleanLeadingFillers(extractFinalSentence(cleaned));
    if (isSmallTalkOrLogistics(raw) || isSmallTalkOrLogistics(cleaned) || (lastSentence && isSmallTalkOrLogistics(lastSentence))) {
      return { decision: 'ignore', confidence: 'low', reason: 'small_talk', settleMs: 0 };
    }

    if (hasDanglingEnding(cleaned)) {
      return { decision: 'incomplete', confidence: 'accumulating', reason: 'dangling_ending', settleMs: 3200 };
    }

    if (/\?\s*$/.test(cleaned) && words.length >= 4) {
      return { decision: 'question', confidence: 'high', reason: 'explicit_question', settleMs: 1400 };
    }

    const lastWords = lastSentence ? lastSentence.split(/\s+/).filter(Boolean) : words;
    if (words.length >= 5) {
      if (INTERVIEW_PROMPT_RE.test(cleaned) || (lastSentence && INTERVIEW_PROMPT_RE.test(lastSentence))) {
        return { decision: 'question', confidence: 'medium', reason: 'interview_prompt', settleMs: 2000 };
      }
      if (QUESTION_STARTER_RE.test(cleaned) || (lastWords.length >= 5 && QUESTION_STARTER_RE.test(lastSentence))) {
        return { decision: 'question', confidence: 'medium', reason: 'interview_prompt', settleMs: 2000 };
      }
    }

    return { decision: 'ignore', confidence: 'low', reason: 'statement', settleMs: 0 };
  }

  function createAutoAnswerController(options = {}) {
    const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    const onTriggerAnswer = typeof options.onTriggerAnswer === 'function' ? options.onTriggerAnswer : () => {};
    const onAbortAnswer = typeof options.onAbortAnswer === 'function' ? options.onAbortAnswer : () => {};
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (id) => clearTimeout(id);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const cooldownMs = typeof options.cooldownMs === 'number' ? options.cooldownMs : 1800;

    let state = 'off';
    let enabled = false;
    let capturing = false;
    let candidateText = '';
    let lastAnsweredText = '';
    let lastTriggerAt = 0;
    let lastInterimAt = 0;
    let themSpeaking = false;
    let youSpeaking = false;
    let youSpokeSinceLastTrigger = false;
    let pendingContinuation = false;
    let receivedFirstToken = false;

    let settleTimer = null;
    let incompleteTimer = null;
    let cooldownTimer = null;
    let vadFallbackTimer = null;

    function clearSettleTimer() {
      if (settleTimer !== null) {
        clearTimer(settleTimer);
        settleTimer = null;
      }
    }

    function clearIncompleteTimer() {
      if (incompleteTimer !== null) {
        clearTimer(incompleteTimer);
        incompleteTimer = null;
      }
    }

    function clearCooldownTimer() {
      if (cooldownTimer !== null) {
        clearTimer(cooldownTimer);
        cooldownTimer = null;
      }
    }

    function clearVadFallbackTimer() {
      if (vadFallbackTimer !== null) {
        clearTimer(vadFallbackTimer);
        vadFallbackTimer = null;
      }
    }

    function clearAllTimers() {
      clearSettleTimer();
      clearIncompleteTimer();
      clearCooldownTimer();
      clearVadFallbackTimer();
    }

    function transition(nextState, detail = {}) {
      const prev = state;
      state = nextState;
      if (prev !== nextState || detail.force) {
        onStateChange(state, {
          previousState: prev,
          enabled,
          capturing,
          candidateText,
          ...detail
        });
      }
    }

    function fireTrigger(questionText, ev) {
      clearAllTimers();
      const q = String(questionText || '').trim();
      if (!q) {
        candidateText = '';
        pendingContinuation = false;
        transition(enabled && capturing ? 'quiet' : 'off');
        return;
      }
      const isCont = pendingContinuation;
      lastAnsweredText = q;
      lastTriggerAt = now();
      youSpokeSinceLastTrigger = false;
      candidateText = '';
      pendingContinuation = false;
      receivedFirstToken = false;
      transition('thinking', {
        question: q,
        isContinuation: isCont,
        confidence: ev.confidence,
        reason: ev.reason
      });
      onTriggerAnswer(q, {
        isContinuation: isCont,
        confidence: ev.confidence,
        reason: ev.reason
      });
    }

    function scheduleQuestionSettle(ev) {
      clearSettleTimer();
      clearVadFallbackTimer();
      transition('settling', { confidence: ev.confidence, reason: ev.reason });

      if (themSpeaking) {
        vadFallbackTimer = setTimer(() => {
          vadFallbackTimer = null;
          themSpeaking = false;
          if ((state === 'settling' || state === 'listening') && candidateText) {
            const currentEv = evaluateQuestionCandidate(candidateText);
            if (currentEv.decision === 'question') {
              fireTrigger(candidateText, currentEv);
            }
          }
        }, 2500);
        return;
      }

      settleTimer = setTimer(() => {
        settleTimer = null;
        if (state !== 'settling' && state !== 'listening') return;
        fireTrigger(candidateText, ev);
      }, ev.settleMs);
    }

    function scheduleIncompleteSettle(ev) {
      clearSettleTimer();
      clearIncompleteTimer();
      transition('listening', { confidence: ev.confidence, reason: ev.reason });
      settleTimer = setTimer(() => {
        settleTimer = null;
        if (!enabled || !capturing || !candidateText) return;
        const stripped = stripDanglingEnding(candidateText);
        const retryEv = evaluateQuestionCandidate(stripped);
        if (retryEv.decision === 'question') {
          fireTrigger(stripped, retryEv);
        } else {
          candidateText = '';
          pendingContinuation = false;
          transition('quiet', { reason: 'incomplete_expired' });
        }
      }, ev.settleMs);
    }

    function evaluateAndSchedule() {
      const ev = evaluateQuestionCandidate(candidateText);
      if (ev.decision === 'ignore') {
        if (ev.reason === 'small_talk') {
          clearAllTimers();
          candidateText = '';
          pendingContinuation = false;
          transition('quiet', { reason: 'small_talk' });
          return;
        }
        transition('listening', { reason: ev.reason });
        clearIncompleteTimer();
        incompleteTimer = setTimer(() => {
          incompleteTimer = null;
          candidateText = '';
          pendingContinuation = false;
          if (state === 'listening') {
            transition('quiet', { reason: 'statement_timeout' });
          }
        }, 4500);
        return;
      }

      if (ev.decision === 'incomplete') {
        scheduleIncompleteSettle(ev);
        return;
      }

      if (ev.decision === 'question') {
        if (
          !pendingContinuation &&
          lastAnsweredText &&
          normalizeText(candidateText) === normalizeText(lastAnsweredText) &&
          (now() - lastTriggerAt) < 10000
        ) {
          clearAllTimers();
          candidateText = '';
          transition('quiet', { reason: 'duplicate' });
          return;
        }
        scheduleQuestionSettle(ev);
      }
    }

    return {
      setConfig(patch = {}) {
        if (typeof patch.enabled === 'boolean') enabled = patch.enabled;
        if (typeof patch.capturing === 'boolean') capturing = patch.capturing;

        if (!enabled || !capturing) {
          clearAllTimers();
          candidateText = '';
          pendingContinuation = false;
          themSpeaking = false;
          youSpeaking = false;
          transition('off');
          return;
        }

        if (state === 'off') {
          transition('quiet');
        }
      },

      onVadState(channel, speaking) {
        if (!enabled || !capturing) return;

        if (channel === 'them') {
          themSpeaking = !!speaking;
          if (themSpeaking) {
            clearSettleTimer();
            clearVadFallbackTimer();
            if (state === 'settling' || state === 'quiet') {
              transition('listening');
            }
          } else {
            clearVadFallbackTimer();
            if ((state === 'listening' || state === 'settling') && candidateText) {
              evaluateAndSchedule();
            }
          }
          return;
        }

        if (channel === 'you') {
          youSpeaking = !!speaking;
          if (youSpeaking) {
            youSpokeSinceLastTrigger = true;
            if (state === 'settling') {
              clearAllTimers();
              candidateText = '';
              pendingContinuation = false;
              transition('quiet', { reason: 'user_spoke' });
            } else if (state === 'thinking' && !receivedFirstToken) {
              clearAllTimers();
              candidateText = '';
              pendingContinuation = false;
              onAbortAnswer();
              transition('quiet', { reason: 'user_spoke' });
            }
          }
        }
      },

      onThemInterim(text) {
        if (!enabled || !capturing) return;
        if (!text || !String(text).trim()) return;
        lastInterimAt = now();
        clearSettleTimer();
        if (state === 'settling' || state === 'quiet') {
          transition('listening');
        }
      },

      onThemFinal(text) {
        if (!enabled || !capturing) return;
        const clean = String(text || '').trim();
        if (!clean) return;

        clearSettleTimer();
        clearIncompleteTimer();
        clearVadFallbackTimer();

        const isContinuationWindow =
          (state === 'thinking' || (state === 'cooldown' && (now() - lastTriggerAt) <= 3500)) &&
          !youSpokeSinceLastTrigger &&
          Boolean(lastAnsweredText);

        if (isContinuationWindow && !isSmallTalkOrLogistics(clean)) {
          if (state === 'thinking') {
            onAbortAnswer();
          }
          clearCooldownTimer();
          candidateText = (lastAnsweredText + ' ' + clean).trim();
          pendingContinuation = true;
        } else {
          candidateText = candidateText ? (candidateText + ' ' + clean).trim() : clean;
        }

        evaluateAndSchedule();
      },

      onYouFinal(text) {
        if (!text || !String(text).trim()) return;
        youSpokeSinceLastTrigger = true;
        candidateText = '';
        pendingContinuation = false;
        clearSettleTimer();
        clearIncompleteTimer();
        clearVadFallbackTimer();
        if (state === 'listening' || state === 'settling') {
          transition('quiet', { reason: 'user_spoke' });
        }
      },

      onLlmStart() {
        if (!enabled || !capturing) return;
        if (state === 'settling' || state === 'thinking') {
          receivedFirstToken = false;
          transition('thinking');
        }
      },

      onLlmToken() {
        if (state === 'thinking') {
          receivedFirstToken = true;
        }
      },

      onLlmDone() {
        if (state === 'thinking') {
          clearCooldownTimer();
          transition('cooldown');
          cooldownTimer = setTimer(() => {
            cooldownTimer = null;
            if (state === 'cooldown') {
              transition(enabled && capturing ? 'quiet' : 'off');
            }
          }, cooldownMs);
        }
      },

      cancel() {
        clearAllTimers();
        const wasThinking = state === 'thinking';
        candidateText = '';
        pendingContinuation = false;
        receivedFirstToken = false;
        if (wasThinking) {
          onAbortAnswer();
        }
        transition(enabled && capturing ? 'quiet' : 'off', { reason: 'cancelled' });
      },

      getState() {
        return {
          state,
          enabled,
          capturing,
          candidateText,
          lastAnsweredText,
          themSpeaking,
          youSpeaking,
          lastInterimAt
        };
      }
    };
  }

  return {
    normalizeText,
    isSmallTalkOrLogistics,
    hasDanglingEnding,
    stripDanglingEnding,
    evaluateQuestionCandidate,
    createAutoAnswerController
  };
});

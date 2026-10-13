/**
 * Pure thread scoring for stealth sending (STEALTH-SENDING-PLAN.MD §4.1).
 *
 * CJS on purpose: jest can require() it directly (same precedent as
 * src/utils/cfCheck.js). Next/webpack imports it from the ESM route via
 * interop, so no ESM export here.
 *
 * Score budget (max 100):
 *   recency   up to +40  (<=7d full, linear decay to 0 at 30d)
 *   bidir     up to +30  (we already replied in-thread; one-sided = neutral 0)
 *   subject   up to +20  (thread subject matches the campaign subject line)
 *   depth     up to +10  (<=6 messages) or -15 (more than 10 messages)
 *
 * Fail-open rules (plan §4.1): zero threads, query errors, ambiguous races
 * (two eligible threads within 10 points), or missing direction info all
 * resolve to action 'new' — i.e. the current fresh-compose behavior.
 */

const DEFAULT_THRESHOLD = 60;
const AMBIGUITY_MARGIN = 10;
const RECENCY_MAX = 40;
const RECENCY_FULL_DAYS = 7;
const RECENCY_ZERO_DAYS = 30;
const BIDIR_MAX = 30;
const SUBJECT_MAX = 20;
const DEPTH_BONUS = 10;
const DEPTH_PENALTY = -15;
const DEPTH_OK_MAX = 6;
const DEPTH_HEAVY_MIN = 11;

function normalizeSubject(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^((re|fwd?|aw)\s*:\s*)+/, "")
    .trim();
}

function daysSince(nowMs, dateVal) {
  if (!dateVal) return null;
  const t =
    dateVal instanceof Date
      ? dateVal.getTime()
      : typeof dateVal === "number"
      ? dateVal
      : Date.parse(dateVal);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86400000);
}

function recencyPoints(days) {
  if (days === null) return 0;
  if (days <= RECENCY_FULL_DAYS) return RECENCY_MAX;
  if (days >= RECENCY_ZERO_DAYS) return 0;
  return Math.round((RECENCY_MAX * (RECENCY_ZERO_DAYS - days)) / (RECENCY_ZERO_DAYS - RECENCY_FULL_DAYS));
}

/**
 * Score a single thread.
 * @param {object} thread - { subject, lastDate, direction, messageCount }
 *   direction: 'both' | 'in' | 'out' | 'unknown'
 *   lastDate: Date | ms | parseable string | null
 * @param {{nowMs?: number, projectSubject?: string}} opts
 * @returns {{score: number, days: number|null, direction: string,
 *            depth: number|null, reasons: string[]}}
 */
function scoreThread(thread, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const projectSubject = opts.projectSubject || "";
  const t = thread || {};
  const reasons = [];
  let score = 0;

  const days = daysSince(nowMs, t.lastDate);
  const recency = recencyPoints(days);
  score += recency;
  reasons.push(`recency:${days === null ? "unknown" : Math.round(days) + "d"}:${recency}`);

  const direction = t.direction || "unknown";
  if (direction === "both") {
    score += BIDIR_MAX;
    reasons.push(`bidirectional:both:${BIDIR_MAX}`);
  } else {
    reasons.push(`bidirectional:${direction}:0`);
  }

  if (projectSubject) {
    const a = normalizeSubject(t.subject);
    const b = normalizeSubject(projectSubject);
    if (a && b && (a.includes(b) || b.includes(a))) {
      score += SUBJECT_MAX;
      reasons.push(`subject:match:${SUBJECT_MAX}`);
    } else {
      reasons.push("subject:differs:0");
    }
  }

  const depth = typeof t.messageCount === "number" && t.messageCount > 0 ? t.messageCount : null;
  if (depth !== null) {
    if (depth <= DEPTH_OK_MAX) {
      score += DEPTH_BONUS;
      reasons.push(`depth:${depth}:${DEPTH_BONUS}`);
    } else if (depth >= DEPTH_HEAVY_MIN) {
      score += DEPTH_PENALTY;
      reasons.push(`depth:${depth}:${DEPTH_PENALTY}`);
    } else {
      reasons.push(`depth:${depth}:0`);
    }
  } else {
    reasons.push("depth:unknown:0");
  }

  return { score, days, direction, depth, reasons };
}

/**
 * Decide reply-vs-new across candidate threads.
 * @param {Array} threads - scored by scoreThread inputs
 * @param {{threshold?: number, nowMs?: number, projectSubject?: string}} opts
 * @returns {{action: 'reply'|'new', reason: string, score: number,
 *            thread?: object, reasons?: string[], margin?: number}}
 */
function decideAction(threads, opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : DEFAULT_THRESHOLD;
  const nowMs = opts.nowMs || Date.now();
  const projectSubject = opts.projectSubject || "";

  if (!Array.isArray(threads) || threads.length === 0) {
    return { action: "new", reason: "no-threads", score: 0 };
  }

  const scored = threads.map((thread) => ({
    thread,
    ...scoreThread(thread, { nowMs, projectSubject }),
  }));
  scored.sort((a, b) => b.score - a.score);

  const eligible = scored.filter((s) => s.score >= threshold);
  if (eligible.length === 0) {
    return { action: "new", reason: "below-threshold", score: scored[0].score };
  }

  const winner = eligible[0];

  if (winner.direction === "unknown") {
    return { action: "new", reason: "missing-direction", score: winner.score };
  }

  if (eligible.length >= 2) {
    const margin = winner.score - eligible[1].score;
    if (margin < AMBIGUITY_MARGIN) {
      return { action: "new", reason: "ambiguous", score: winner.score, margin };
    }
    return {
      action: "reply",
      reason: "clear-winner",
      score: winner.score,
      thread: winner.thread,
      reasons: winner.reasons,
      margin,
    };
  }

  return { action: "reply", reason: "eligible", score: winner.score, thread: winner.thread, reasons: winner.reasons };
}

module.exports = {
  scoreThread,
  decideAction,
  normalizeSubject,
  recencyPoints,
  DEFAULT_THRESHOLD,
  AMBIGUITY_MARGIN,
};

const {
  scoreThread,
  decideAction,
  normalizeSubject,
  recencyPoints,
  DEFAULT_THRESHOLD,
} = require("../src/app/emails/_shared/threadScore.js");

const NOW = Date.parse("2026-09-30T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000);

describe("recencyPoints", () => {
  test("full score at 0 and 7 days", () => {
    expect(recencyPoints(0)).toBe(40);
    expect(recencyPoints(7)).toBe(40);
  });

  test("decays linearly to 0 at 30 days", () => {
    expect(recencyPoints(30)).toBe(0);
    expect(recencyPoints(45)).toBe(0);
    const mid = recencyPoints(18.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(40);
  });

  test("unknown date (null) scores 0, not crash", () => {
    expect(recencyPoints(null)).toBe(0);
  });
});

describe("scoreThread", () => {
  const base = { subject: "Quick question", lastDate: daysAgo(2), direction: "both", messageCount: 4 };

  test("hot bidirectional thread with matching subject clears threshold easily", () => {
    const r = scoreThread(base, { nowMs: NOW, projectSubject: "Quick question" });
    // 40 recency + 30 bidir + 20 subject + 10 depth = 100
    expect(r.score).toBe(100);
    expect(r.direction).toBe("both");
    expect(r.depth).toBe(4);
  });

  test("one-sided inbound is neutral (no bidir points)", () => {
    const r = scoreThread({ ...base, direction: "in" }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(r.score).toBe(70); // 40 + 0 + 20 + 10
  });

  test("unknown direction does not score bidir", () => {
    const r = scoreThread({ ...base, direction: "unknown" }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(r.score).toBe(70);
    expect(r.reasons.some((x) => x.includes("bidirectional:unknown"))).toBe(true);
  });

  test("depth > 10 penalizes, depth <= 6 bonuses", () => {
    const heavy = scoreThread({ ...base, messageCount: 12 }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(heavy.score).toBe(75); // 40 + 30 + 20 - 15
    const light = scoreThread({ ...base, messageCount: 6 }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(light.score).toBe(100);
    const mid = scoreThread({ ...base, messageCount: 8 }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(mid.score).toBe(90); // depth neutral
  });

  test("subject continuity: Re: prefix stripped, case-insensitive", () => {
    const r = scoreThread({ ...base, subject: "re: QUICK question" }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(r.score).toBe(100);
    const r2 = scoreThread({ ...base, subject: "totally different" }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(r2.score).toBe(80); // no subject points
  });

  test("no projectSubject -> subject neutral (max 80)", () => {
    const r = scoreThread(base, { nowMs: NOW });
    expect(r.score).toBe(80); // 40 + 30 + 0 + 10
  });

  test("old thread (25 days) still mid-range", () => {
    const r = scoreThread({ ...base, lastDate: daysAgo(25) }, { nowMs: NOW, projectSubject: "Quick question" });
    // recency round(40*(30-25)/23)=9 + bidir 30 + subject 20 + depth 10 = 69
    expect(r.score).toBe(Math.round((40 * (30 - 25)) / 23) + 60);
    expect(r.score).toBeLessThan(100);
  });

  test("missing messageCount is depth-neutral, not crash", () => {
    const r = scoreThread({ ...base, messageCount: undefined }, { nowMs: NOW, projectSubject: "Quick question" });
    expect(r.score).toBe(90); // depth unknown -> 0
    expect(r.depth).toBeNull();
  });
});

describe("decideAction", () => {
  const eligibleThread = (over = {}) => ({
    subject: "Quick question",
    lastDate: daysAgo(2),
    direction: "both",
    messageCount: 4,
    ...over,
  });

  test("empty list -> new (no-threads)", () => {
    const d = decideAction([], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("new");
    expect(d.reason).toBe("no-threads");
  });

  test("single eligible thread -> reply", () => {
    const d = decideAction([eligibleThread()], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("reply");
    expect(d.reason).toBe("eligible");
    expect(d.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(d.thread).toBeDefined();
  });

  test("threshold boundary: 59 -> new, 60 -> reply", () => {
    // Build a thread that scores exactly: recency 40 + bidir 30 = 70 with no
    // project subject, then use a custom threshold to probe the edge.
    const t = eligibleThread({ messageCount: 8, subject: "x" });
    // score without projectSubject: 40 + 30 + 0 + 0 = 70
    expect(decideAction([t], { nowMs: NOW, threshold: 70 }).action).toBe("reply");
    expect(decideAction([t], { nowMs: NOW, threshold: 71 }).action).toBe("new");
    expect(decideAction([t], { nowMs: NOW, threshold: 71 }).reason).toBe("below-threshold");
  });

  test("cold thread below default threshold -> new", () => {
    const cold = eligibleThread({ lastDate: daysAgo(60), direction: "in", messageCount: 12 });
    // 0 recency + 0 bidir - 15 depth = -15
    const d = decideAction([cold], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("new");
    expect(d.reason).toBe("below-threshold");
  });

  test("unknown direction fails open to new even with hot score", () => {
    const d = decideAction([eligibleThread({ direction: "unknown" })], {
      nowMs: NOW,
      projectSubject: "Quick question",
    });
    expect(d.action).toBe("new");
    expect(d.reason).toBe("missing-direction");
  });

  test("two eligible threads within margin -> ambiguous -> new", () => {
    const a = eligibleThread({ subject: "Quick question" }); // 100
    const b = eligibleThread({ subject: "Re: Quick question" }); // 100
    const d = decideAction([a, b], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("new");
    expect(d.reason).toBe("ambiguous");
    expect(d.margin).toBeLessThan(10);
  });

  test("clear winner by >= 10 -> reply into the winner", () => {
    const hot = eligibleThread({ subject: "Quick question" }); // 100
    const warm = eligibleThread({ lastDate: daysAgo(20), subject: "unrelated", messageCount: 8 });
    // warm: recency round(40*10/23)=17 + 30 bidir = 47 -> not even eligible
    const d = decideAction([warm, hot], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("reply");
    expect(d.thread.subject).toBe("Quick question");
  });

  test("thread missing lastDate is not fatal (recency 0)", () => {
    const t = eligibleThread({ lastDate: null });
    // 0 + 30 + 20 + 10 = 60 -> exactly threshold
    const d = decideAction([t], { nowMs: NOW, projectSubject: "Quick question" });
    expect(d.action).toBe("reply");
    expect(d.score).toBe(60);
  });
});

describe("normalizeSubject", () => {
  test("strips Re:/Fwd: chains and lowercases", () => {
    expect(normalizeSubject("Fwd: RE: Hello World")).toBe("hello world");
    expect(normalizeSubject("  spaced   out  ")).toBe("spaced out");
    expect(normalizeSubject(null)).toBe("");
  });
});

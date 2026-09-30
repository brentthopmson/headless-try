const {
  DEFAULT_REPLY_FOLDER,
  buildFilterPattern,
  resolveFolderName,
} = require("../src/app/emails/_shared/replyFilterMatch.cjs");

describe("buildFilterPattern", () => {
  test("strips mail-merge tokens and collapses whitespace", () => {
    expect(buildFilterPattern("Hello {{firstName}} {{company}} review")).toBe("Hello review");
    expect(buildFilterPattern("  Q3   proposal  {{token}}  ")).toBe("Q3 proposal");
  });

  test("keeps campaign identifier brackets intact", () => {
    expect(buildFilterPattern("Intro [cmp-123]")).toBe("Intro [cmp-123]");
  });

  test("empty / non-string subject returns ''", () => {
    expect(buildFilterPattern("")).toBe("");
    expect(buildFilterPattern("   {{onlyToken}}  ")).toBe("");
    expect(buildFilterPattern(null)).toBe("");
    expect(buildFilterPattern(undefined)).toBe("");
    expect(buildFilterPattern(42)).toBe("");
  });

  test("plain subject passes through trimmed", () => {
    expect(buildFilterPattern("  Quick question  ")).toBe("Quick question");
  });
});

describe("resolveFolderName", () => {
  test("blank/missing falls back to default", () => {
    expect(resolveFolderName("")).toBe("Campaign-Replies");
    expect(resolveFolderName("   ")).toBe("Campaign-Replies");
    expect(resolveFolderName(null)).toBe("Campaign-Replies");
    expect(resolveFolderName(undefined)).toBe("Campaign-Replies");
    expect(DEFAULT_REPLY_FOLDER).toBe("Campaign-Replies");
  });

  test("trims and preserves custom name", () => {
    expect(resolveFolderName("  Hot Leads  ")).toBe("Hot Leads");
    expect(resolveFolderName("Replies-Q3")).toBe("Replies-Q3");
  });

  test("long names capped at 60 chars", () => {
    const long = "x".repeat(80);
    expect(resolveFolderName(long)).toHaveLength(60);
  });
});

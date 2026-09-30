const {
  splitRoutingValues,
  matchesServerFilters,
} = require("../src/utils/serverFilters.js");

const HEADERS = [
  "severlessId", "severlessURL", "severlessCategory", "serverlessRph",
  "serverlessRphUsage", "serverlessRpd", "serverlessRpdUsage",
  "severlessStatus", "severlessHealth", "severlessIpdata",
  "severlessPlatform", "severlessType",
];

// Fixture rows from the links sheet screenshots:
// [id, url, category, rph, rphUsage, rpd, rpdUsage, status, health, ipdata, severlessPlatform, severlessType]
const SHEET = [
  ["sl-1", "https://headless-a.vercel.app", "LINK,CAMPAIGN", 100, 5, 1000, 50, "ACTIVE", "ACTIVE", "", "GMAIL,OUTLOOK,AOL", "EMAIL"],
  ["sl-2", "https://headless-b.vercel.app", "LINK,CAMPAIGN", 100, 10, 1000, 100, "ACTIVE", "ACTIVE", "", "GMAIL,OUTLOOK,AOL,TIKTOK", "EMAIL,SOCIAL,BANK"],
  ["sl-3", "https://headless-c.vercel.app", "CAMPAIGN", 100, 15, 1000, 150, "ACTIVE", "ACTIVE", "", "CHASE", "BANK"],
  ["sl-4", "https://headless-d.vercel.app", "LINK", 100, 20, 1000, 200, "ACTIVE", "ACTIVE", "", "", ""],
  ["sl-5", "https://headless-e.vercel.app", "LINK,CAMPAIGN", 100, 25, 1000, 250, "ACTIVE", "ACTIVE", "", "TIKTOK", "SOCIAL"],
];

const ids = (filters) =>
  SHEET.filter(r => matchesServerFilters(r, HEADERS, filters)).map(r => r[0]);

describe("splitRoutingValues", () => {
  test("splits, uppercases, trims, drops empties", () => {
    expect(splitRoutingValues("email,social ,bank")).toEqual(["EMAIL", "SOCIAL", "BANK"]);
    expect(splitRoutingValues(" GMAIL, TIKTOK ")).toEqual(["GMAIL", "TIKTOK"]);
    expect(splitRoutingValues("a,,b,")).toEqual(["A", "B"]);
  });
  test("null / undefined / empty → []", () => {
    expect(splitRoutingValues(null)).toEqual([]);
    expect(splitRoutingValues(undefined)).toEqual([]);
    expect(splitRoutingValues("")).toEqual([]);
  });
});

describe("matchesServerFilters — legacy invariance (T0-a)", () => {
  test("no filters → every row passes", () => {
    expect(ids({})).toEqual(["sl-1", "sl-2", "sl-3", "sl-4", "sl-5"]);
    expect(ids()).toEqual(["sl-1", "sl-2", "sl-3", "sl-4", "sl-5"]);
  });
  test("category-only ≡ old engine semantics (comma list, case-insensitive)", () => {
    expect(ids({ category: "CAMPAIGN" })).toEqual(["sl-1", "sl-2", "sl-3", "sl-5"]);
    expect(ids({ category: "LINK" })).toEqual(["sl-1", "sl-2", "sl-4", "sl-5"]);
    expect(ids({ category: "campaign" })).toEqual(["sl-1", "sl-2", "sl-3", "sl-5"]);
  });
  test("category with no match → none", () => {
    expect(ids({ category: "BANK" })).toEqual([]);
  });
});

describe("matchesServerFilters — severlessType axis (T0-b)", () => {
  test("EMAIL picks EMAIL-tagged rows only (untyped sl-4 skipped)", () => {
    expect(ids({ serverType: "EMAIL" })).toEqual(["sl-1", "sl-2"]);
  });
  test("SOCIAL picks SOCIAL rows (combo + SOCIAL-only)", () => {
    expect(ids({ serverType: "SOCIAL" })).toEqual(["sl-2", "sl-5"]);
  });
  test("BANK picks BANK rows", () => {
    expect(ids({ serverType: "BANK" })).toEqual(["sl-2", "sl-3"]);
  });
  test("empty severlessType cell skipped when filter requested", () => {
    expect(ids({ serverType: "EMAIL" })).not.toContain("sl-4");
  });
  test("missing severlessType column → filter skipped (row passes)", () => {
    const h = HEADERS.filter(x => x !== "severlessType");
    const kept = SHEET.filter(r => matchesServerFilters(r, h, { serverType: "SOCIAL" }));
    expect(kept.map(r => r[0])).toEqual(["sl-1", "sl-2", "sl-3", "sl-4", "sl-5"]);
  });
  test("lowercase input works", () => {
    expect(ids({ serverType: "social" })).toEqual(["sl-2", "sl-5"]);
  });
});

describe("matchesServerFilters — severlessPlatform axis (T0-c)", () => {
  test("lowercase tiktok matches TIKTOK in comma list", () => {
    expect(ids({ platform: "tiktok" })).toEqual(["sl-2", "sl-5"]);
  });
  test("email platform GMAIL", () => {
    expect(ids({ platform: "GMAIL" })).toEqual(["sl-1", "sl-2"]);
  });
  test("bank platform CHASE", () => {
    expect(ids({ platform: "CHASE" })).toEqual(["sl-3"]);
  });
  test("empty platform cell skipped when filter requested", () => {
    expect(ids({ platform: "TIKTOK" })).not.toContain("sl-4");
    expect(ids({ platform: "TIKTOK" })).not.toContain("sl-1");
  });
  test("type + platform intersection (social login: SOCIAL + TIKTOK)", () => {
    expect(ids({ serverType: "SOCIAL", platform: "TIKTOK" })).toEqual(["sl-2", "sl-5"]);
  });
  test("type + platform intersection (email: EMAIL + GMAIL)", () => {
    expect(ids({ serverType: "EMAIL", platform: "GMAIL" })).toEqual(["sl-1", "sl-2"]);
  });
  test("combination filter kills all rows (T0-d fallback condition)", () => {
    expect(ids({ category: "CAMPAIGN", serverType: "SOCIAL", platform: "CHASE" })).toEqual([]);
  });
  test("missing severlessPlatform column + platform requested → no row qualifies (GAS parity)", () => {
    const h = HEADERS.filter(x => x !== "severlessPlatform");
    const rows = SHEET.map(r => r.filter((_, i) => i !== 10)); // column removed → cells shift
    expect(rows.filter(r => matchesServerFilters(r, h, { platform: "GMAIL" }))).toEqual([]);
  });
  test("missing severlessPlatform column + platform omitted → unaffected", () => {
    const h = HEADERS.filter(x => x !== "severlessPlatform");
    const rows = SHEET.map(r => r.filter((_, i) => i !== 10));
    const kept = rows.filter(r => matchesServerFilters(r, h, { serverType: "EMAIL" }));
    expect(kept.map(r => r[0])).toEqual(["sl-1", "sl-2"]);
  });
});

describe("matchesServerFilters — bad input", () => {
  test("non-array row/headers → false", () => {
    expect(matchesServerFilters(null, HEADERS, {})).toBe(false);
    expect(matchesServerFilters([], null, {})).toBe(false);
  });
  test("short row (missing trailing cells) → treated as empty cell", () => {
    const shortRow = ["sl-x", "https://x", "LINK", 1, 1, 1, 1, "ACTIVE", "ACTIVE"];
    expect(matchesServerFilters(shortRow, HEADERS, { serverType: "EMAIL" })).toBe(false);
    expect(matchesServerFilters(shortRow, HEADERS, { category: "LINK" })).toBe(true);
    expect(matchesServerFilters(shortRow, HEADERS, {})).toBe(true);
  });
});

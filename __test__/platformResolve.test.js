const {
  resolvePlatform,
  pickConfiguredPlatform,
  matchPlatformByMx,
  domainOf,
} = require("../src/app/socials/cookie/cookie-api-login/platformHelper/main.js");
const {
  TIKTOK_PLATFORM_KEY,
  TIKTOK_LOGIN_URL,
  LOGIN_METHODS,
  DEFAULT_LOGIN_METHOD,
  isTiktokPlatform,
  normalizeLoginMethod,
} = require("../src/app/socials/cookie/cookie-api-login/platformHelper/tiktok.js");

const CONFIGS = {
  tiktok: { url: "https://tiktok.com/login" },
  twitter: { url: "https://twitter.com/login", mxKeywords: ["twitter", "tscortex"] },
  gmailish: { url: "https://mail.google.com/", mxKeywords: ["gmail", "google"] },
};

describe("resolvePlatform — precedence platform → strictly → mx → unknown", () => {
  test("platform param wins over strictly and email/mx (no DNS)", async () => {
    const spy = jest.fn(async () => [{ exchange: "aspmx.l.google.com" }]);
    const r = await resolvePlatform({
      platform: "tiktok",
      strictly: "twitter",
      email: "user@gmail.com",
      configs: CONFIGS,
      resolveMxFn: spy,
    });
    expect(r).toEqual({
      platform: "tiktok",
      source: "platform",
      domain: "gmail.com",
      mxRecords: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test("strictly resolves emailless TikTok rows (the socials strictly vehicle)", async () => {
    const r = await resolvePlatform({ strictly: "tiktok", configs: CONFIGS });
    expect(r.platform).toBe("tiktok");
    expect(r.source).toBe("strictly");
  });

  test("invalid platform key falls through to strictly", async () => {
    const r = await resolvePlatform({ platform: "not-a-platform", strictly: "TikTok", configs: CONFIGS });
    expect(r.platform).toBe("tiktok");
    expect(r.source).toBe("strictly");
  });

  test("case and whitespace insensitivity on strict value", async () => {
    const r = await resolvePlatform({ strictly: "  TikTok  ", configs: CONFIGS });
    expect(r.platform).toBe("tiktok");
  });

  test("no hints + email → email domain/MX legacy path (DNS called)", async () => {
    const spy = jest.fn(async () => []);
    const r = await resolvePlatform({ email: "user@gmail.com", configs: CONFIGS, resolveMxFn: spy });
    expect(r.platform).toBe("gmailish");
    expect(r.source).toBe("mx");
    expect(r.domain).toBe("gmail.com");
    expect(spy).toHaveBeenCalledWith("gmail.com");
  });

  test("MX exchange match when domain has no keyword", async () => {
    const spy = jest.fn(async () => [{ exchange: "mail.twitter.com." }]);
    const r = await resolvePlatform({ email: "info@corp.example", configs: CONFIGS, resolveMxFn: spy });
    expect(r.platform).toBe("twitter");
    expect(r.source).toBe("mx");
  });

  test("strictly wins over email/mx and skips DNS (documented precedence)", async () => {
    const spy = jest.fn(async () => []);
    const r = await resolvePlatform({ strictly: "twitter", email: "user@gmail.com", configs: CONFIGS, resolveMxFn: spy });
    expect(r.platform).toBe("twitter");
    expect(spy).not.toHaveBeenCalled();
  });

  test("nothing known → unknown / none (emailless WAITINGEMAIL path)", async () => {
    const spy = jest.fn(async () => []);
    const r = await resolvePlatform({ configs: CONFIGS, resolveMxFn: spy });
    expect(r.platform).toBe("unknown");
    expect(r.source).toBe("none");
    expect(r.domain).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalid strictly + no email → unknown (falls through)", async () => {
    const r = await resolvePlatform({ strictly: "gmail", configs: CONFIGS });
    expect(r.platform).toBe("unknown");
  });

  test("DNS failure → unknown, does not throw", async () => {
    const r = await resolvePlatform({
      email: "user@nowhere.example",
      configs: CONFIGS,
      resolveMxFn: async () => { throw new Error("DNS down"); },
    });
    expect(r.platform).toBe("unknown");
    expect(r.mxRecords).toEqual([]);
  });

  test("missing configs → unknown, no throw", async () => {
    const r = await resolvePlatform({ platform: "tiktok" });
    expect(r.platform).toBe("unknown");
    const r2 = await resolvePlatform({ strictly: "tiktok", email: "a@b.com" });
    expect(r2.platform).toBe("unknown");
    expect(r2.domain).toBe("b.com");
  });

  test("emailless rows with invalid strict value never call DNS", async () => {
    const spy = jest.fn(async () => []);
    const r = await resolvePlatform({ strictly: "NOTAPLATFORM", configs: CONFIGS, resolveMxFn: spy });
    expect(r.platform).toBe("unknown");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("pickConfiguredPlatform / matchPlatformByMx / domainOf", () => {
  test("pickConfiguredPlatform exact + lowercased key", () => {
    expect(pickConfiguredPlatform("tiktok", CONFIGS)).toBe("tiktok");
    expect(pickConfiguredPlatform("TIKTOK", CONFIGS)).toBe("tiktok");
    expect(pickConfiguredPlatform(" gmail ", CONFIGS)).toBe("");
    expect(pickConfiguredPlatform("", CONFIGS)).toBe("");
    expect(pickConfiguredPlatform("tiktok", null)).toBe("");
  });

  test("matchPlatformByMx keywords are case-insensitive", () => {
    expect(matchPlatformByMx("MAIL.GMAIL.COM", [], CONFIGS)).toBe("gmailish");
    expect(matchPlatformByMx("corp.example", [{ exchange: "MX.TWITTER.COM" }], CONFIGS)).toBe("twitter");
    expect(matchPlatformByMx("corp.example", [{ exchange: "aspmx.l.google.com" }], CONFIGS)).toBe("gmailish");
    expect(matchPlatformByMx("corp.example", [], CONFIGS)).toBe("");
    expect(matchPlatformByMx("tiktok.com", [], CONFIGS)).toBe("");
  });

  test("domainOf handles garbage", () => {
    expect(domainOf("a@b.com")).toBe("b.com");
    expect(domainOf("A@B.COM")).toBe("b.com");
    expect(domainOf("nodomain")).toBe("");
    expect(domainOf("")).toBe("");
    expect(domainOf(null)).toBe("");
  });
});

describe("tiktok helper", () => {
  test("normalizeLoginMethod accepts qr/email/phone only", () => {
    expect(normalizeLoginMethod("QR")).toBe("qr");
    expect(normalizeLoginMethod(" Phone ")).toBe("phone");
    expect(normalizeLoginMethod("email")).toBe("email");
    expect(normalizeLoginMethod("sms")).toBe("");
    expect(normalizeLoginMethod("")).toBe("");
    expect(normalizeLoginMethod(null)).toBe("");
    expect(normalizeLoginMethod(undefined)).toBe("");
  });
  test("isTiktokPlatform", () => {
    expect(isTiktokPlatform("tiktok")).toBe(true);
    expect(isTiktokPlatform("TikTok")).toBe(true);
    expect(isTiktokPlatform("twitter")).toBe(false);
    expect(isTiktokPlatform("")).toBe(false);
    expect(isTiktokPlatform(null)).toBe(false);
  });
  test("constants", () => {
    expect(TIKTOK_PLATFORM_KEY).toBe("tiktok");
    expect(TIKTOK_LOGIN_URL).toContain("tiktok.com/login");
    expect(LOGIN_METHODS).toEqual(["qr", "email", "phone"]);
    expect(DEFAULT_LOGIN_METHOD).toBe("email");
  });
});

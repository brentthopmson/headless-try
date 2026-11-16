// Dependency-free enrichment helpers.
// Kept free of app imports so the AI-first normalization rules can be tested
// in isolation (no Next.js, Sheets, Drive, browser, or network required).

export const SCHEMA_ROLES = new Set([
  "email", "first_name", "last_name", "full_name", "company", "job_title", "phone", "mobile_phone",
  "url", "address", "city", "state", "region", "country", "postal_code", "context_notes",
  "social_handle", "social_platform", "location_text", "industry", "employee_count",
  "ignore_system", "ignore_template", "unknown"
]);

export const WRITE_POLICIES = new Set([
  "overwrite_if_clearly_misfilled", "fill_if_empty", "verify_only", "never_touch"
]);

export const BASES = new Set(["restructure", "derived", "inferred", "verified"]);

// Engine-owned columns: AI must never write campaign state, credentials,
// templates, tracking, or delivery bookkeeping (case/punctuation insensitive).
const SYSTEM_HEADER_KEYS = new Set([
  "sn", "campaigntype", "engine", "provider",
  "shooterfirstname", "shooterlastname", "shooteremail", "shooteraddress", "shootercity",
  "shooterstate", "shootercountry", "shooterzipcode", "shooterphone", "shootersex",
  "smtp", "port", "username", "password", "apppassword", "backupcode",
  "oauth2clientid", "oauth2clientsecret", "oauth2refreshtoken",
  "shouldvalidate", "shouldenhance", "shouldsearchinteract", "shouldpageinteract",
  "shouldinboxinteract", "shouldactivitiesinteract", "shouldsendmessage",
  "emailsubject", "emailbody", "socialmessage", "replyto",
  "validation", "providermxresult", "enhancedsubject", "enhancedbody", "enhancedsocialmessage",
  "enrichmentstatus", "senddate", "sendtime", "sendstamp",
  "searchkeys", "searchcount", "searchstatus", "searchstamp",
  "profiletointeract", "interactcount", "interactstatus", "interactstamp",
  "personalizationstatus", "executionstatus", "link",
  "retrycount", "lastsendmethod", "lastsendstatus", "lastsenderror", "lastattemptat",
  "sentstatus", "sendresult", "senderror", "deliverystatus",
]);

export function isSystemHeader(header) {
  return SYSTEM_HEADER_KEYS.has(normKey(header));
}

export function normHeader(h) { return String(h || "").trim().toUpperCase(); }
export function normKey(h) { return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
export function cleanText(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }

export function isPlaceholder(v) {
  const s = cleanText(v).toLowerCase();
  return !s || [
    "n/a", "na", "none", "null", "undefined", "-", "--", "unknown", "not available",
    "n.a.", "tbd", "nil", "personal", "self", "private", "individual", "no company",
    "not applicable"
  ].includes(s);
}

export function normalizeEmailValue(v) {
  const s = cleanText(v).toLowerCase().replace(/^mailto:/, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return s;
}

export function getEmailDomain(email) {
  const e = normalizeEmailValue(email);
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(at + 1) : "";
}

export function clampStr(v, max = 500) {
  const s = cleanText(v);
  return s.length > max ? s.slice(0, max) : s;
}

export function sanitizeCell(value) {
  if (!value || typeof value !== "string") return value;
  let out = value;
  if (/<html|<head|<style|<body|<script|<link\s+rel|<img|<a\s+[^>]*href/i.test(out)) {
    out = out.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<\/?\s*[A-Za-z][^>]*?>/g, " ").replace(/\s+/g, " ").trim();
  }
  out = out.replace(/[\u200B-\u200D\uFEFF\x00-\x1F\x7F]/g, "");
  const first = out.trimStart()[0];
  if (first === "=" || first === "+" || first === "-" || first === "@" || first === "\t" || first === "\r") {
    out = `'${out.trimStart()}`;
  }
  return out.slice(0, 3000);
}

const HEADER_HINTS = {
  email: ["email", "e-mail", "mail", "emailaddress", "workemail", "businessemail"],
  first_name: ["firstname", "first_name", "givenname", "fname", "contactfirstname"],
  last_name: ["lastname", "last_name", "surname", "familyname", "lname", "contactlastname"],
  full_name: ["fullname", "full_name", "name", "contactname", "personname", "leadname", "contact"],
  company: ["businessname", "company", "companyname", "organization", "org", "business", "employer"],
  phone: ["phone", "mobile", "cell", "telephone", "phonenumber", "businessphone", "companyphone", "workphone", "officephone"],
  url: ["url", "website", "site", "domain", "web", "companyurl", "homepage", "link"],
  context_notes: ["context", "notes", "note", "description", "about", "bio"],
  job_title: ["jobtitle", "title", "position", "role"],
};

export function headerHint(header) {
  const k = normKey(header);
  for (const [role, aliases] of Object.entries(HEADER_HINTS)) {
    if (aliases.some((a) => normKey(a) === k)) return role;
  }
  return "unknown";
}

export function resolveHeaderIndex(headers, nameOrAliases) {
  const names = Array.isArray(nameOrAliases) ? nameOrAliases : [nameOrAliases];
  const keys = new Set(names.map(normKey));
  for (let i = 0; i < headers.length; i++) {
    if (keys.has(normKey(headers[i]))) return i;
  }
  for (const name of names) {
    const idx = headers.indexOf(normHeader(name));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function ensureColumn(headers, rows, name) {
  const n = normHeader(name);
  let idx = resolveHeaderIndex(headers, n);
  if (idx !== -1) return idx;
  headers.push(n);
  idx = headers.length - 1;
  const startRow = rows[0] === headers ? 1 : 0;
  for (let i = startRow; i < rows.length; i++) rows[i][idx] = "";
  return idx;
}

export function getCell(row, headers, nameOrAliases) {
  const idx = resolveHeaderIndex(headers, nameOrAliases);
  return idx >= 0 ? String(row[idx] || "").trim() : "";
}

export function setCell(row, headers, nameOrAliases, value) {
  const idx = resolveHeaderIndex(headers, nameOrAliases);
  if (idx >= 0) row[idx] = sanitizeCell(String(value ?? ""));
}

export function hygieneRow(row) {
  // Non-semantic hygiene only: trim/collapse whitespace, clear placeholders.
  for (let i = 0; i < row.length; i++) {
    const v = String(row[i] ?? "");
    if (!v) continue;
    const cleaned = cleanText(v);
    if (isPlaceholder(cleaned)) { row[i] = ""; continue; }
    if (cleaned !== v) row[i] = sanitizeCell(cleaned);
  }
}

export function buildColumnStats(rows, headers) {
  const data = rows.slice(1);
  const n = Math.max(1, data.length);
  return headers.map((h, index) => {
    const values = [];
    let nonEmpty = 0;
    const distinct = new Set();
    for (const r of data) {
      const v = cleanText(r[index]);
      if (!v) continue;
      nonEmpty++;
      if (distinct.size < 50) distinct.add(v.toLowerCase());
      if (values.length < 5) values.push(v.slice(0, 120));
    }
    return { header: h, fillRate: Number((nonEmpty / n).toFixed(3)), distinct: distinct.size, hint: headerHint(h), samples: values };
  });
}

// Applies only verifier-accepted patches. Identifier columns (email/phone/url)
// are never fabricated from inference; never_touch and write policies are
// enforced deterministically.
export function validateAndApplyPatches(row, headers, schemaByHeader, proposed, decisions, verifierOk) {
  if (!verifierOk) return { changed: false, status: "no_data", failed: true };
  const verifierRan = !!(decisions && Array.isArray(decisions.decisions));
  const accepted = new Set();
  if (verifierRan) {
    for (const d of decisions.decisions) {
      if (d && d.decision === "accept" && typeof d.header === "string") accepted.add(normKey(d.header));
    }
  }
  const patches = Array.isArray(proposed?.patches) ? proposed.patches : [];
  let changed = false;
  for (const p of patches) {
    try {
      if (!verifierRan) continue;
      const header = headers.find((h) => h === p?.header) || headers.find((h) => normKey(h) === normKey(p?.header));
      if (!header) continue;
      if (!accepted.has(normKey(header))) continue;
      const meta = schemaByHeader.get(header);
      if (!meta || meta.write_policy === "never_touch") continue;
      const basis = BASES.has(p?.basis) ? p.basis : null;
      if (!basis) continue;
      const conf = Number(p?.confidence);
      if (!Number.isFinite(conf) || conf < 0) continue;
      if (conf < 0.5 && basis !== "restructure" && basis !== "derived") continue;
      let value = clampStr(p?.value, 500);
      if (!value || isPlaceholder(value)) continue;

      const current = cleanText(getCell(row, headers, header));
      if (current && current === value) continue;
      const policy = meta.write_policy;
      if (policy === "fill_if_empty" && current) continue;
      if (policy === "verify_only" && basis === "inferred") continue;

      // "Personal" / "self" / "unknown" are never an employer or a website.
      // Company and URL must be restructured/derived from existing row text or
      // backed by evidence - never guessed from a "Personal contact: ..." note.
      if ((meta.role === "company" || meta.role === "url") && basis === "inferred") continue;

      if (meta.role === "company" && /^(personal|self|private|individual|no company)$/i.test(value)) continue;

      if (meta.role === "email") {
        const ev = normalizeEmailValue(value);
        if (!ev) continue;
        if (basis === "inferred") continue; // never fabricate email
        value = ev;
      }
      if (meta.role === "phone" || meta.role === "mobile_phone") {
        const digits = String(value).replace(/\D/g, "");
        if (digits.length < 7) continue;
        if (basis === "inferred") continue; // never invent phone
      }
      if (meta.role === "url") {
        let u = value;
        if (!/^https?:\/\//i.test(u)) {
          // Only prefix a value that already looks like a domain, never a label.
          if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:[/:?#]|$)/i.test(u)) continue;
          u = `https://${u}`;
        }
        try {
          const parsedUrl = new URL(u);
          if (!/^https?:$/.test(parsedUrl.protocol)) continue;
          if (!parsedUrl.hostname || !parsedUrl.hostname.includes(".")) continue;
        } catch { continue; }
        value = u;
      }

      setCell(row, headers, header, value);
      changed = true;
    } catch { /* ignore malformed patch */ }
  }
  const status = changed ? "enriched" : "no_data";
  return { changed, status, failed: false };
}

// Bounded concurrency planner: batchSize rows per AI call, up to batchSize AI
// calls per wave, covering the full pending list without truncation.
export function planEnrichmentWaves(pendingIndexes, batchSize) {
  const n = Math.max(1, parseInt(batchSize, 10) || 1);
  const waves = [];
  for (let cursor = 0; cursor < pendingIndexes.length; cursor += n * n) {
    const window = pendingIndexes.slice(cursor, cursor + n * n);
    const groups = [];
    for (let g = 0; g < window.length; g += n) groups.push(window.slice(g, g + n));
    waves.push(groups);
  }
  return waves;
}

// Pure reply-filter helpers — CJS so jest can require() them (same interop
// pattern as threadScore.js). replyFilter.js re-exports these for runtime.

const DEFAULT_REPLY_FOLDER = "Campaign-Replies";

/**
 * Pure: derive the subject-based filter identifier from a raw subject.
 * Strips mail-merge {{tokens}}, collapses whitespace. "" = nothing to match.
 */
function buildFilterPattern(subject) {
  if (typeof subject !== "string") return "";
  return subject
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure: empty/blank folder name falls back to the default label/folder. */
function resolveFolderName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  return n ? n.slice(0, 60) : DEFAULT_REPLY_FOLDER;
}

module.exports = { DEFAULT_REPLY_FOLDER, buildFilterPattern, resolveFolderName };

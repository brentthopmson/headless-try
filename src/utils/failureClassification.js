// Pure helpers that decide whether a terminal failure deserves a RICH debug
// capture (HTML/screenshot/Drive) or only the normal structured DEBUG row.
// No imports, no side effects — safe to use from any route.

const WAITING_PREFIX = /^WAITING/i;

// Expected / user-driven outcomes. These are not engine faults; capturing a
// page snapshot for them just creates noise in the debug sheet and Drive.
const EXPECTED_PATTERNS = [
  /blocked by platform limits/i,
  /platform limit/i,
  /rate.?limit/i,
  /quota/i,
  /cancelled/i,
  /canceled/i,
  /aborted/i,
  /ECONNRESET/i,
  /must login first/i,
  /no cookies found/i,
  /not specified/i,
  /not provided/i,
  /unsupported provider/i,
  /no mx records?/i,
  /email not found/i,
  /already running/i,
  /manual login/i,
  /captcha required/i,
];

/** True for WAITING* states — intentional pauses waiting on operator input. */
export function isUserInputTimeout(status) {
  return WAITING_PREFIX.test(String(status || '').trim());
}

/** True when the failure is expected/user-driven rather than an engine fault. */
export function isExpectedFailure({ status, reason, error, message } = {}) {
  if (isUserInputTimeout(status)) return true;
  const text = [reason, error, message].filter(Boolean).join(' ');
  if (!text) return false;
  return EXPECTED_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether to fire captureFailureDebug for a terminal outcome.
 * Success and expected/user-driven failures are excluded.
 */
export function shouldCaptureRichDebug({ status, reason, error, message } = {}) {
  const s = String(status || '').toUpperCase();
  if (!s || s === 'COMPLETED' || s === 'SUCCESS' || s === 'OK') return false;
  return !isExpectedFailure({ status: s, reason, error, message });
}

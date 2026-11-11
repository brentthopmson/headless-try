// Graph does NOT gate or count usage. Mirrors cookie-api-login flow.
// No-op pass-through kept for API compatibility with other features.
export async function requireGraphFeature() {
  return null;
}
export async function checkGraphQuota() {
  return { allowed: true };
}
export async function incrementGraphUsage() {
  return;
}
export default { requireGraphFeature, checkGraphQuota, incrementGraphUsage };
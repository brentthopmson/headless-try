// Twitter/X platform helpers for search-interact.
// DOM/behavior methods live here; config stays in ../platforms.js.
// X uses the generic runner (platformHelper/genericRunner.js) — these exports
// are the Twitter-specific overrides if/when per-comment reply waves land
// (identical shape to TikTokHelpers: ensureCommentsVisible / isPostLiked /
// navigateAndWait, but for X's tweet-detail modal and reply composer).
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';

export async function navigateAndWait(page, url) {
    return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='like']", timeoutMs: 20000, label: 'tweet' });
}
export async function isPostLiked(page, s) {
    return isPostLikedGeneric(page, s.likeButton);
}
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) {
    // X shows replies inside the tweet detail view already — no separate tab.
    return ensureCommentsVisibleGeneric(page, { selectors: {} }, '[twitterComments]');
}
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

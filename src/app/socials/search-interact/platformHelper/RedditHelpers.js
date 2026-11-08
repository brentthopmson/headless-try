// Reddit platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// Reddit: search = thread listings, "like" = upvote, comment = threaded reply.
// Composer accepts markdown-ish plain text (no hashtags/mentions needed).
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='upvote' i]", timeoutMs: 20000, label: 'reddit-thread' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.upvoteButton || s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "div[contenteditable='true'], textarea", commentItem: "div[data-testid='comment']" } }, '[redditComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

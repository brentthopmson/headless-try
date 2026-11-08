// Instagram platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// IG opens posts in a modal (article[role=presentation]); the comment composer
// is a plain textarea. Search requires typing + picking a suggestion.
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='Like']", timeoutMs: 20000, label: 'ig-post' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "textarea[aria-label*='Add a comment']", commentItem: "ul li div[role='button']" } }, '[igComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

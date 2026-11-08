// Facebook platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// FB post = div[data-testid=post]; composer is div[role=textbox]; comments are
// div[data-testid=comment]. Like uses aria-label Like/Unlike toggle.
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='Like']", timeoutMs: 20000, label: 'fb-post' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "div[role='textbox']", commentItem: "div[data-testid='comment']" } }, '[fbComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

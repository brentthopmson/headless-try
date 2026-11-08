// Threads platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// Threads: post = thread, like = heart, reply = threaded composer (~500 chars).
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='Like']", timeoutMs: 20000, label: 'threads-post' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "div[contenteditable='true'][role='textbox'], textarea", commentItem: "div[data-testid='thread-comment'], article" } }, '[threadsComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

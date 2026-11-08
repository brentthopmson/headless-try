// YouTube platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// YouTube comments live below the fold (ytd-comment-thread-renderer) and the
// composer is ytd-comment-simple-box-renderer. Like = #segmented-like-button.
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "#segmented-like-button button", timeoutMs: 20000, label: 'video' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "ytd-comment-simple-box-renderer div[contenteditable='true']", commentItem: "ytd-comment-thread-renderer" } }, '[youtubeComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

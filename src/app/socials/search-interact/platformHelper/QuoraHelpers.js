// Quora platform helpers for search-interact (DOM/behavior; config in ../platforms.js).
// Quora has no "like" — the positive action is Upvote (button[aria-label*=Upvote]).
// Comments are "Add comment" threads; composer is a contenteditable textbox.
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, ensureCommentsVisibleGeneric } from './GenericHelpers.js';
export async function navigateAndWait(page, url) { return navigateAndWaitGeneric(page, url, { waitSelector: "button[aria-label*='Upvote']", timeoutMs: 20000, label: 'quora-post' }); }
export async function isPostLiked(page, s) { return isPostLikedGeneric(page, s.upvoteButton || s.likeButton); }
export const isConfidentlyUnliked = (sig) => isConfidentlyUnlikedGeneric(sig);
export async function ensureCommentsVisible(page) { return ensureCommentsVisibleGeneric(page, { selectors: { commentBox: "div[contenteditable='true'][role='textbox']", commentItem: "div[class*='qu-comment']" } }, '[quoraComments]'); }
export default { navigateAndWait, isPostLiked, isConfidentlyUnliked, ensureCommentsVisible };

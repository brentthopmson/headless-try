import { createPlatformHelper } from "../../_shared/platformHelperFactory.js";
import { facebook } from "../../_shared/platforms/facebook.js";

const helper = createPlatformHelper({
    ...facebook,
    capabilities: { ...facebook.capabilities, notifications: false, inbox: false, newDm: false },
});

export default helper;
export const openProfile = helper.openProfile;
export const follow = helper.follow;
export const unfollow = helper.unfollow;
export const like = helper.like;
export const comment = helper.comment;
export const listPostLinks = helper.listPostLinks;
export const openPost = helper.openPost;
export const isPostLiked = helper.isPostLiked;
export const followState = helper.followState;
export const probe = helper.probe;

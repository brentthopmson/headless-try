import { createPlatformHelper } from "../../_shared/platformHelperFactory.js";
import { youtube } from "../../_shared/platforms/youtube.js";

const helper = createPlatformHelper({
    ...youtube,
    capabilities: { ...youtube.capabilities, notifications: false },
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

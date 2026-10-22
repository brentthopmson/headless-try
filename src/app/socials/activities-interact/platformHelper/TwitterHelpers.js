import { createPlatformHelper } from "../../_shared/platformHelperFactory.js";
import { twitter } from "../../_shared/platforms/twitter.js";

const helper = createPlatformHelper({
    ...twitter,
    capabilities: { ...twitter.capabilities, inbox: false, newDm: false },
});

export default helper;
export const openNotifications = helper.openNotifications;
export const listNotifications = helper.listNotifications;
export const followBack = helper.followBack;
export const openNotificationTarget = helper.openNotificationTarget;
export const follow = helper.follow;
export const like = helper.like;
export const comment = helper.comment;
export const probe = helper.probe;

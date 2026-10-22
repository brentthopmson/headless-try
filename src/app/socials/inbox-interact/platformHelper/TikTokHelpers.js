import { createPlatformHelper } from "../../_shared/platformHelperFactory.js";
import { tiktok } from "../../_shared/platforms/tiktok.js";

const helper = createPlatformHelper({
    ...tiktok,
    capabilities: { ...tiktok.capabilities, follow: false, unfollow: false, like: false, comment: false, notifications: false },
});

export default helper;
export const openMessages = helper.openMessages;
export const listConversations = helper.listConversations;
export const openConversation = helper.openConversation;
export const lastMessageText = helper.lastMessageText;
export const sendMessageText = helper.sendMessageText;
export const sendNewMessage = helper.sendNewMessage;
export const isLoggedOut = helper.isLoggedOut;
export const dismiss = helper.dismiss;
export const probe = helper.probe;

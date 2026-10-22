import { createPlatformHelper } from "../../../socials/_shared/platformHelperFactory.js";
import { whatsapp } from "../../../socials/_shared/platforms/whatsapp.js";

const helper = createPlatformHelper(whatsapp);

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

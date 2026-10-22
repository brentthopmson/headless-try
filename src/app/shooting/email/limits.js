import { checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

export async function getShootContactsQuota(userId) {
  return checkUserQuota(userId, { keys: ["shootContactsUsage"] });
}

export async function incrementShootContactsUsage(userId, count) {
  return updateUserUsage(userId, "shootContactsUsage", count);
}

// ==================== Mail Merge for Shoot Contacts ====================
// Replaces template variables in subject/body using extracted contact data.
// Uses the same variables as campaign mail merge (pipelineUtils.js).

/**
 * Apply mail merge to a template string using contact data.
 * @param {string} template - subject or body with {{variables}}
 * @param {object} contact - extracted contact data
 * @param {string} contact.name - full name
 * @param {string} contact.firstName - first name (optional, extracted from name)
 * @param {string} contact.lastName - last name (optional, extracted from name)
 * @param {string} contact.email - email address
 * @param {string} contact.company - company name
 * @param {string} contact.phone - phone number
 * @param {string} contact.platform - social platform (for SOCIAL contacts)
 * @param {string} contact.username - social username (for SOCIAL contacts)
 * @param {string} contact.context - context from extract
 * @returns {string} merged template
 */
export function applyMailMerge(template, contact) {
  if (!template || !contact) return template || "";

  const nameParts = (contact.name || "").split(" ");
  const firstName = contact.firstName || nameParts[0] || "";
  const lastName = contact.lastName || nameParts.slice(1).join(" ") || "";

  return template
    // Name variables
    .replace(/\{\{firstName\}\}|\{\{first_name\}\}/g, firstName)
    .replace(/\{\{lastName\}\}|\{\{last_name\}\}/g, lastName)
    .replace(/\{\{name\}\}/g, contact.name || `${firstName} ${lastName}`.trim())
    // Contact variables
    .replace(/\{\{email\}\}/g, contact.email || "")
    .replace(/\{\{phone\}\}/g, contact.phone || "")
    // Business variables
    .replace(/\{\{company\}\}|\{\{businessName\}\}/g, contact.company || "")
    // Social variables
    .replace(/\{\{platform\}\}/g, contact.platform || "")
    .replace(/\{\{username\}\}/g, contact.username || "")
    // Context
    .replace(/\{\{context\}\}/g, contact.context || "");
}

/**
 * Apply mail merge to both subject and body.
 * @param {string} subject
 * @param {string} body
 * @param {object} contact
 * @returns {{ subject: string, body: string }}
 */
export function applyMailMergeToMessage(subject, body, contact) {
  return {
    subject: applyMailMerge(subject, contact),
    body: applyMailMerge(body, contact),
  };
}

/**
 * Get list of available template variables for UI display.
 * @returns {Array<{ variable: string, description: string }>}
 */
export function getAvailableVariables() {
  return [
    { variable: "{{firstName}}", description: "First name" },
    { variable: "{{lastName}}", description: "Last name" },
    { variable: "{{email}}", description: "Email address" },
    { variable: "{{company}}", description: "Company name" },
    { variable: "{{phone}}", description: "Phone number" },
    { variable: "{{context}}", description: "Context from extract" },
  ];
}

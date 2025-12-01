
// General-purpose keyboard navigation helper
/**
 * keyboardNavigate(page, {
 *   focusSelector: string,
 *   sequence: [
 *     { key: 'Tab'|'Enter'|'Space'|'Escape'|'ArrowRight'|..., delay?: ms },
 *     { type: 'type', value: 'some text', delay?: ms }
 *   ]
 * })
 */
export async function keyboardNavigate(page, { focusSelector, sequence = [] }) {
  if (focusSelector) {
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    }, focusSelector);
    await page.click(focusSelector);
    await new Promise(res => setTimeout(res, 300));
  }
  for (const action of sequence) {
    if (action.key) {
      await page.keyboard.press(action.key);
      await new Promise(res => setTimeout(res, action.delay || 150));
    } else if (action.type === 'type' && action.value) {
      await page.keyboard.type(action.value, { delay: 100 });
      await new Promise(res => setTimeout(res, action.delay || 200));
    }
  }
}

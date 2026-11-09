/**
 * The accessible name of a control whose visible words are not enough on their own, such as one of several
 * identical buttons in a list. The name starts with exactly the words on the control, so someone who speaks
 * what they see can press it (WCAG 2.5.3, label in name), and then says what it acts on.
 */
export function labelInName(visible: string, ...about: string[]) {
  const words = visible.trim();
  if (!words) throw new Error('A control needs visible words for its name to start with');
  const context = about.map((part) => part.trim()).filter(Boolean);
  return context.length ? `${words}: ${context.join(', ')}` : words;
}

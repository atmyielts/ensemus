'use client';

// Keeps what someone is working with in sight (WCAG 2.4.11).
// - A panel the person just opened near the bottom of the window is scrolled just enough to show what
//   it revealed. Only one they opened: a panel open when the page loads, or opened by a script, leaves
//   the page where it is.
// - Whatever takes keyboard focus is brought fully into view. A browser scrolls to a control that is out
//   of sight, but not to one that is only partly in view, such as the first field of a panel that has
//   just opened at the foot of the window. This happens as focus moves, so it is in view at once.
// Without JavaScript, panels still open and focus still moves.
import { useEffect } from 'react';

const partlyHidden = (element: Element) => {
  const box = element.getBoundingClientRect();
  if (box.height > innerHeight) return false;
  return box.top < 0 || box.bottom > innerHeight;
};

export function RevealOpenedPanels() {
  useEffect(() => {
    const reveal = (event: Event) => {
      const panel = event.target;
      if (!(panel instanceof HTMLDetailsElement) || !panel.open) return;
      // Its own summary has focus when the person opened it, by click or by keyboard.
      if (!panel.contains(document.activeElement)) return;
      // The mobile menu opens at the top of the page and is never scrolled to.
      if (panel.classList.contains('mobile-navigation')) return;
      panel.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    };
    const keepFocusInView = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && partlyHidden(target)) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    };
    // A toggle event does not bubble, so it is caught on its way down.
    document.addEventListener('toggle', reveal, true);
    document.addEventListener('focusin', keepFocusInView);
    return () => {
      document.removeEventListener('toggle', reveal, true);
      document.removeEventListener('focusin', keepFocusInView);
    };
  }, []);
  return null;
}

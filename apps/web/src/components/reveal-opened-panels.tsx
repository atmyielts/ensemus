'use client';

// When someone opens a panel near the bottom of the window, what it reveals would sit below the fold,
// and the first field in it would take keyboard focus out of sight. So a panel the person just opened
// is scrolled just enough to show it. Only one they opened: a panel that is open when the page loads, or
// one opened by a script, leaves the page where it is. Without JavaScript, panels still open.
import { useEffect } from 'react';

export function RevealOpenedPanels() {
  useEffect(() => {
    const reveal = (event: Event) => {
      const panel = event.target;
      if (!(panel instanceof HTMLDetailsElement) || !panel.open) return;
      // Its own summary has focus when the person opened it, by click or by keyboard.
      if (!panel.contains(document.activeElement)) return;
      // The mobile menu opens at the top of the page and is never scrolled to.
      if (panel.classList.contains('mobile-navigation')) return;
      // Instant, so the field that takes focus next is already in view.
      panel.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    };
    // A toggle event does not bubble, so it is caught on its way down.
    document.addEventListener('toggle', reveal, true);
    return () => document.removeEventListener('toggle', reveal, true);
  }, []);
  return null;
}

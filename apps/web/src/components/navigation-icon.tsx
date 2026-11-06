import type { NavigationIcon } from './navigation-model';

const PATHS: Record<NavigationIcon, string[]> = {
  home: ['m3 10 9-7 9 7', 'M5 9v11h5v-6h4v6h5V9'],
  work: ['M9 5V3h6v2', 'M4 5h16v15H4z', 'M4 10h16', 'M10 10v3h4v-3'],
  approvals: ['M8 3h8v4H8z', 'M8 5H5v16h14V5h-3', 'm8 14 3 3 5-6'],
  people: [
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M2 21v-3a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v3',
    'M17 4a4 4 0 0 1 0 7',
    'M19 14a5 5 0 0 1 3 4v3',
  ],
  clients: ['M3 21V5h11v16', 'M14 10h7v11', 'M6 9h5M6 13h5M6 17h5', 'M1 21h22'],
  inbox: ['m3 4-2 11v6h22v-6L21 4H3Z', 'M2 15h6l2 3h4l2-3h6'],
  studio: ['M13 2 4 14h7l-1 8 10-13h-8l1-7Z'],
  settings: [
    'm9 3-1 3-3 1-2 4 2 2-1 4 4 3 3-1 3 1 4-3-1-4 2-2-2-4-3-1-1-3H9Z',
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  ],
  connections: [
    'M9 15 7 17a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0',
    'm15 9 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    'm8 16 8-8',
  ],
  models: ['M12 3v3M12 18v3M3 12h3M18 12h3', 'M6 6h12v12H6z', 'M9 9h6v6H9z'],
  usage: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
  safety: ['m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z', 'M12 7v6M12 17h.01'],
  arrow: ['M5 12h14', 'm14 7 5 5-5 5'],
};

export function NavigationIcon({ name }: { name: NavigationIcon }) {
  return (
    <svg
      className="nav-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

/** PocketPilot mark: a phone outline with a navigation pointer. Same artwork as public/favicon.svg. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="PocketPilot">
      <defs>
        <linearGradient id="pp-logo-g" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5b97ff" />
          <stop offset="0.55" stopColor="#2f6fed" />
          <stop offset="1" stopColor="#1d4fc4" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#pp-logo-g)" />
      <rect x="20.5" y="9.5" width="23" height="45" rx="6.5" fill="none" stroke="#fff" strokeWidth="3" />
      <rect x="28" y="13.5" width="8" height="2.4" rx="1.2" fill="#fff" fillOpacity=".7" />
      <path d="M32 22.5 L41.2 43.5 L32 38.2 L22.8 43.5 Z" fill="#fff" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

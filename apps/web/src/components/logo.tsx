/** PocketPilot mark: three robots (one in front, two partners behind) — same artwork as public/favicon.svg. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="PocketPilot">
      <rect width="64" height="64" rx="15" fill="#2f6fed" />
      <rect x="3" y="31" width="21" height="21" rx="7" fill="#fff" />
      <rect x="41" y="27" width="21" height="25" rx="7" fill="#fff" />
      <g fill="#2f6fed"><circle cx="8" cy="40" r="2.4" /><circle cx="13" cy="40" r="2.4" /><circle cx="52" cy="37" r="2.4" /><circle cx="57" cy="37" r="2.4" /></g>
      <path d="M32 21V15" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" />
      <circle cx="32" cy="12" r="4.8" fill="#fff" />
      <rect x="18" y="21" width="28" height="31" rx="9.5" fill="#fff" stroke="#2f6fed" strokeWidth="2.6" />
      <circle cx="26.5" cy="37" r="4.6" fill="#2f6fed" /><circle cx="37.5" cy="37" r="4.6" fill="#2f6fed" />
    </svg>
  );
}

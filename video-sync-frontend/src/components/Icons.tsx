import React from 'react';
import { color, font } from '../theme';

// The app's whole icon set: minimal 24-grid line icons, 1.6px stroke,
// currentColor - so icons inherit text color and never fight the palette.
// Hand-kept instead of an icon library: ~20 icons do not justify a
// dependency, and a single stroke weight everywhere is the point.

type P = React.SVGProps<SVGSVGElement> & { size?: number };

const base = (
  { size = 18, ...rest }: P,
  children: React.ReactNode,
  filled = false,
) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke={filled ? 'none' : 'currentColor'}
    // optical compensation: 1.6/24 renders sub-pixel below ~14px, and thin
    // warm strokes erode further on a near-black ground
    strokeWidth={size <= 14 ? 2 : 1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

/** Filled: the one icon that must read instantly at any size. */
export const IconPlay = (p: P) =>
  base(p, <path d="M7 4.8c0-1 1.1-1.6 2-1.1l11 6.3c.9.5.9 1.8 0 2.3L9 18.6c-.9.5-2-.1-2-1.1V4.8z" />, true);

export const IconPause = (p: P) =>
  base(p, <><rect x="6" y="4" width="4" height="16" rx="1.2" /><rect x="14" y="4" width="4" height="16" rx="1.2" /></>, true);

export const IconUsers = (p: P) =>
  base(p, <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><path d="M15.5 5.4a3.2 3.2 0 0 1 0 5.2" /><path d="M17.8 14.9c1.5.7 2.5 2.2 2.8 4.1" /></>);

export const IconMic = (p: P) =>
  base(p, <><rect x="9.2" y="3.5" width="5.6" height="10" rx="2.8" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v2.5" /></>);

export const IconMicOff = (p: P) =>
  base(p, <><path d="M9.2 9.5v1.2a2.8 2.8 0 0 0 4.8 2" /><path d="M14.8 10V6.3a2.8 2.8 0 0 0-5.4-1" /><path d="M5.5 11.5a6.5 6.5 0 0 0 10.6 5" /><path d="M18.5 11.5c0 .8-.15 1.6-.42 2.3" /><path d="M12 18v2.5" /><path d="M4 4l16 16" /></>);

export const IconSettings = (p: P) =>
  base(p, <><path d="M4 7.5h9" /><path d="M17.5 7.5H20" /><circle cx="15" cy="7.5" r="2" /><path d="M4 16.5h2.5" /><path d="M11 16.5h9" /><circle cx="8.5" cy="16.5" r="2" /></>);

export const IconShare = (p: P) =>
  base(p, <><path d="M12 14.5V4" /><path d="M8.5 7.5L12 4l3.5 3.5" /><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" /></>);

export const IconLeave = (p: P) =>
  base(p, <><path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" /><path d="M10 12h10" /><path d="M16.5 8.5L20 12l-3.5 3.5" /></>);

export const IconCrown = (p: P) =>
  base(p, <path d="M4 8.5l4 3 4-6 4 6 4-3-1.2 8a1.5 1.5 0 0 1-1.5 1.3H6.7a1.5 1.5 0 0 1-1.5-1.3L4 8.5z" />);

export const IconSync = (p: P) =>
  base(p, <><path d="M20 12a8 8 0 0 1-14.6 4.5" /><path d="M4 12a8 8 0 0 1 14.6-4.5" /><path d="M18.5 3.5v4h-4" /><path d="M5.5 20.5v-4h4" /></>);

export const IconCopy = (p: P) =>
  base(p, <><rect x="9" y="9" width="11" height="11" rx="1.8" /><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8A1.5 1.5 0 0 1 14.5 5.5V6" /></>);

export const IconPlus = (p: P) =>
  base(p, <><path d="M12 5v14" /><path d="M5 12h14" /></>);

export const IconCheck = (p: P) =>
  base(p, <path d="M4.5 12.5l5 5L19.5 7" />);

export const IconX = (p: P) =>
  base(p, <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>);

export const IconGlobe = (p: P) =>
  base(p, <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5s1.2-6.2 3.6-8.5z" /></>);

export const IconLock = (p: P) =>
  base(p, <><rect x="5.5" y="10.5" width="13" height="9" rx="1.8" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>);

export const IconHeadphones = (p: P) =>
  base(p, <><path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" /><rect x="3.5" y="13.5" width="4" height="6.5" rx="1.6" /><rect x="16.5" y="13.5" width="4" height="6.5" rx="1.6" /></>);

export const IconHeadphonesOff = (p: P) =>
  base(p, <><path d="M4.5 14v-2c0-1.2.28-2.34.78-3.35" /><path d="M8.2 5.5A7.47 7.47 0 0 1 19.5 12v2" /><rect x="3.5" y="13.5" width="4" height="6.5" rx="1.6" /><rect x="16.5" y="13.5" width="4" height="6.5" rx="1.6" /><path d="M4 4l16 16" /></>);

export const IconVolume = (p: P) =>
  base(p, <><path d="M11 5.5 6.8 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.8L11 18.5a.6.6 0 0 0 1-.46V5.96a.6.6 0 0 0-1-.46z" /><path d="M15.4 9.2a4 4 0 0 1 0 5.6" /><path d="M18.2 6.6a8 8 0 0 1 0 10.8" /></>);

/** Muted: the same speaker, struck through - one shape, two states. */
export const IconVolumeOff = (p: P) =>
  base(p, <><path d="M11 5.5 6.8 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.8L11 18.5a.6.6 0 0 0 1-.46V5.96a.6.6 0 0 0-1-.46z" /><path d="M16 10l4 4" /><path d="M20 10l-4 4" /></>);

export const IconFullscreen = (p: P) =>
  base(p, <><path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9" /><path d="M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9" /><path d="M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15" /><path d="M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15" /></>);

/** Arrows turned inward: the same corners, pointing the other way. */
export const IconExitFullscreen = (p: P) =>
  base(p, <><path d="M9 4v3.4A1.6 1.6 0 0 1 7.4 9H4" /><path d="M20 9h-3.4A1.6 1.6 0 0 1 15 7.4V4" /><path d="M15 20v-3.4a1.6 1.6 0 0 1 1.6-1.6H20" /><path d="M4 15h3.4A1.6 1.6 0 0 1 9 16.6V20" /></>);

export const IconFilm = (p: P) =>
  base(p, <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M3.5 9.5L20.5 9.5" /><path d="M7.5 5.2L9.8 9.4" /><path d="M12.4 5.2l2.3 4.2" /><path d="M17.3 5.2l2.3 4.2" /></>);

/**
 * The one icon that breaks every rule above - filled, four fixed colors, no
 * currentColor - because it is not ours to restyle. Google's branding
 * guidelines require their mark as issued on a "Continue with Google"
 * control, so a tasteful monochrome version in our stroke weight would be
 * the WRONG call here, not the considerate one.
 */
export const IconGoogle = ({ size = 18, ...rest }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    aria-hidden="true"
    {...rest}
  >
    <path
      fill="#4285F4"
      d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
    />
    <path
      fill="#34A853"
      d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
    />
    <path
      fill="#FBBC05"
      d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
    />
    <path
      fill="#EA4335"
      d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
    />
  </svg>
);

/**
 * The wordmark. Text-only on purpose: the domain IS the brand -
 * "mustard" in the room's off-white, ".watch" in mustard.
 */
export const Wordmark: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <span
    style={{
      fontFamily: font.display,
      fontWeight: 800,
      fontSize: size,
      letterSpacing: '-0.01em',
      lineHeight: 1,
      color: color.text,
      whiteSpace: 'nowrap',
    }}
  >
    mustard<span style={{ color: color.mustard }}>.watch</span>
  </span>
);

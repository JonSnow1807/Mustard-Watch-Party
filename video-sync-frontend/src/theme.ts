// The Mustard house style - one token set, imported by every styled block.
// A screening room, measured: warm near-black surfaces (a cinema, not a
// void), one mustard accent doing all the accent work, and mono numerals
// wherever a number is a measurement (drift, RTT, room codes). No
// gradients-as-personality, no emoji-as-iconography, no invented claims
// in copy - the measured numbers ARE the marketing.

export const color = {
  // surfaces, warmest-to-brightest
  bg0: '#0F0D0A', // page
  bg1: '#171410', // cards / panels
  bg2: '#201B14', // raised, hovered, inputs
  bg3: '#2A241B', // pressed / selected
  line: '#2C261D', // hairline borders
  lineBright: '#3D3527', // hovered borders / dividers with intent

  // text, warm off-whites - never pure #fff on dark
  text: '#F0EADD',
  dim: '#A89E8B',
  faint: '#8E846F', // AA on bg0/bg1/bg2 (5.25/4.97/4.62:1) - the critique panel's floor

  // the accent. mustard is the brand; it is the ONLY saturated hue in the
  // chrome, so it always means "this matters / this acts"
  mustard: '#E9B44C',
  mustardBright: '#F6C763', // hover
  mustardDeep: '#8A6B21', // tint borders, focus halo
  mustardFaint: 'rgba(233, 180, 76, 0.10)', // tint fills
  mustardInk: '#191204', // text on mustard fills

  // status - muted, warm-adjacent so they sit in the same room
  ok: '#93BC7E',
  okFaint: 'rgba(147, 188, 126, 0.12)',
  danger: '#DB6E4F',
  dangerFaint: 'rgba(219, 110, 79, 0.12)',
} as const;

export const font = {
  display: `'Bricolage Grotesque', 'Inter', system-ui, sans-serif`,
  body: `'Inter', system-ui, -apple-system, sans-serif`,
  mono: `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
} as const;

export const radius = {
  sm: '6px', // small controls, chips
  md: '10px', // cards, inputs, buttons
  lg: '14px', // page-level panels, the player
  pill: '999px',
} as const;

/** Focus ring: mustard halo separated from the control by page color. */
export const focusRing = `0 0 0 2px ${color.bg0}, 0 0 0 4px ${color.mustardDeep}`;

/**
 * Reusable css fragments (plain strings for emotion template interpolation).
 * Buttons deliberately do NOT translateY on hover - state changes read
 * through color and border, not through furniture that jumps.
 */
export const button = {
  primary: `
    font-family: ${font.body};
    font-size: 14px;
    font-weight: 600;
    color: ${color.mustardInk};
    background: ${color.mustard};
    border: 1px solid ${color.mustard};
    border-radius: ${radius.md};
    padding: 10px 18px;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    &:hover { background: ${color.mustardBright}; border-color: ${color.mustardBright}; }
    &:focus-visible { outline: none; box-shadow: ${focusRing}; }
    &:disabled { background: ${color.bg3}; border-color: ${color.bg3}; color: ${color.faint}; cursor: not-allowed; }
  `,
  secondary: `
    font-family: ${font.body};
    font-size: 14px;
    font-weight: 500;
    color: ${color.text};
    background: transparent;
    border: 1px solid ${color.lineBright};
    border-radius: ${radius.md};
    padding: 10px 18px;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    &:hover { background: ${color.bg2}; border-color: ${color.faint}; }
    &:focus-visible { outline: none; box-shadow: ${focusRing}; }
    &:disabled { color: ${color.faint}; border-color: ${color.line}; cursor: not-allowed; }
  `,
  danger: `
    font-family: ${font.body};
    font-size: 14px;
    font-weight: 500;
    color: ${color.danger};
    background: transparent;
    border: 1px solid ${color.line};
    border-radius: ${radius.md};
    padding: 10px 18px;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    &:hover { background: ${color.dangerFaint}; border-color: ${color.danger}; }
    &:focus-visible { outline: none; box-shadow: ${focusRing}; }
    &:disabled { color: ${color.faint}; border-color: ${color.line}; background: transparent; cursor: not-allowed; }
  `,
} as const;

/**
 * Size modifier for compact buttons in dense chrome (top bars, panel
 * headers, chat send). Compose AFTER a button fragment:
 *   styled.button`${button.secondary} ${buttonSm}`
 */
export const buttonSm = `
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 13px;
  white-space: nowrap;
`;

/**
 * Chips: the app's smallest labelled surface. Two scales, because the two
 * densities are load-bearing - `sm` sits in status rows beside 11-12px
 * readouts, `md` matches the sm-button rhythm so a chip-button can swap
 * places with a real button without the row resizing.
 *
 * Then one of the two border grammars: `chipStatic` states a fact and has
 * no hover; `chipInteractive` is a control - it rests brighter, hovers
 * toward mustard, and takes focus. Colors are layered per instance after.
 */
export const chip = {
  sm: `
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: ${radius.pill};
    font-family: ${font.body};
    font-size: 11px;
    white-space: nowrap;
  `,
  md: `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: ${radius.pill};
    font-family: ${font.body};
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  `,
} as const;

export const chipStatic = `
  border: 1px solid ${color.line};
  background: ${color.bg2};
  color: ${color.dim};
`;

export const chipInteractive = `
  border: 1px solid ${color.lineBright};
  background: ${color.bg2};
  color: ${color.dim};
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  &:hover { border-color: ${color.mustardDeep}; color: ${color.text}; }
  &:focus-visible { outline: none; box-shadow: ${focusRing}; }
`;

/** Caps-labelled chips (LIVE, HOST, counts) - a measurement, so mono. */
export const chipMono = `
  font-family: ${font.mono};
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
`;

/** 28px square, icon-only, quiet until hovered. */
export const ghostIconButton = `
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: ${radius.sm};
  color: ${color.faint};
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
  &:hover { color: ${color.text}; background: ${color.bg2}; }
  &:focus-visible { outline: none; box-shadow: ${focusRing}; }
`;

export const input = `
  font-family: ${font.body};
  font-size: 14px;
  color: ${color.text};
  background: ${color.bg2};
  border: 1px solid ${color.line};
  border-radius: ${radius.md};
  padding: 10px 14px;
  width: 100%;
  transition: border-color 120ms ease;
  &::placeholder { color: ${color.faint}; }
  &:hover { border-color: ${color.lineBright}; }
  &:focus { outline: none; border-color: ${color.mustardDeep}; box-shadow: ${focusRing}; }
  &:disabled { color: ${color.faint}; background: ${color.bg1}; cursor: not-allowed; }
`;

export const card = `
  background: ${color.bg1};
  border: 1px solid ${color.line};
  border-radius: ${radius.lg};
`;

/** Section label: small caps tracking, the app's "engineering label" voice. */
export const sectionLabel = `
  font-family: ${font.body};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${color.faint};
`;

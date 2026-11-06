// Scrappy Yard's hand-authored UI icons: small inline SVGs in the junkyard palette (hazard yellow, rust, steel, ink
// outlines) that replace the emoji the HUD, help and menu used to borrow from the system font (owner, 2026-11-05: "stop using
// emojis like the robot and properly generate icons"). Each is a 24×24 viewBox drawn with a dark outline so it reads on the
// dark HUD pills and on bright sky alike. `icon(name)` returns the markup; size it with CSS (width/height on `.sd-svg`).

const INK = "#15110d";
const HAZ = "#ffc21a";
const RUST = "#c9561c";
const RUST_LO = "#6e2a10";
const STEEL = "#7b858d";
const STEEL_HI = "#c3ccd3";
const STEEL_LO = "#3c4248";
const RED = "#ff3b5c";
const CYAN = "#48f0ff";

/** A checkered finish flag on a steel pole. */
function flag() {
  const cells: string[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) if ((r + c) % 2 === 0) cells.push(`<rect x="${6.5 + c * 3}" y="${3.5 + r * 3}" width="3" height="3" fill="${INK}"/>`);
  return `<rect x="6.5" y="3.5" width="15" height="9" fill="#f4efe6"/>${cells.join("")}` +
    `<rect x="6.5" y="3.5" width="15" height="9" fill="none" stroke="${INK}" stroke-width="1.4"/>` +
    `<path d="M5 2.5v19" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/><path d="M5 2.8v18.4" stroke="${STEEL_HI}" stroke-width="1.3" stroke-linecap="round"/>`;
}

/** The junk mech's head: riveted steel box, red visor eyes, jaw grille, antenna lamp. */
function mech() {
  return `<path d="M12 5V2.6" stroke="${INK}" stroke-width="2"/><circle cx="12" cy="2.4" r="1.7" fill="${RED}" stroke="${INK}" stroke-width="1"/>` +
    `<rect x="1" y="10" width="3" height="5.5" rx="1" fill="${RUST}" stroke="${INK}" stroke-width="1.2"/><rect x="20" y="10" width="3" height="5.5" rx="1" fill="${RUST}" stroke="${INK}" stroke-width="1.2"/>` +
    `<rect x="3.5" y="5" width="17" height="16" rx="2.6" fill="${STEEL}" stroke="${INK}" stroke-width="1.8"/>` +
    `<path d="M5 8.2V7.4c0-.8.6-1.4 1.4-1.4h11.2c.8 0 1.4.6 1.4 1.4v.8z" fill="${STEEL_HI}" opacity="0.55"/>` +
    `<circle cx="6.2" cy="7.6" r="0.8" fill="${STEEL_LO}"/><circle cx="17.8" cy="7.6" r="0.8" fill="${STEEL_LO}"/>` +
    `<rect x="5.6" y="9.4" width="12.8" height="4.8" rx="1.2" fill="#2a0d10" stroke="${INK}" stroke-width="1.2"/>` +
    `<rect x="7" y="10.8" width="3.8" height="2" rx="0.6" fill="${RED}"/><rect x="13.2" y="10.8" width="3.8" height="2" rx="0.6" fill="${RED}"/>` +
    `<rect x="7.5" y="15.8" width="9" height="3.4" rx="0.6" fill="${STEEL_LO}" stroke="${INK}" stroke-width="1"/>` +
    `<path d="M10 16v3M12 16v3M14 16v3" stroke="${STEEL_HI}" stroke-width="0.9"/>`;
}

/** A rusty oil drum with a hazard-striped band. */
function barrel() {
  return `<path d="M5 4.5C5 3.1 8.1 2 12 2s7 1.1 7 2.5v15c0 1.4-3.1 2.5-7 2.5s-7-1.1-7-2.5z" fill="${RUST}" stroke="${INK}" stroke-width="1.6"/>` +
    `<rect x="5.8" y="10" width="12.4" height="4" fill="${HAZ}"/>` +
    `<path d="M6 14l2-4h2l-2 4zM10 14l2-4h2l-2 4zM14 14l2-4h2l-2 4z" fill="${INK}"/>` +
    `<path d="M5 8c0 1.2 3.1 2 7 2s7-.8 7-2M5 16c0 1.2 3.1 2 7 2s7-.8 7-2" fill="none" stroke="${RUST_LO}" stroke-width="1.3"/>` +
    `<ellipse cx="12" cy="4.5" rx="6.2" ry="1.8" fill="#e07a3c" stroke="${INK}" stroke-width="1.1"/><circle cx="9.6" cy="4.4" r="0.9" fill="${STEEL_LO}"/>`;
}

/** A wrecked car, side on: rusty red shell, cyan glass, black tyres. */
function car() {
  return `<path d="M1.8 16.2v-3.4c0-.8.5-1.4 1.3-1.6l3.3-.8 2.6-3.6c.4-.5 1-.8 1.6-.8h5.4c.7 0 1.3.3 1.7.9l2.4 3.4 1.5.4c.8.2 1.4.9 1.4 1.7v3.8z" fill="#b8321c" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="M8.4 11l2-2.9h2.7V11zM14.5 8.1h1.8c.4 0 .7.2.9.5l1.7 2.4h-4.4z" fill="${CYAN}" fill-opacity="0.85" stroke="${INK}" stroke-width="1"/>` +
    `<circle cx="5" cy="13.6" r="1.1" fill="${RUST_LO}"/><circle cx="13.5" cy="14.2" r="0.8" fill="${RUST_LO}"/><path d="M2 13.4h2.2" stroke="${HAZ}" stroke-width="1.2"/>` +
    `<circle cx="7" cy="17.2" r="3" fill="${INK}"/><circle cx="7" cy="17.2" r="1.2" fill="${STEEL}"/>` +
    `<circle cx="17.4" cy="17.2" r="3" fill="${INK}"/><circle cx="17.4" cy="17.2" r="1.2" fill="${STEEL}"/>`;
}

/** A hole torn in the deck plate, rimmed in hazard yellow. */
function gap() {
  return `<rect x="1.5" y="5" width="21" height="14" rx="1.6" fill="${STEEL}" stroke="${INK}" stroke-width="1.6"/>` +
    `<circle cx="3.8" cy="7.2" r="0.8" fill="${STEEL_LO}"/><circle cx="20.2" cy="7.2" r="0.8" fill="${STEEL_LO}"/><circle cx="3.8" cy="16.8" r="0.8" fill="${STEEL_LO}"/><circle cx="20.2" cy="16.8" r="0.8" fill="${STEEL_LO}"/>` +
    `<path d="M5.5 8.5l3 1.2 2.4-1.4 3 1.6 2.6-1.2 2 .8-.6 3 .8 3.2-2.6-.4-2.4 1.4-3-1.2-2.6 1.1-2-.9.5-3z" fill="#0b0806" stroke="${HAZ}" stroke-width="1.3" stroke-linejoin="round"/>`;
}

/** A radar dish with a signal. */
function radar() {
  return `<path d="M4 21h11" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/><path d="M9.5 21l1.4-5" stroke="${STEEL_LO}" stroke-width="2.2"/>` +
    `<path d="M3.2 7.6a8.5 8.5 0 0 0 11.6 11.6z" fill="${STEEL_HI}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="M9 13.4l4.2-4.2" stroke="${INK}" stroke-width="1.4"/><circle cx="13.6" cy="8.8" r="1.5" fill="${RED}" stroke="${INK}" stroke-width="1"/>` +
    `<path d="M16 6.4a3.2 3.2 0 0 1 1.8 1.8M17 3.2a6.5 6.5 0 0 1 4 4" fill="none" stroke="${CYAN}" stroke-width="1.7" stroke-linecap="round"/>`;
}

/** Slide left / right. */
function move() {
  return `<path d="M1.8 12l5.2-5.2v3.2h10V6.8l5.2 5.2-5.2 5.2V14H7v3.2z" fill="${HAZ}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>`;
}

/** Jump: an arrow up off a steel plate. */
function jump() {
  return `<path d="M12 1.8l6.4 7.2h-3.7v6.4H9.3V9H5.6z" fill="${HAZ}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<rect x="3" y="18" width="18" height="3.6" fill="${STEEL}" stroke="${INK}" stroke-width="1.4"/><path d="M6 21.6l2-3.6M11 21.6l2-3.6M16 21.6l2-3.6" stroke="${STEEL_LO}" stroke-width="1.2"/>`;
}

/** A cog (options, gym toggles). Fills with currentColor so it follows the plate's hover colours. */
function gear() {
  const teeth = 8, ro = 10.6, ri = 8, pts: string[] = [];
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2 + Math.PI / (teeth * 4);
    const r = i % 4 < 2 ? ro : ri;
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  // The hub is a real hole (evenodd), so the plate behind shows through whatever colour the cog takes.
  return `<path d="M${pts.join("L")}Z M15.6 12a3.6 3.6 0 1 0-7.2 0a3.6 3.6 0 1 0 7.2 0Z" fill="currentColor" fill-rule="evenodd" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>`;
}

/** Play: a stamped triangle (currentColor). */
function play() {
  return `<path d="M7.5 4.2v15.6L20 12z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
}

/** Edit: a pencil (currentColor). */
function pencil() {
  return `<path d="M15.2 3.6l5.2 5.2L9.2 20H4v-5.2z" fill="currentColor"/><path d="M13.2 5.6l5.2 5.2" stroke="#fff3a8" stroke-width="1.6"/><path d="M4 20v-3.4L7.4 20z" fill="#fff3a8"/>`;
}

/** Save: a check mark (currentColor). */
function check() {
  return `<path d="M4 12.8l5 5L20.2 6.4" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Pause: two stamped bars (currentColor). */
function pause() {
  return `<rect x="5" y="4" width="5" height="16" rx="1.2" fill="currentColor"/><rect x="14" y="4" width="5" height="16" rx="1.2" fill="currentColor"/>`;
}

const DRAW = { flag, mech, barrel, car, gap, radar, move, jump, gear, play, pencil, check, pause } as const;
export type IconName = keyof typeof DRAW;

const cache = new Map<IconName, string>();

/** Inline SVG markup for one icon (decorative: aria-hidden). */
export function icon(name: IconName, cls = "") {
  let body = cache.get(name);
  if (body === undefined) cache.set(name, (body = DRAW[name]()));
  return `<svg class="sd-svg sd-svg-${name}${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Hazard kinds as the sim numbers them (1 barrel, 2 car, 3 gap) → icon. */
export const HAZARD_ICON: readonly (IconName | null)[] = [null, "barrel", "car", "gap"];

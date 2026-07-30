import { MAX_SIGIL_CHARS, MAX_SIGIL_COLUMNS, MAX_SIGIL_LINES, normalizeAsciiArt } from './profile';

const MAX_CRYPTID_NAME_LENGTH = 24;
/** Below these, whatever the model drew was mostly characters we had to throw away. */
const MIN_SIGIL_INK = 6;
const MIN_SIGIL_LINES = 2;

/**
 * Characters small on-device models reach for when asked to draw, grouped by the closest
 * single-cell ASCII equivalent. Substituting one glyph for one character keeps the columns of a
 * monospaced drawing aligned; dropping them outright would shear the silhouette.
 */
const GLYPH_GROUPS: readonly (readonly [string, string])[] = [
  ['─━┄┅┈┉╌╍╴╶╸╺▔¬⌐', '-'],
  ['═≡≠', '='],
  ['│┃┆┇┊┋╎╏║▕╵╷¦', '|'],
  ['┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┤┬┴┼╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬', '+'],
  ['╭╯╱⁄÷', '/'],
  ['╮╰╲', '\\'],
  ['╳', 'X'],
  ['█▉▊▋▌▍▎▏▐▀▄▓■◼▖▗▘▙▚▛▜▝▞▟', '#'],
  ['▒', ':'],
  ['░▪▫·‧・‥', '.'],
  ['●○◎◌◍◦°¤', 'o'],
  ['◯⬤', 'O'],
  ['□▢', '['],
  ['•∙◆◇◊♦♥♡★☆✦✧✻✹', '*'],
  ['▲△∧ˆ↑', '^'],
  ['▼▽∨↓√', 'v'],
  ['▶▷→', '>'],
  ['◀◁←', '<'],
  ['×✕✖', 'x'],
  ['≈∼˜', '~'],
  ['∞', '8'],
  ['§', 'S'],
  ['µ', 'u'],
];

const GLYPH_REPLACEMENTS = new Map<string, string>();
for (const [glyphs, replacement] of GLYPH_GROUPS) {
  for (const glyph of glyphs) GLYPH_REPLACEMENTS.set(glyph, replacement);
}

function replaceGlyph(character: string): string {
  const mapped = GLYPH_REPLACEMENTS.get(character);
  if (mapped !== undefined) return mapped;
  // Fullwidth forms sit a fixed offset above their ASCII twins.
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return ' ';
}

function toAscii(value: string): string {
  return value.replace(/[^\t\n\x20-\x7e]/gu, replaceGlyph);
}

/**
 * True for a line that reads as commentary rather than drawing.
 *
 * Deliberately conservative: it must contain at least two word-shaped runs, where a word is a
 * letter run of three or more characters built from at least three *distinct* letters. Repeated
 * glyphs are how art draws wings and legs, so `WWWW    WWWW`, `ooooo   ooooo` and `vvvv    vvvv`
 * are art, not prose, even though they are made only of letters and spaces.
 */
function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 12) return false;
  // Anything carrying art punctuation is never commentary.
  if (!/^[a-z0-9 ,.:;!?'"-]+$/i.test(trimmed)) return false;
  const words = trimmed
    .match(/[a-z]{3,}/gi)
    ?.filter((word) => new Set(word.toLowerCase()).size >= 3);
  return (words?.length ?? 0) >= 2;
}

function dropEdgeNoise(lines: readonly string[]): string[] {
  const result = [...lines];
  const isNoise = (line: string): boolean => line.trim().length === 0 || isProseLine(line);
  while (result.length > 0 && isNoise(result[0])) result.shift();
  while (result.length > 0 && isNoise(result[result.length - 1])) result.pop();
  return result;
}

function dedent(lines: readonly string[]): string[] {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return shared > 0 ? lines.map((line) => line.slice(shared)) : [...lines];
}

function widestLine(lines: readonly string[]): number {
  return lines.reduce((widest, line) => Math.max(widest, line.length), 0);
}

function changed(next: readonly string[], previous: readonly string[]): boolean {
  return next.length !== previous.length || next.some((line, index) => line !== previous[index]);
}

export interface SigilRepairResult {
  sigil: string;
  /** Human-readable notes about what had to be fixed, for the event log. */
  repairs: readonly string[];
}

/**
 * Turns whatever the on-device model drew into art that fits the profile tile.
 *
 * The system models are small and, on Android, generate without any constrained decoding, so
 * their output is *nearly* right far more often than it is exactly right: a stray box-drawing
 * glyph, a line two columns too wide, a code fence, a "Here you go:" preamble. Rejecting on any
 * of those means the offline maker wins almost every time, so this repairs what it can and
 * leaves only the genuinely unusable for the caller to reject.
 */
export function repairSigil(value: string): SigilRepairResult {
  const repairs: string[] = [];
  let text = normalizeAsciiArt(value);

  const withoutFences = text.replace(/^[ \t]*```[a-z0-9]*[ \t]*$/gim, '');
  if (withoutFences !== text) {
    repairs.push('removed markdown code fences');
    text = withoutFences;
  }

  const transliterated = toAscii(text);
  if (transliterated !== text) {
    repairs.push('replaced non-ASCII drawing characters');
    text = transliterated;
  }

  let lines = text.split('\n').map((line) => line.replace(/\t/g, '  ').replace(/\s+$/, ''));

  const withoutNoise = dropEdgeNoise(lines);
  if (changed(withoutNoise, lines)) repairs.push('removed blank lines and commentary');
  lines = withoutNoise;

  // Interior blank lines are stray output far more often than composition, and each one costs a
  // line of a tight budget.
  const withoutGaps = lines.filter((line) => line.trim().length > 0);
  if (changed(withoutGaps, lines)) repairs.push('closed gaps between art lines');
  lines = withoutGaps;

  const dedented = widestLine(lines) > MAX_SIGIL_COLUMNS ? dedent(lines) : lines;
  if (changed(dedented, lines)) repairs.push('removed the shared indent');
  lines = dedented;

  const clipped = lines.map((line) => line.slice(0, MAX_SIGIL_COLUMNS).replace(/\s+$/, ''));
  if (changed(clipped, lines)) repairs.push('shortened over-wide lines');
  lines = clipped.filter((line) => line.trim().length > 0);

  if (lines.length > MAX_SIGIL_LINES) {
    repairs.push('trimmed extra lines');
    lines = lines.slice(0, MAX_SIGIL_LINES);
  }
  while (lines.length > 1 && lines.join('\n').length > MAX_SIGIL_CHARS) {
    lines.pop();
    if (!repairs.includes('trimmed extra lines')) repairs.push('trimmed extra lines');
  }

  return { sigil: lines.join('\n'), repairs };
}

export interface NameRepairResult {
  name: string;
  /** Human-readable notes about what had to be fixed, for the event log. */
  repairs: readonly string[];
}

/** Strips the labels, quoting, markdown, and trailing punctuation models wrap names in. */
export function repairCryptidName(value: string): NameRepairResult {
  const repairs: string[] = [];
  const firstLine =
    normalizeAsciiArt(value)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  let name = toAscii(firstLine)
    .replace(/^(?:the\s+)?(?:name|cryptid)\s*[:-]\s*/i, '')
    .replace(/[*_`]/g, '')
    .replace(/^["'([]+|["')\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim();

  if (name.length > MAX_CRYPTID_NAME_LENGTH) {
    const cut = name.slice(0, MAX_CRYPTID_NAME_LENGTH + 1);
    const lastSpace = cut.lastIndexOf(' ');
    name = (
      lastSpace > 3 ? cut.slice(0, lastSpace) : name.slice(0, MAX_CRYPTID_NAME_LENGTH)
    ).trim();
    repairs.push('shortened the name');
  } else if (name !== value.trim()) {
    repairs.push('tidied the name');
  }

  return { name, repairs };
}

/** True when the repaired art still has enough drawing left in it to be worth showing. */
export function sigilHasEnoughInk(sigil: string): boolean {
  const lines = sigil.split('\n').filter((line) => line.trim().length > 0);
  return lines.length >= MIN_SIGIL_LINES && sigil.replace(/\s/g, '').length >= MIN_SIGIL_INK;
}

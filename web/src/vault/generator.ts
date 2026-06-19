// Strong password + passphrase generator. Uses crypto.getRandomValues for unbiased randomness.
import { randomBytes } from './crypto';

const LOWER = 'abcdefghijkmnpqrstuvwxyz'; // no l/o (ambiguous)
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O
const DIGITS = '23456789'; // no 0/1
const SYMBOLS = '!@#$%^&*-_=+?';

export type PasswordOpts = { length: number; symbols: boolean; numbers: boolean; uppercase: boolean };
export const DEFAULT_PW_OPTS: PasswordOpts = { length: 20, symbols: true, numbers: true, uppercase: true };

/** Pick a uniformly-random index < max using rejection sampling (no modulo bias). Handles any max up to 2^32. */
function randIndex(max: number): number {
  if (max <= 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max; // largest multiple of max that fits in a uint32
  for (;;) {
    const b = randomBytes(4);
    const v = b[0] * 0x1000000 + b[1] * 0x10000 + b[2] * 0x100 + b[3];
    if (v < limit) return v % max;
  }
}

function pick(pool: string): string {
  return pool[randIndex(pool.length)];
}

export function generatePassword(opts: PasswordOpts = DEFAULT_PW_OPTS): string {
  const sets = [LOWER];
  if (opts.uppercase) sets.push(UPPER);
  if (opts.numbers) sets.push(DIGITS);
  if (opts.symbols) sets.push(SYMBOLS);
  const pool = sets.join('');
  const len = Math.max(8, Math.min(64, opts.length));
  // Guarantee at least one char from each enabled set, then fill, then shuffle.
  const chars = sets.map((s) => pick(s));
  while (chars.length < len) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// A small, friendly wordlist for memorable passphrases (EFF-style short list, trimmed).
const WORDS = (
  'able acid aged also area army away baby back ball band bank base bath bear beat been beer bell belt best bird blue boat body bone book boot born boss both bowl bulk burn bush busy cake call calm came camp card care cart case cash cave cell chat chef chip city clay clip club coal coat code coin cold come cook cool cope copy core corn cost crew crop dark data date dawn days dead deal dear debt deck deep deer desk dial diet dirt dish dock does dome done door dose down draw drop drum dual duke dust duty earn ease east easy edge else even ever face fact fade fail fair fall farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish five flag flat flow folk font food foot ford form fort frog fuel full fund gain game gate gear gift girl give glad goal goat gold golf gone good gray grew grid grip grow gulf hair half hall hand hang hard harm hawk head heat held hell helm herb hero hill hint hire hold hole holy home hood hook hope horn host hour huge hull hunt idea inch iron item jade jail jazz jeep join jump june jury just keen keep kept kick kind king kiss kite knee knew knot know lace lack lady lake lamp land lane last late lawn lazy lead leaf leak lean left lens lift like lime line link lion list live load loan lock loft lone long look loop lord lose loss lost loud love luck lump lung mail main make male mall malt many maps mark mass mate math maze meal mean meat meet melt menu mere mesh mild mile milk mill mind mine mint miss mist mode mold mole monk mood moon more moss most moth move much mule muse must myth nail name navy near neat neck need nest news next nice nick node none noon nose note noun oath obey okay once only onto open oral oval oven over pace pack page paid pain pair pale palm park part pass past path peak pear peer perk pest pick pile pine pink pint pipe plan play plot plug plus poem poet poke pole poll pond pony pool poor port pose post pour pray prep prey prim prop pull pulp pump pure push quit race rack rage raid rail rain rake ramp rang rank rare rate read real reap rear reed reef rely rent rest rice rich ride ring riot rise risk road roar robe rock role roll roof room root rope rose ruby rule rush rust sack safe said sail salt same sand save scan seal seam seat seed seek seem seen self sell semi send sent ship shoe shop shot show shut sick side sign silk sing sink site size skin skip slab slam slid slim slip slot slow snap snow soak soap soar sock soda sofa soft soil sold sole some song soon sort soul soup sour spin spot spur stay stem step stir stop stub such suit sums sung sure surf swam swan swap sway swim tail tale talk tall tank tape task taxi teak team tear tech teen tell tend tent term test text than that them then they thin this thus tick tide tidy tied tier tile till time tiny tire toad toll tomb tone took tool toot torn tour town trap tray tree trim trip true tube tuck tide tune turf turn twin type unit upon urge used user vain vary vast veil vein verb very vest veto vibe view vine visa void volt vote wade wage wait wake walk wall wand want ward ware warm warn wash wave wear weed week well went were west what when whip whom wide wife wild will wind wine wing wink wire wise wish wolf wood wool word wore work worm worn wrap yard yarn yawn year yell yoga zero zone zoom'
).split(' ');

export function generatePassphrase(words = 4, separator = '-'): string {
  const out: string[] = [];
  for (let i = 0; i < Math.max(3, Math.min(8, words)); i++) out.push(WORDS[randIndex(WORDS.length)]);
  // sprinkle a number so it satisfies "must contain a digit" policies
  return out.join(separator) + separator + (randIndex(90) + 10);
}

// ---- weak / reused detection (local only) ----
/** SHA-256 hex of a string — used to compare passwords for reuse WITHOUT keeping them around. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await (globalThis as any).crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isWeakPassword(pw: string): boolean {
  if (!pw || pw.length < 10) return true;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  return classes < 2;
}

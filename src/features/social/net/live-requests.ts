/**
 * The live-mode request channel — pure logic (docs/social/ARCHITECTURE.md §9c).
 *
 * A watcher asks a friend to switch to the real-time cadence by writing an encrypted
 * {@link NativeControlMsg} into its OWN trail namespace, which the friend already replicates. The
 * friend discovers it by polling. There is deliberately no push wake, so nothing in this flow
 * uploads a device identifier anywhere — see the §10 threat-model note on push tokens.
 *
 * A request from someone we already share with just works: no prompt, no notification, no
 * per-friend toggle — the same as Life360 / Find My. See {@link EvaluateContext.isSharing} for why
 * sharing is sufficient authorisation. What bounds it is the TTL and the ability to stop.
 *
 * Everything here is pure and injectable so the security-relevant decisions — freshness, dedup,
 * authorisation — are unit-testable without a node, a clock, or a device.
 *
 * ## Why the validation below is not paranoia
 * There is exactly ONE control slot per author and writing overwrites it. That gives clean
 * latest-wins semantics, but it also means a replica (the stash, or any pool member) can simply
 * *withhold an update* and keep serving an old entry. So a received message proves only "this
 * author wrote this at some point", never "this author wants this now". {@link evaluateControlMsg}
 * closes that gap with a freshness window plus nonce dedup, and the dedup record has to be
 * PERSISTED — otherwise every poll inside the freshness window (and every restart) would re-arm
 * from the same entry, silently extending a session well past the window the watcher asked for.
 */

import { CTL_KIND_LIVE_CANCEL, CTL_KIND_LIVE_REQUEST, type NativeControlMsg } from 'iroh-location';

import { bytesToHex, isHex } from '../core/hex';

/** Wire version we emit and the only one we accept. */
export const CONTROL_WIRE_VERSION = 1;

/** Nonce length in bytes; 128 bits of dedup identity. */
export const CONTROL_NONCE_BYTES = 16;

/**
 * How old a control message may be and still be acted on. Bounds how long a withheld-update
 * replay stays dangerous, and must comfortably exceed the poll interval or legitimate requests
 * would expire before the subject ever looked.
 */
export const LIVE_REQUEST_FRESHNESS_MS = 10 * 60_000;

/** Tolerance for a sender's clock running fast. Beyond this a future `ts` is refused outright. */
export const LIVE_REQUEST_CLOCK_SKEW_MS = 60_000;

/** Bounds on the live window a watcher may ask for. The subject always clamps: the TTL is what
 * bounds live mode in place of a prompt, so an attacker-chosen `ttlMs` must never be honoured. */
export const LIVE_TTL_MIN_MS = 60_000;
export const LIVE_TTL_MAX_MS = 30 * 60_000;
export const LIVE_TTL_DEFAULT_MS = 15 * 60_000;

/** Injectable random-byte source; mirrors `RandomBytesFn` in `core/pairing-code.ts`. */
export type RandomBytesFn = (byteCount: number) => Promise<Uint8Array>;

/** A nonce we have already acted on (armed or cancelled). */
export interface HandledNonce {
  nonce: string;
  /** When we handled it (ms since epoch) — drives pruning only. */
  at: number;
}

/** What the subject's device should do about a decoded control message. */
export type LiveRequestVerdict =
  /** Do nothing. `reason` is for telemetry, not the user. */
  | { action: 'ignore'; reason: LiveIgnoreReason }
  /** Arm live mode for `ttlMs`. */
  | { action: 'arm'; ttlMs: number }
  /** The watcher withdrew; stop live mode if this author is why we are live. */
  | { action: 'cancel' };

export type LiveIgnoreReason =
  | 'unsupported-version'
  | 'not-sharing'
  | 'malformed-nonce'
  | 'future-ts'
  | 'stale'
  | 'duplicate'
  | 'unknown-kind';

export interface EvaluateContext {
  /** Current wall clock (ms since epoch). */
  now: number;
  /**
   * Whether we are currently sharing our location with the message's author.
   *
   * This is the ONLY authorisation gate, and it is sufficient: sharing is an explicit grant the
   * user made on top of an SAS-verified bilateral pairing, and live mode reveals nothing new — it
   * is the same stream, more often. So a friend we share with can arm it with no further
   * permission and no prompt, the way Life360 and Find My behave. What keeps it safe is that it is
   * bounded by a TTL and stoppable at any moment, not that it asked first.
   */
  isSharing: boolean;
  /** Nonces already handled. See the module header. */
  handled: readonly HandledNonce[];
}

/** Clamp a requested live window into the sanctioned range. */
export function clampLiveTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return LIVE_TTL_DEFAULT_MS;
  return Math.min(LIVE_TTL_MAX_MS, Math.max(LIVE_TTL_MIN_MS, Math.round(ttlMs)));
}

/** True when `nonce` is a well-formed {@link CONTROL_NONCE_BYTES}-byte hex string. */
export function isValidNonce(nonce: string): boolean {
  return isHex(nonce) && nonce.length === CONTROL_NONCE_BYTES * 2;
}

/** Whether we have already acted on `nonce`. */
export function isHandled(handled: readonly HandledNonce[], nonce: string): boolean {
  return handled.some((h) => h.nonce === nonce);
}

/**
 * Drop handled-nonce records that can no longer matter. Anything older than twice the freshness
 * window is unreachable: a message that old is refused by the freshness check regardless, so
 * remembering it buys nothing. Keeps the persisted list to a handful of entries.
 */
export function pruneHandledNonces(handled: readonly HandledNonce[], now: number): HandledNonce[] {
  const cutoff = now - LIVE_REQUEST_FRESHNESS_MS * 2;
  return handled.filter((h) => h.at >= cutoff);
}

/** Record `nonce` as handled, pruning as we go so the list stays bounded. */
export function markHandled(
  handled: readonly HandledNonce[],
  nonce: string,
  now: number
): HandledNonce[] {
  if (isHandled(handled, nonce)) return pruneHandledNonces(handled, now);
  return pruneHandledNonces([...handled, { nonce, at: now }], now);
}

/**
 * Decide what to do about a decoded control message from `author`.
 *
 * Order is deliberate: cheap structural checks first, then freshness, then dedup, and only then
 * the kind. Dedup matters even without a prompt to suppress — the sender's control slot keeps
 * serving the same entry until they overwrite it, so without it every poll inside the freshness
 * window would re-arm and silently extend the session past what the watcher asked for.
 */
export function evaluateControlMsg(
  msg: NativeControlMsg,
  ctx: EvaluateContext
): LiveRequestVerdict {
  if (msg.v !== CONTROL_WIRE_VERSION) return { action: 'ignore', reason: 'unsupported-version' };
  // An envelope we could open was wrapped for us, which proves the sender chose us — not that we
  // are sharing with them. Someone we have revoked can still write a request; it must do nothing.
  if (!ctx.isSharing) return { action: 'ignore', reason: 'not-sharing' };
  if (!isValidNonce(msg.nonce)) return { action: 'ignore', reason: 'malformed-nonce' };
  if (msg.ts > ctx.now + LIVE_REQUEST_CLOCK_SKEW_MS) {
    // A far-future ts would otherwise stay "fresh" indefinitely — a replay that never expires.
    return { action: 'ignore', reason: 'future-ts' };
  }
  if (ctx.now - msg.ts > LIVE_REQUEST_FRESHNESS_MS) return { action: 'ignore', reason: 'stale' };
  if (isHandled(ctx.handled, msg.nonce)) return { action: 'ignore', reason: 'duplicate' };

  if (msg.kind === CTL_KIND_LIVE_CANCEL) return { action: 'cancel' };
  if (msg.kind === CTL_KIND_LIVE_REQUEST) return { action: 'arm', ttlMs: clampLiveTtl(msg.ttlMs) };
  // Forward compatibility: an unknown kind from a newer peer is ignored, never an error.
  return { action: 'ignore', reason: 'unknown-kind' };
}

/** Mint a fresh nonce as lowercase hex. */
export async function mintNonce(randomBytes: RandomBytesFn): Promise<string> {
  return bytesToHex(await randomBytes(CONTROL_NONCE_BYTES));
}

/** Build a live-mode request addressed at whoever we wrap it for. */
export function buildLiveRequest(now: number, ttlMs: number, nonce: string): NativeControlMsg {
  return {
    v: CONTROL_WIRE_VERSION,
    kind: CTL_KIND_LIVE_REQUEST,
    ts: now,
    ttlMs: clampLiveTtl(ttlMs),
    nonce,
  };
}

/** Build a withdrawal of an outstanding request. Supersedes it in the single control slot. */
export function buildLiveCancel(now: number, nonce: string): NativeControlMsg {
  return { v: CONTROL_WIRE_VERSION, kind: CTL_KIND_LIVE_CANCEL, ts: now, ttlMs: 0, nonce };
}

// ── Watcher sessions ─────────────────────────────────────────────────────────────────────────

/** An armed live session: who is watching us, and until when. */
export interface WatcherSession {
  /** The watching friend's endpoint id. */
  author: string;
  /** Absolute wall-clock expiry (ms since epoch). */
  expiresAt: number;
}

/** Sessions that have not yet expired. */
export function activeWatchers(sessions: readonly WatcherSession[], now: number): WatcherSession[] {
  return sessions.filter((s) => s.expiresAt > now);
}

/**
 * Add or extend `author`'s session. Re-requesting extends rather than stacking, so a watcher who
 * renews cannot accumulate windows.
 */
export function armWatcher(
  sessions: readonly WatcherSession[],
  author: string,
  expiresAt: number,
  now: number
): WatcherSession[] {
  const others = activeWatchers(sessions, now).filter((s) => s.author !== author);
  const existing = sessions.find((s) => s.author === author);
  // Never shorten an existing window: a second request while one is running is a renewal.
  const end = Math.max(expiresAt, existing && existing.expiresAt > now ? existing.expiresAt : 0);
  return [...others, { author, expiresAt: end }];
}

/** Drop `author`'s session (an explicit cancel, or an unfriend). */
export function disarmWatcher(
  sessions: readonly WatcherSession[],
  author: string,
  now: number
): WatcherSession[] {
  return activeWatchers(sessions, now).filter((s) => s.author !== author);
}

/**
 * When live mode should end: the latest expiry across all active watchers, or null when nobody is
 * watching. The service uses this as the `ttlMs` anchor so two overlapping watchers do not cut
 * each other's session short.
 */
export function liveUntil(sessions: readonly WatcherSession[], now: number): number | null {
  const active = activeWatchers(sessions, now);
  if (active.length === 0) return null;
  return active.reduce((max, s) => Math.max(max, s.expiresAt), 0);
}

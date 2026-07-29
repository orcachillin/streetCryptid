import { CTL_KIND_LIVE_CANCEL, CTL_KIND_LIVE_REQUEST, type NativeControlMsg } from 'iroh-location';

import {
  activeWatchers,
  armWatcher,
  buildLiveCancel,
  buildLiveRequest,
  clampLiveTtl,
  CONTROL_NONCE_BYTES,
  CONTROL_WIRE_VERSION,
  disarmWatcher,
  evaluateControlMsg,
  isHandled,
  isValidNonce,
  liveUntil,
  LIVE_REQUEST_CLOCK_SKEW_MS,
  LIVE_REQUEST_FRESHNESS_MS,
  LIVE_TTL_DEFAULT_MS,
  LIVE_TTL_MAX_MS,
  LIVE_TTL_MIN_MS,
  markHandled,
  mintNonce,
  pruneHandledNonces,
  type EvaluateContext,
} from '../live-requests';

const NOW = 1_800_000_000_000;
const NONCE = 'a'.repeat(CONTROL_NONCE_BYTES * 2);

function request(overrides: Partial<NativeControlMsg> = {}): NativeControlMsg {
  return {
    v: CONTROL_WIRE_VERSION,
    kind: CTL_KIND_LIVE_REQUEST,
    ts: NOW,
    ttlMs: LIVE_TTL_DEFAULT_MS,
    nonce: NONCE,
    ...overrides,
  };
}

function ctx(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return { now: NOW, isSharing: true, handled: [], ...overrides };
}

describe('clampLiveTtl', () => {
  it('keeps a sane request untouched', () => {
    expect(clampLiveTtl(5 * 60_000)).toBe(5 * 60_000);
  });

  it('clamps an attacker-chosen window into the sanctioned range', () => {
    expect(clampLiveTtl(24 * 60 * 60_000)).toBe(LIVE_TTL_MAX_MS);
    expect(clampLiveTtl(1)).toBe(LIVE_TTL_MIN_MS);
  });

  it('falls back to the default for nonsense', () => {
    expect(clampLiveTtl(0)).toBe(LIVE_TTL_DEFAULT_MS);
    expect(clampLiveTtl(-1)).toBe(LIVE_TTL_DEFAULT_MS);
    expect(clampLiveTtl(Number.NaN)).toBe(LIVE_TTL_DEFAULT_MS);
    expect(clampLiveTtl(Number.POSITIVE_INFINITY)).toBe(LIVE_TTL_DEFAULT_MS);
  });
});

describe('isValidNonce', () => {
  it('accepts exactly a 16-byte hex string', () => {
    expect(isValidNonce(NONCE)).toBe(true);
  });

  it('rejects wrong length or non-hex', () => {
    expect(isValidNonce('')).toBe(false);
    expect(isValidNonce('ab')).toBe(false);
    expect(isValidNonce('a'.repeat(CONTROL_NONCE_BYTES * 2 + 2))).toBe(false);
    expect(isValidNonce('z'.repeat(CONTROL_NONCE_BYTES * 2))).toBe(false);
  });
});

describe('evaluateControlMsg', () => {
  it('just arms for a friend we share with — no prompt, no per-friend toggle', () => {
    expect(evaluateControlMsg(request(), ctx())).toEqual({
      action: 'arm',
      ttlMs: LIVE_TTL_DEFAULT_MS,
    });
  });

  it('clamps the window the watcher asked for', () => {
    const verdict = evaluateControlMsg(request({ ttlMs: 99 * 60_000 }), ctx());
    expect(verdict).toEqual({ action: 'arm', ttlMs: LIVE_TTL_MAX_MS });
  });

  it('cancels on a cancel message', () => {
    expect(evaluateControlMsg(request({ kind: CTL_KIND_LIVE_CANCEL }), ctx())).toEqual({
      action: 'cancel',
    });
  });

  it('ignores someone we are not sharing with, even though the envelope opened for us', () => {
    // A revoked friend can still write a request into their own namespace. It must do nothing.
    expect(evaluateControlMsg(request(), ctx({ isSharing: false }))).toEqual({
      action: 'ignore',
      reason: 'not-sharing',
    });
  });

  it('ignores an unsupported wire version', () => {
    expect(evaluateControlMsg(request({ v: 99 }), ctx())).toEqual({
      action: 'ignore',
      reason: 'unsupported-version',
    });
  });

  it('ignores an unknown kind rather than failing', () => {
    expect(evaluateControlMsg(request({ kind: 77 }), ctx())).toEqual({
      action: 'ignore',
      reason: 'unknown-kind',
    });
  });

  it('ignores a malformed nonce', () => {
    expect(evaluateControlMsg(request({ nonce: 'nope' }), ctx())).toEqual({
      action: 'ignore',
      reason: 'malformed-nonce',
    });
  });

  // ── replay defence ──────────────────────────────────────────────────────────────────────
  it('ignores a message older than the freshness window', () => {
    const stale = request({ ts: NOW - LIVE_REQUEST_FRESHNESS_MS - 1 });
    expect(evaluateControlMsg(stale, ctx())).toEqual({ action: 'ignore', reason: 'stale' });
  });

  it('still accepts a message right at the freshness edge', () => {
    const edge = request({ ts: NOW - LIVE_REQUEST_FRESHNESS_MS });
    expect(evaluateControlMsg(edge, ctx())).toMatchObject({ action: 'arm' });
  });

  it('tolerates modest clock skew but refuses a far-future ts', () => {
    const skewed = request({ ts: NOW + LIVE_REQUEST_CLOCK_SKEW_MS });
    expect(evaluateControlMsg(skewed, ctx())).toMatchObject({ action: 'arm' });

    // A far-future ts would never go stale — a replay with no expiry.
    const future = request({ ts: NOW + LIVE_REQUEST_CLOCK_SKEW_MS + 1 });
    expect(evaluateControlMsg(future, ctx())).toEqual({ action: 'ignore', reason: 'future-ts' });
  });

  it('does not re-arm on a nonce it already handled', () => {
    // The sender's slot keeps serving the same entry until they overwrite it. Without dedup every
    // poll inside the freshness window would re-arm and silently extend the session.
    const handled = markHandled([], NONCE, NOW);
    expect(evaluateControlMsg(request(), ctx({ handled }))).toEqual({
      action: 'ignore',
      reason: 'duplicate',
    });
  });

  it('treats a fresh nonce from the same friend as a new request', () => {
    const handled = markHandled([], NONCE, NOW);
    const renewed = request({ nonce: 'b'.repeat(CONTROL_NONCE_BYTES * 2) });
    expect(evaluateControlMsg(renewed, ctx({ handled }))).toMatchObject({ action: 'arm' });
  });
});

describe('handled-nonce bookkeeping', () => {
  it('records and recognises a nonce', () => {
    const handled = markHandled([], NONCE, NOW);
    expect(isHandled(handled, NONCE)).toBe(true);
    expect(isHandled(handled, 'b'.repeat(32))).toBe(false);
  });

  it('does not duplicate an already-handled nonce', () => {
    const once = markHandled([], NONCE, NOW);
    expect(markHandled(once, NONCE, NOW)).toHaveLength(1);
  });

  it('prunes records too old to matter', () => {
    const old = [{ nonce: NONCE, at: NOW - LIVE_REQUEST_FRESHNESS_MS * 2 - 1 }];
    expect(pruneHandledNonces(old, NOW)).toEqual([]);
  });

  it('keeps records still inside the reachable window', () => {
    const recent = [{ nonce: NONCE, at: NOW - LIVE_REQUEST_FRESHNESS_MS }];
    expect(pruneHandledNonces(recent, NOW)).toHaveLength(1);
  });

  it('stays bounded as messages accumulate', () => {
    let handled = markHandled([], 'a'.repeat(32), NOW - LIVE_REQUEST_FRESHNESS_MS * 3);
    handled = markHandled(handled, 'b'.repeat(32), NOW);
    expect(handled).toHaveLength(1);
    expect(handled[0].nonce).toBe('b'.repeat(32));
  });
});

describe('message builders', () => {
  it('builds a request at the current wire version with a clamped ttl', () => {
    const msg = buildLiveRequest(NOW, 99 * 60_000, NONCE);
    expect(msg).toEqual({
      v: CONTROL_WIRE_VERSION,
      kind: CTL_KIND_LIVE_REQUEST,
      ts: NOW,
      ttlMs: LIVE_TTL_MAX_MS,
      nonce: NONCE,
    });
  });

  it('builds a cancel that a receiver accepts', () => {
    const msg = buildLiveCancel(NOW, NONCE);
    expect(msg.kind).toBe(CTL_KIND_LIVE_CANCEL);
    expect(evaluateControlMsg(msg, ctx())).toEqual({ action: 'cancel' });
  });

  it('mints a well-formed nonce from the injected source', async () => {
    const randomBytes = jest.fn(async (n: number) => new Uint8Array(n).fill(0x7f));
    const nonce = await mintNonce(randomBytes);
    expect(randomBytes).toHaveBeenCalledWith(CONTROL_NONCE_BYTES);
    expect(isValidNonce(nonce)).toBe(true);
    expect(nonce).toBe('7f'.repeat(CONTROL_NONCE_BYTES));
  });
});

describe('watcher sessions', () => {
  it('drops expired sessions', () => {
    const sessions = [
      { author: 'alice', expiresAt: NOW - 1 },
      { author: 'bob', expiresAt: NOW + 1000 },
    ];
    expect(activeWatchers(sessions, NOW).map((s) => s.author)).toEqual(['bob']);
  });

  it('extends rather than stacking when a watcher renews', () => {
    const first = armWatcher([], 'alice', NOW + 60_000, NOW);
    const renewed = armWatcher(first, 'alice', NOW + 120_000, NOW);
    expect(renewed).toHaveLength(1);
    expect(renewed[0].expiresAt).toBe(NOW + 120_000);
  });

  it('never shortens a running window', () => {
    const long = armWatcher([], 'alice', NOW + 600_000, NOW);
    const short = armWatcher(long, 'alice', NOW + 1_000, NOW);
    expect(short[0].expiresAt).toBe(NOW + 600_000);
  });

  it('keeps concurrent watchers independent', () => {
    let sessions = armWatcher([], 'alice', NOW + 60_000, NOW);
    sessions = armWatcher(sessions, 'bob', NOW + 120_000, NOW);
    expect(sessions).toHaveLength(2);
    expect(liveUntil(sessions, NOW)).toBe(NOW + 120_000);
  });

  it('stays live for the remaining watcher when one cancels', () => {
    let sessions = armWatcher([], 'alice', NOW + 60_000, NOW);
    sessions = armWatcher(sessions, 'bob', NOW + 120_000, NOW);
    sessions = disarmWatcher(sessions, 'bob', NOW);
    expect(sessions.map((s) => s.author)).toEqual(['alice']);
    expect(liveUntil(sessions, NOW)).toBe(NOW + 60_000);
  });

  it('reports nobody watching once every session lapses', () => {
    const sessions = armWatcher([], 'alice', NOW + 1_000, NOW);
    expect(liveUntil(sessions, NOW + 2_000)).toBeNull();
  });
});

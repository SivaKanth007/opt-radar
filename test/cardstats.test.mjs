import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardStats, cardHistogram, cardProjection } from '../lib/cardstats.mjs';

/** Build an approved case with card dates offset by given day gaps. */
function mk(approved, prodGap, recvGap, flags) {
  const d = (iso, n) => {
    const t = new Date(iso + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  return {
    date_applied: '2026-03-01',
    date_approved: approved,
    card_produced: prodGap != null ? d(approved, prodGap) : null,
    card_received: recvGap != null ? d(approved, recvGap) : null,
    flags: flags || [],
  };
}

test('cardStats computes the three stage distributions', () => {
  // produced gaps 1..10 → floor-index quantiles: p50 = 6, p90 = 10
  const cases = Array.from({ length: 10 }, (_, i) => mk('2026-06-01', i + 1, i + 5));
  const s = cardStats(cases);
  assert.equal(s.a2p.n, 10);
  assert.equal(s.a2p.p50, 6);
  assert.equal(s.a2p.p90, 10);
  assert.equal(s.p2r.n, 10);       // every case has both dates, gap = 4
  assert.equal(s.p2r.p50, 4);
  assert.equal(s.a2r.p50, 10);     // recvGap 5..14 → p50 = 10
});

test('cardStats filters impossible flags, negative and absurd gaps', () => {
  const cases = [
    mk('2026-06-01', 6, 10),
    mk('2026-06-01', -3, null),                       // produced before approval → dropped
    mk('2026-06-01', 500, null),                      // 500-day gap → dropped
    mk('2026-06-01', 6, 10, ['impossible_dates']),    // flagged → dropped
    { date_approved: '2026-06-01' },                  // no card data → not counted
  ];
  const s = cardStats(cases);
  assert.equal(s.a2p.n, 1);
  assert.equal(s.a2r.n, 1);
});

test('cardStats returns null when nothing is reported', () => {
  assert.equal(cardStats([{ date_approved: '2026-06-01' }]), null);
  assert.equal(cardStats([]), null);
});

test('cardHistogram bins per day with an overflow bucket', () => {
  const bins = cardHistogram([0, 1, 1, 3, 25, 99], 21);
  assert.equal(bins.length, 22);
  assert.equal(bins[0].count, 1);
  assert.equal(bins[1].count, 2);
  assert.equal(bins[3].count, 1);
  assert.equal(bins[21].count, 2);   // 25 and 99 both land in "21+"
  assert.ok(bins[21].overflow);
});

test('cardProjection from approval anchors both stages', () => {
  const cases = Array.from({ length: 10 }, (_, i) => mk('2026-06-01', i + 1, i + 5));
  const p = cardProjection(cardStats(cases), '2026-07-01', 'approved');
  assert.equal(p.producedP50, '2026-07-07');  // +6
  assert.equal(p.deliveredP50, '2026-07-11'); // +10
  assert.equal(p.deliveredP90, '2026-07-15'); // +14
  assert.equal(p.basis.a2p, 10);
});

test('cardProjection from a card-produced anchor uses produced→received only', () => {
  const cases = Array.from({ length: 10 }, (_, i) => mk('2026-06-01', i + 1, i + 5)); // p2r = 4
  const p = cardProjection(cardStats(cases), '2026-07-01', 'produced');
  assert.equal(p.producedP50, null);
  assert.equal(p.deliveredP50, '2026-07-05'); // +4
});

test('cardProjection handles missing stats gracefully', () => {
  assert.equal(cardProjection(null, '2026-07-01'), null);
  assert.equal(cardProjection(cardStats([]), '2026-07-01'), null);
  const onlyProduced = cardStats([mk('2026-06-01', 6, null)]);
  const p = cardProjection(onlyProduced, '2026-07-01', 'produced');
  assert.equal(p, null); // no produced→received data to project with
});

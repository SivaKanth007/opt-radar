/**
 * dashboard/modules/panels.mjs
 * Renders the #diff and #quality panels.
 *
 * #diff  (#diff-out)    — newly-approved cases since the last snapshot
 * #quality (#quality-out) — data-quality / provenance breakdown
 *
 * Follows the MODULE CONTRACT: export render(ctx).
 * Does NOT commit, does NOT modify app.js or any other module.
 */

/**
 * render — builds / rebuilds both panels.
 * Called once by the orchestrator after data is loaded.
 * @param {object} ctx  orchestrator context
 */
export function render(ctx) {
  const { data, diff, $, el, wrapTable } = ctx;

  _renderDiff(diff, $, el, wrapTable);
  _renderQuality(data, $, el, wrapTable);
}

// ---------------------------------------------------------------------------
// Diff panel
// ---------------------------------------------------------------------------

function _renderDiff(diff, $, el, wrapTable) {
  const out = $('#diff-out');
  if (!out) return; // defensive: element may not be in DOM yet

  // First snapshot or missing diff — friendly placeholder.
  if (!diff || diff.first_snapshot) {
    out.replaceChildren(
      el('p', 'muted', 'First snapshot — changes appear after the next update.')
    );
    return;
  }

  const since = diff.since ? diff.since.slice(0, 10) : '—';
  const newCases = typeof diff.new_cases === 'number' ? diff.new_cases : 0;
  const newlyApproved = Array.isArray(diff.newly_approved) ? diff.newly_approved : [];

  const summary = el('p', null,
    `Since ${since}: ${newCases} new case${newCases !== 1 ? 's' : ''}, ` +
    `${newlyApproved.length} newly approved.`
  );

  const children = [summary];

  if (newlyApproved.length > 0) {
    const tbl = el('table');

    const thead = el('tr');
    for (const h of ['Applied', 'Approved', 'Days', 'Link']) {
      thead.append(el('th', null, h));
    }
    tbl.append(thead);

    const rows = newlyApproved.slice(0, 30);
    for (const a of rows) {
      const tr = el('tr');

      const tdApplied = el('td', null, a.date_applied ?? '—');
      const tdApproved = el('td', null, a.date_approved ?? '—');
      const tdDays = el('td', null, a.days != null ? String(a.days) : '—');

      const tdLink = el('td');
      if (a.reddit_url) {
        const anchor = el('a');
        anchor.href = a.reddit_url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = 'reddit';
        tdLink.append(anchor);
      } else {
        tdLink.textContent = '—';
      }

      tr.append(tdApplied, tdApproved, tdDays, tdLink);
      tbl.append(tr);
    }

    children.push(wrapTable(tbl));
  }

  out.replaceChildren(...children);
}

// ---------------------------------------------------------------------------
// Quality panel
// ---------------------------------------------------------------------------

function _renderQuality(data, $, el, wrapTable) {
  const out = $('#quality-out');
  if (!out) return;

  if (!data) {
    out.replaceChildren(el('p', 'muted', 'No data loaded.'));
    return;
  }

  const cases = Array.isArray(data.cases) ? data.cases : [];
  const n = cases.length || 1; // avoid division by zero

  // Helpers
  const nullPct = (field) => {
    const count = cases.filter(c => c[field] == null).length;
    return (100 * count / n).toFixed(0) + '%';
  };
  const flagCount = (flag) =>
    cases.filter(c => Array.isArray(c.flags) && c.flags.includes(flag)).length;

  const s = data.sources || {};
  const pendingCount = cases.filter(c => !c.date_approved).length;
  const pendingShare = (100 * pendingCount / n).toFixed(0) + '%';
  const staleCutoff = data.stale_cutoff_days != null
    ? `${data.stale_cutoff_days} days`
    : '—';
  const warnings = Array.isArray(data.warnings) && data.warnings.length
    ? data.warnings.join('; ')
    : 'none';

  // Build metrics table
  const metrics = [
    [
      'Sources',
      `optpulse ${s.optpulse?.count ?? '—'} · opttracker ${s.opttracker?.count ?? '—'} ` +
      `· merged ${s.merged ?? 0} · conflicts ${s.conflicts ?? 0}`,
    ],
    ['Censoring (pending share)', pendingShare],
    ['Stale-pending cutoff', staleCutoff],
    [
      'Flags',
      `impossible ${flagCount('impossible_dates')} · ` +
      `outliers ${flagCount('outlier_duration')} · ` +
      `stale ${flagCount('stale_pending')}`,
    ],
    [
      'Missing fields',
      `biometrics ${nullPct('biometrics_date')} · ` +
      `service center ${nullPct('service_center')} · ` +
      `nationality ${nullPct('nationality')} · ` +
      `card received ${nullPct('card_received')}`,
    ],
    ['Schema warnings', warnings],
  ];

  const tbl = el('table');

  const headerRow = el('tr');
  headerRow.append(el('th', null, 'Metric'), el('th', null, 'Value'));
  tbl.append(headerRow);

  for (const [metric, value] of metrics) {
    const tr = el('tr');
    tr.append(el('td', null, metric), el('td', null, value));
    tbl.append(tr);
  }

  // Explainer paragraph
  const explainer = el('p', 'muted',
    'Naive stats use approved cases only (optimistic — biased fast). ' +
    'Survival-adjusted stats count pending cases as "at least N days" via Kaplan-Meier; ' +
    'stale pending cases are censored at the cutoff.'
  );

  out.replaceChildren(wrapTable(tbl), explainer);
}

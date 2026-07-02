/**
 * dashboard/modules/approvals.mjs
 * Full paginated approvals list with search/filter controls.
 * Renders into section#approvals.
 *
 * MODULE CONTRACT:
 *   export function render(ctx)          — called once on load
 *   (no onCaseChange needed — this module does not react to calculator state)
 */

const PAGE_SIZE = 25;

// Module-local pagination state (survives re-renders of table body).
let _currentPage = 1;
// Column sort state — sorts the FULL filtered dataset (not just the page).
let _sort = { col: 'approved', dir: -1 };
// Hold references to filter controls so filter/page rebuilds can read them without
// querying the DOM repeatedly after the first render.
let _controls = null;
// Hold the filtered list so pagination doesn't re-filter on every page turn.
let _filtered = [];
// Hold a reference to the section root so partial updates work without a ctx reference.
let _section = null;
// Hold ctx-level helpers (set once in render, reused in callbacks).
let _ctx = null;
// Tracks whether the currently-rendered page has at least one link_partial row,
// so the shared footnote can be shown/hidden accordingly.
let _pageHasPartialLink = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true when a case is valid for the approvals list. */
function isApproved(c) {
  return (
    c.date_approved != null &&
    !(c.flags || []).includes('impossible_dates')
  );
}

/** Build the sorted, unfiltered base list (most-recent-approval first). */
function buildBase(cases) {
  return cases
    .filter(isApproved)
    .sort((a, b) => (a.date_approved > b.date_approved ? -1 : a.date_approved < b.date_approved ? 1 : 0));
}

// Column definitions: header label + a sort accessor over the CASE OBJECT, so
// sorting covers the entire filtered dataset — not just the rendered page.
const COLUMNS = [
  { key: 'approved', label: 'Approved', get: (c, d) => c.date_approved || '' },
  { key: 'applied', label: 'Applied', get: (c) => c.date_applied || '' },
  { key: 'days', label: 'Days', get: (c, days) => days ?? -1 },
  { key: 'type', label: 'Type', get: (c) => c.opt_type || '' },
  { key: 'pp', label: 'PP', get: (c) => (c.premium ? 1 : 0) },
  { key: 'center', label: 'Center', get: (c) => c.service_center || '' },
  { key: 'nat', label: 'Nationality', get: (c) => c.nationality || '' },
  { key: 'link', label: 'Link', get: (c) => (c.reddit_url ? 1 : 0) },
];

function daysOf(c, daysBetween) {
  return (c.date_applied && c.date_approved) ? daysBetween(c.date_applied, c.date_approved) : null;
}

function applySort(list) {
  const col = COLUMNS.find(x => x.key === _sort.col);
  if (!col || !_ctx) return list;
  const { daysBetween } = _ctx.dates;
  return [...list].sort((a, b) => {
    const va = col.key === 'days' ? (daysOf(a, daysBetween) ?? -1) : col.get(a);
    const vb = col.key === 'days' ? (daysOf(b, daysBetween) ?? -1) : col.get(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * _sort.dir;
  });
}

function refreshSortHeaders() {
  if (!_section) return;
  for (const th of _section.querySelectorAll('thead th')) {
    const active = th.dataset.col === _sort.col;
    th.classList.toggle('sorted', active);
    th.setAttribute('aria-sort', active ? (_sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  }
}

/** Apply the current filter controls to the base list. */
function applyFilters(base, controls) {
  const query = controls.search.value.trim().toLowerCase();
  const typeVal = controls.type.value;   // 'all' | 'initial' | 'stem'
  const ppVal = controls.pp.value;       // 'all' | 'premium' | 'regular'

  return base.filter((c) => {
    // Type filter
    if (typeVal !== 'all' && c.opt_type !== typeVal) return false;
    // Premium filter
    if (ppVal === 'premium' && !c.premium) return false;
    if (ppVal === 'regular' && c.premium) return false;
    // Text search: reddit_username, service_center, nationality
    if (query) {
      const haystack = [c.reddit_username, c.service_center, c.nationality]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Table body builder (partial update — controls stay stable)
// ---------------------------------------------------------------------------

function buildTableBody(ctx, filtered, page) {
  const { el, fmt, $, wrapTable, dates: { daysBetween } } = ctx;

  const start = (page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  const tbody = el('tbody');
  _pageHasPartialLink = slice.some((c) => c.link_partial === true);

  if (slice.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.style.padding = '22px 12px';
    td.textContent = 'No matching approvals.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return tbody;
  }

  for (const c of slice) {
    const tr = document.createElement('tr');
    tr.className = 'ok';

    const days = (c.date_applied && c.date_approved)
      ? daysBetween(c.date_applied, c.date_approved)
      : null;

    // Approved date
    const td1 = document.createElement('td');
    td1.textContent = c.date_approved ?? '—';
    tr.appendChild(td1);

    // Applied date
    const td2 = document.createElement('td');
    td2.textContent = c.date_applied ?? '—';
    tr.appendChild(td2);

    // Days
    const td3 = document.createElement('td');
    td3.textContent = days != null ? String(days) : '—';
    tr.appendChild(td3);

    // Type
    const td4 = document.createElement('td');
    td4.textContent = c.opt_type ?? '—';
    tr.appendChild(td4);

    // PP (premium) — SVG bolt, not an emoji glyph
    const td5 = document.createElement('td');
    if (c.premium) {
      td5.append(ctx.icon ? ctx.icon('bolt', 13) : el('span', null, 'PP'));
      td5.title = 'Premium processing';
      td5.style.color = 'var(--warn)';
    }
    td5.style.textAlign = 'center';
    tr.appendChild(td5);

    // Service center
    const td6 = document.createElement('td');
    td6.textContent = c.service_center ?? '—';
    tr.appendChild(td6);

    // Nationality
    const td7 = document.createElement('td');
    td7.textContent = c.nationality ?? '—';
    tr.appendChild(td7);

    // Link
    const td8 = document.createElement('td');
    if (c.reddit_url) {
      const a = document.createElement('a');
      a.href = c.reddit_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (c.link_partial === true) {
        a.textContent = 'reddit*';
        a.title = 'The linked comment may show an earlier update — some fields were merged from opt-tracker submissions.';
      } else {
        a.textContent = 'reddit';
      }
      td8.appendChild(a);
    } else {
      td8.textContent = '—';
    }
    tr.appendChild(td8);

    tbody.appendChild(tr);
  }

  return tbody;
}

// ---------------------------------------------------------------------------
// Pagination controls builder
// ---------------------------------------------------------------------------

function buildPagination(ctx, totalCount, page) {
  const { el } = ctx;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const wrap = el('div');
  wrap.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'flex-wrap:wrap',
    'gap:10px',
    'margin-top:12px',
  ].join(';');

  const info = el('span', 'muted');
  info.style.fontSize = '12px';
  const start = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, totalCount);
  info.textContent = totalCount === 0
    ? '0 approvals'
    : `${start}–${end} of ${totalCount} approval${totalCount !== 1 ? 's' : ''}`;

  const nav = el('div');
  nav.style.cssText = 'display:flex;align-items:center;gap:10px;';

  const prevBtn = el('button', null, '← Prev');
  prevBtn.type = 'button';
  prevBtn.disabled = page <= 1;
  prevBtn.setAttribute('aria-label', 'Previous page');
  prevBtn.addEventListener('click', () => goToPage(page - 1));

  const pageLabel = el('span', 'muted');
  pageLabel.style.fontSize = '12px';
  pageLabel.textContent = `page ${page} of ${totalPages}`;

  const nextBtn = el('button', null, 'Next →');
  nextBtn.type = 'button';
  nextBtn.disabled = page >= totalPages;
  nextBtn.setAttribute('aria-label', 'Next page');
  nextBtn.addEventListener('click', () => goToPage(page + 1));

  nav.append(prevBtn, pageLabel, nextBtn);
  wrap.append(info, nav);
  return wrap;
}

// ---------------------------------------------------------------------------
// Shared footnote — only shown when the current page has a link_partial row.
// ---------------------------------------------------------------------------

function buildFootnote(ctx) {
  const { el } = ctx;
  const p = el('p', 'muted', '* linked comment may show an earlier update');
  p.className = 'muted appr-footnote';
  return p;
}

function refreshFootnote() {
  if (!_section || !_ctx) return;
  const old = _section.querySelector('.appr-footnote');
  if (old) old.remove();
  if (_pageHasPartialLink) {
    const footnote = buildFootnote(_ctx);
    // Place right after the pagination controls (end of section).
    _section.append(footnote);
  }
}

// ---------------------------------------------------------------------------
// Partial update: swap only tbody + pagination, keep controls intact
// ---------------------------------------------------------------------------

function refreshTable() {
  if (!_section || !_controls || !_ctx) return;

  const tbody = buildTableBody(_ctx, applySort(_filtered), _currentPage);
  refreshSortHeaders();
  const oldTbody = _section.querySelector('tbody');
  if (oldTbody) {
    oldTbody.replaceWith(tbody);
  }

  const oldPagination = _section.querySelector('.appr-pagination');
  const newPagination = buildPagination(_ctx, _filtered.length, _currentPage);
  newPagination.className = 'appr-pagination';
  if (oldPagination) {
    oldPagination.replaceWith(newPagination);
  }

  refreshFootnote();
}

function goToPage(n) {
  const totalPages = Math.max(1, Math.ceil(_filtered.length / PAGE_SIZE));
  _currentPage = Math.max(1, Math.min(n, totalPages));
  refreshTable();
  // Scroll section into view smoothly so user can see the top of the new page.
  if (_section) _section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onFilterChange(base) {
  _filtered = applyFilters(base, _controls);
  _currentPage = 1;
  refreshTable();
}

// ---------------------------------------------------------------------------
// render(ctx) — called once by orchestrator
// ---------------------------------------------------------------------------

export function render(ctx) {
  const { data, $, el, wrapTable } = ctx;

  _ctx = ctx;
  _section = document.getElementById('approvals');
  if (!_section) return;
  _section.replaceChildren(); // idempotent: rebuild cleanly on every (re-)render

  // Guard: no data
  if (!data || !data.cases) {
    _section.append(el('p', 'muted', 'No data available.'));
    return;
  }

  const base = buildBase(data.cases);
  _filtered = base.slice(); // initial: no filters applied
  _currentPage = 1;

  // ---- Section heading ----
  const heading = el('h2', null, 'All Approvals');
  _section.append(heading);

  // ---- Summary badge ----
  const badge = el('p', 'muted');
  badge.style.marginBottom = '14px';
  badge.textContent = `${base.length} approved case${base.length !== 1 ? 's' : ''} in the dataset`;
  _section.append(badge);

  // ---- Filter row ----
  const filterRow = document.createElement('div');
  filterRow.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'gap:10px',
    'align-items:flex-end',
    'margin-bottom:14px',
  ].join(';');

  // Search input
  const searchLabel = el('label');
  searchLabel.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:500;flex:1 1 180px;min-width:140px;';
  const searchCaption = document.createElement('span');
  searchCaption.textContent = 'Search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'username / center / nationality';
  searchInput.setAttribute('aria-label', 'Search approvals');
  // iOS no-zoom: font-size 16px on inputs
  searchInput.style.fontSize = '16px';
  searchLabel.append(searchCaption, searchInput);

  // Type select
  const typeLabel = el('label');
  typeLabel.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:500;';
  const typeCaption = document.createElement('span');
  typeCaption.textContent = 'Type';
  const typeSelect = document.createElement('select');
  typeSelect.setAttribute('aria-label', 'Filter by OPT type');
  [['all', 'All types'], ['initial', 'Initial OPT'], ['stem', 'STEM ext.']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    typeSelect.append(o);
  });
  typeLabel.append(typeCaption, typeSelect);

  // Processing select
  const ppLabel = el('label');
  ppLabel.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted);font-weight:500;';
  const ppCaption = document.createElement('span');
  ppCaption.textContent = 'Processing';
  const ppSelect = document.createElement('select');
  ppSelect.setAttribute('aria-label', 'Filter by processing type');
  [['all', 'All'], ['premium', '⚡ Premium'], ['regular', 'Regular']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    ppSelect.append(o);
  });
  ppLabel.append(ppCaption, ppSelect);

  filterRow.append(searchLabel, typeLabel, ppLabel);
  _section.append(filterRow);

  // Store control refs
  _controls = { search: searchInput, type: typeSelect, pp: ppSelect };

  // Attach filter listeners (debounce search for perf)
  let _debounceTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => onFilterChange(base), 220);
  });
  typeSelect.addEventListener('change', () => onFilterChange(base));
  ppSelect.addEventListener('change', () => onFilterChange(base));

  // ---- Table ----
  const table = document.createElement('table');
  // This module sorts the FULL dataset itself — opt out of the DOM-level
  // enhancer (which would only sort the visible page).
  table.dataset.noEnhance = '1';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.dataset.col = col.key;
    th.classList.add('sortable');
    th.tabIndex = 0;
    th.setAttribute('aria-sort', 'none');
    th.append(el('span', 'sort-ind'));
    const activate = () => {
      if (_sort.col === col.key) _sort.dir = -_sort.dir;
      else _sort = { col: col.key, dir: col.key === 'approved' || col.key === 'applied' ? -1 : 1 };
      _currentPage = 1;
      refreshTable();
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  // Initial tbody (default sort: most recent approvals first)
  const tbody = buildTableBody(ctx, applySort(_filtered), _currentPage);
  table.append(tbody);

  _section.append(wrapTable(table));
  refreshSortHeaders();

  // ---- Pagination ----
  const pagination = buildPagination(ctx, _filtered.length, _currentPage);
  pagination.className = 'appr-pagination';
  _section.append(pagination);

  // ---- Footnote (only when this page has a partial-link row) ----
  refreshFootnote();
}

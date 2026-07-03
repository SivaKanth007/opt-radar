/**
 * lib/casestatus.mjs — USCIS receipt-number validation + case-status parsing.
 *
 * Shared by serve.mjs (which fetches the USCIS case-status page server-side,
 * where CORS doesn't apply) and dashboard/modules/casestatus.mjs (which
 * validates/masks input in the browser). Pure functions only — no Node or
 * DOM APIs — so both runtimes can import it.
 *
 * PRIVACY CONTRACT: nothing in this module (or its callers) persists a
 * receipt number anywhere but the user's own browser localStorage. The local
 * server relays it to uscis.gov and logs only a masked form.
 */

/** Normalize user input: uppercase, strip spaces/dashes. */
export function normalizeReceipt(s) {
  return String(s ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Valid USCIS receipt: 3-letter service-center prefix + 10 digits
 * (IOE, EAC, WAC, LIN, SRC, MSC, NBC, YSC, ...). Prefixes rotate over time,
 * so accept any 3 letters rather than hardcoding a list.
 */
export function isValidReceipt(s) {
  return /^[A-Z]{3}\d{10}$/.test(normalizeReceipt(s));
}

/** Display mask: first 3 + last 4 visible — "IOE••••••7890". */
export function maskReceipt(s) {
  const r = normalizeReceipt(s);
  if (r.length < 8) return '•'.repeat(r.length);
  return r.slice(0, 3) + '•'.repeat(r.length - 7) + r.slice(-4);
}

/** Minimal HTML entity decode for the handful USCIS emits. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’');
}

/** Collapse tags + whitespace out of an HTML fragment. */
function textOf(fragment) {
  return decodeEntities(String(fragment).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * classifyStatus — bucket a USCIS status headline for UI treatment.
 * @returns {'approved'|'warn'|'bad'|'pending'}
 */
export function classifyStatus(title) {
  const t = String(title ?? '').toLowerCase();
  if (!t) return 'pending';
  if (/denied|rejected|terminated|revoked|withdrawn/.test(t)) return 'bad';
  if (/request for (additional |initial |more )?evidence|intent to deny|intent to revoke/.test(t)) return 'warn';
  if (/approved|card (was|is) being produced|card was (mailed|picked up|delivered)|delivered .*post office|certificate .*mailed/.test(t)) return 'approved';
  return 'pending';
}

/**
 * parseCaseStatus — extract {status, detail} from the legacy USCIS
 * case-status HTML (egov.uscis.gov/casestatus/mycasestatus.do).
 *
 * The result block has been stable for years:
 *   <div class="rows text-center"> <h1>Case Was Approved</h1> <p>On ...</p>
 *
 * Returns { ok, status, detail, kind, error }:
 *  - ok=true  → status/detail populated, kind = classifyStatus(status)
 *  - ok=false → error is one of 'validation' (USCIS rejected the number),
 *               'unrecognized' (page layout unknown — maybe bot-blocked)
 */
export function parseCaseStatus(html) {
  const src = String(html ?? '');

  // Bot wall (Cloudflare & co.) — MUST run before the h1 extraction below,
  // because the block page has its own h1 ("Sorry, you have been blocked")
  // that would otherwise be reported as a case status.
  if (/sorry, you have been blocked|attention required!?\s*(\||<)\s*cloudflare|just a moment|cf-browser-verification|challenge-platform/i.test(src)) {
    return { ok: false, error: 'blocked', status: null, detail: null, kind: null };
  }

  // USCIS validation error (bad/unknown receipt number).
  if (/validation error|the case status .*(not available|could not be found)|formErrorMessages/i.test(src)) {
    return { ok: false, error: 'validation', status: null, detail: null, kind: null };
  }

  // Primary: status block. Fallback: first h1 followed by a p anywhere.
  const m =
    src.match(/<div[^>]*class="[^"]*rows[^"]*text-center[^"]*"[^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
    src.match(/<h1[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);

  if (!m) return { ok: false, error: 'unrecognized', status: null, detail: null, kind: null };

  const status = textOf(m[1]);
  const detail = textOf(m[2]);
  if (!status) return { ok: false, error: 'unrecognized', status: null, detail: null, kind: null };

  return { ok: true, status, detail, kind: classifyStatus(status), error: null };
}

/** Deep link to the user's status on uscis.gov (opens their result page). */
export function uscisStatusUrl(receipt) {
  return 'https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=' +
    encodeURIComponent(normalizeReceipt(receipt));
}

/**
 * parseTorchResponse — normalize a response from the OFFICIAL USCIS
 * developer API (developer.uscis.gov, "Torch" Case Status API) into the
 * same shape parseCaseStatus returns. Field names are matched defensively
 * across the spellings USCIS has used (snake_case and camelCase).
 */
export function parseTorchResponse(body) {
  const cs = body?.case_status ?? body?.caseStatus ?? body ?? {};
  const status =
    cs.current_case_status_text_en ?? cs.currentCaseStatusTextEn ??
    cs.actionCodeText ?? cs.action_code_text ?? null;
  const detail =
    cs.current_case_status_desc_en ?? cs.currentCaseStatusDescEn ??
    cs.actionCodeDesc ?? cs.action_code_desc ?? null;

  if (!status) return { ok: false, error: 'unrecognized', status: null, detail: null, kind: null };
  const strip = (s) => s == null ? null : String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { ok: true, status: strip(status), detail: strip(detail), kind: classifyStatus(status), error: null };
}

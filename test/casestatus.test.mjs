import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReceipt, isValidReceipt, maskReceipt,
  classifyStatus, parseCaseStatus, parseTorchResponse, uscisStatusUrl,
} from '../lib/casestatus.mjs';

// ---------------------------------------------------------------------------
// receipt validation + masking
// ---------------------------------------------------------------------------

test('normalizeReceipt uppercases and strips separators', () => {
  assert.equal(normalizeReceipt(' ioe-091 234 5678 '), 'IOE0912345678');
});

test('isValidReceipt accepts 3 letters + 10 digits', () => {
  assert.ok(isValidReceipt('IOE0912345678'));
  assert.ok(isValidReceipt('eac 21 903 50412'));
});

test('isValidReceipt rejects malformed input', () => {
  assert.ok(!isValidReceipt(''));
  assert.ok(!isValidReceipt('IOE12345'));           // too short
  assert.ok(!isValidReceipt('IOEX912345678'));      // letter in digits
  assert.ok(!isValidReceipt('1234567890123'));      // no prefix
  assert.ok(!isValidReceipt('IOE09123456789'));     // 11 digits
});

test('maskReceipt shows prefix + last 4 only', () => {
  assert.equal(maskReceipt('IOE0912345678'), 'IOE••••••5678');
});

test('uscisStatusUrl embeds the normalized receipt', () => {
  assert.equal(
    uscisStatusUrl('ioe 0912345678'),
    'https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=IOE0912345678',
  );
});

// ---------------------------------------------------------------------------
// status classification
// ---------------------------------------------------------------------------

test('classifyStatus buckets the common headlines', () => {
  assert.equal(classifyStatus('Case Was Approved'), 'approved');
  assert.equal(classifyStatus('New Card Is Being Produced'), 'approved');
  assert.equal(classifyStatus('Card Was Mailed To Me'), 'approved');
  assert.equal(classifyStatus('Request for Additional Evidence Was Sent'), 'warn');
  assert.equal(classifyStatus('Case Was Denied'), 'bad');
  assert.equal(classifyStatus('Case Was Received'), 'pending');
  assert.equal(classifyStatus('Case Was Updated To Show Fingerprints Were Taken'), 'pending');
  assert.equal(classifyStatus(''), 'pending');
});

// ---------------------------------------------------------------------------
// HTML parsing (legacy egov.uscis.gov/casestatus page)
// ---------------------------------------------------------------------------

const PAGE = (h1, p) => `<!doctype html><html><body>
  <div class="row"><div class="rows text-center">
    <h1>${h1}</h1>
    <p>${p}</p>
  </div></div></body></html>`;

test('parseCaseStatus extracts status + detail from the result block', () => {
  const out = parseCaseStatus(PAGE(
    'Case Was Approved',
    'On July 1, 2026, we approved your Form I-765, Application for Employment Authorization.',
  ));
  assert.ok(out.ok);
  assert.equal(out.status, 'Case Was Approved');
  assert.match(out.detail, /approved your Form I-765/);
  assert.equal(out.kind, 'approved');
});

test('parseCaseStatus strips markup + decodes entities in the detail', () => {
  const out = parseCaseStatus(PAGE(
    'Case Was Received',
    'We received your case &amp; sent a receipt to <strong>your address</strong>.',
  ));
  assert.ok(out.ok);
  assert.equal(out.detail, 'We received your case & sent a receipt to your address .');
});

test('parseCaseStatus flags USCIS validation errors', () => {
  const out = parseCaseStatus(
    '<html><body><div id="formErrorMessages">Validation Error(s)</div></body></html>');
  assert.ok(!out.ok);
  assert.equal(out.error, 'validation');
});

test('parseCaseStatus reports unrecognized layouts (bot wall, redesign)', () => {
  const out = parseCaseStatus('<html><body><div id="challenge">…</div></body></html>');
  assert.ok(!out.ok);
  assert.equal(out.error, 'unrecognized');
});

test('parseCaseStatus detects a Cloudflare block page (never shown as a status)', () => {
  const out = parseCaseStatus(`<!DOCTYPE html><html><head>
    <title>Attention Required! | Cloudflare</title></head><body>
    <h1>Sorry, you have been blocked</h1>
    <p>This website is using a security service to protect itself from online attacks.</p>
    </body></html>`);
  assert.ok(!out.ok);
  assert.equal(out.error, 'blocked');
  assert.equal(out.status, null);
});

test('parseTorchResponse reads the official API shape (snake_case)', () => {
  const out = parseTorchResponse({
    case_status: {
      receiptNumber: 'IOE0912345678',
      current_case_status_text_en: 'Case Was Approved',
      current_case_status_desc_en: 'On July 1, 2026, we approved your Form I-765.',
    },
  });
  assert.ok(out.ok);
  assert.equal(out.status, 'Case Was Approved');
  assert.equal(out.kind, 'approved');
  assert.match(out.detail, /approved your Form I-765/);
});

test('parseTorchResponse tolerates camelCase and actionCode spellings', () => {
  const out = parseTorchResponse({
    caseStatus: { actionCodeText: 'Request for Additional Evidence Was Sent', actionCodeDesc: 'We sent an RFE.' },
  });
  assert.ok(out.ok);
  assert.equal(out.kind, 'warn');
});

test('parseTorchResponse rejects unrecognized payloads', () => {
  assert.ok(!parseTorchResponse({}).ok);
  assert.ok(!parseTorchResponse(null).ok);
  assert.ok(!parseTorchResponse({ error: 'nope' }).ok);
});

test('parseCaseStatus falls back to a bare h1+p when the wrapper class changes', () => {
  const out = parseCaseStatus(
    '<html><body><main><h1>Case Was Transferred</h1><p>Your case moved to another office.</p></main></body></html>');
  assert.ok(out.ok);
  assert.equal(out.status, 'Case Was Transferred');
  assert.equal(out.kind, 'pending');
});

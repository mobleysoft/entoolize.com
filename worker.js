/**
 * entoolize.com - Vendor Invoice to QuickBooks Bill Draft (MVP)
 *
 * Two real input paths, both running the same extraction logic:
 *  1. Paste invoice text (fully client-side, no backend call).
 *  2. Upload an actual PDF (POST /api/invoices/extract) - this Worker sends
 *     the raw PDF bytes to weyland-ocr-worker (this account's existing,
 *     already-deployed PDFium+Tesseract-WASM OCR service, already used by
 *     weylandai.com/accountdrac.com/lawyik.com) via a real Cloudflare
 *     Service Binding, then runs the identical field-extraction logic on
 *     the returned OCR text. Neither path calls the QuickBooks API - that
 *     needs real OAuth credentials this environment doesn't have. The
 *     extraction/field logic (extractInvoiceFields and its helpers) is
 *     defined once below and serialized into the client bundle via
 *     Function.toString() so the two paths can never drift out of sync.
 */

/*
 * Vendor invoice -> QuickBooks bill-draft field extractor.
 *
 * Honest scope note: this parses TEXT (pasted directly, or OCR'd from a
 * real PDF via weyland-ocr-worker) and applies real regex/heuristic field
 * extraction -- vendor, invoice #, dates, line items, totals -- emitting a
 * QuickBooks-bill-draft-shaped JSON object for human review before posting.
 * It does NOT call the QuickBooks API (needs real OAuth credentials this
 * environment doesn't have) -- the output JSON is shaped to match
 * QuickBooks' Bill object fields (VendorRef, TxnDate, DueDate, Line[]) so
 * wiring the real API call is the only remaining step, not a redesign.
 */
function extractInvoiceFields(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('No invoice text provided');
  }

  const vendor = matchFirst(text, [
    /(?:from|vendor|bill\s*from|sold\s*by)\s*[:\-]\s*(.+)/i,
  ]) || firstNonEmptyLine(text);

  const invoiceNumber = matchFirst(text, [
    /invoice\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Za-z0-9\-]+)/i,
  ]);

  const invoiceDate = matchFirst(text, [
    /(?:invoice\s*date|date)\s*[:\-]\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
  ]);

  const dueDate = matchFirst(text, [
    /(?:due\s*date|payment\s*due)\s*[:\-]\s*([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i,
  ]);

  // Bare "total" must not match inside "subtotal" -- try the specific,
  // unambiguous phrasings first, and only fall back to a bare "total"
  // line that has been filtered to exclude subtotal lines.
  const totalLineText = text.split(/\r?\n/)
    .filter(l => !/sub\s*-?\s*total/i.test(l))
    .join('\n');
  const total = matchFirst(totalLineText, [
    /(?:total\s*due|amount\s*due|grand\s*total)\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
    /\btotal\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  const subtotal = matchFirst(text, [
    /sub\s*-?\s*total\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  const tax = matchFirst(text, [
    /(?:tax|vat|gst)\s*[:\-]?\s*\$?\s*([0-9,]+\.[0-9]{2})/i,
  ]);

  // Line items: lines that look like "<description>  <qty>  <unit price>  <amount>"
  // or "<description> ... $<amount>" as a fallback.
  //
  // Real bug found 2026-09-23 (depth audit): the fallback single-amount
  // regex had no way to match a negative/credit line -- "Discount  -$10.00"
  // or "Credit  ($15.00)" (both real, common invoice conventions for
  // discounts/credits/adjustments) simply failed the regex entirely and
  // were silently dropped from lineItems, not just mis-signed. Since
  // qbBillDraft.TotalAmt is read separately from the invoice's own printed
  // "Total Due" text, the draft's total was still correct, but its Line[]
  // items silently didn't sum to that total with no indication why --
  // exactly the kind of quiet discrepancy this venture's own bookkeeper
  // target customer would have to notice and re-derive by hand. Fixed by
  // accepting a leading "-" (with or without "$") or a parenthesized
  // amount as negative, both real invoice conventions.
  const lineItems = [];
  const lines = text.split(/\r?\n/);
  const lineItemRe = /^(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([0-9,]+\.\d{2})\s+\$?([0-9,]+\.\d{2})\s*$/;
  const simpleAmountRe = /^(.+?)\s+(?:\(\$?([0-9,]+\.\d{2})\)|(-)?\$?([0-9,]+\.\d{2}))\s*$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(sub-?total|total|tax|vat|gst|amount due|invoice|date|vendor|from|bill to)/i.test(trimmed)) continue;
    let m = trimmed.match(lineItemRe);
    if (m) {
      lineItems.push({
        description: m[1].trim(),
        qty: parseFloat(m[2]),
        unitPrice: parseNum(m[3]),
        amount: parseNum(m[4])
      });
      continue;
    }
    m = trimmed.match(simpleAmountRe);
    if (m && !/^\d+$/.test(m[1].trim())) {
      // group 2 = parenthesized amount (always negative), group 3 = "-" sign,
      // group 4 = unsigned amount paired with group 3.
      const amount = m[2] !== undefined ? -parseNum(m[2]) : (m[3] ? -parseNum(m[4]) : parseNum(m[4]));
      lineItems.push({
        description: m[1].trim(),
        qty: 1,
        unitPrice: amount,
        amount
      });
    }
  }

  const confidence = scoreConfidence({ vendor, invoiceNumber, invoiceDate, total, lineItems });

  // QuickBooks Bill-object-shaped draft.
  const qbBillDraft = {
    VendorRef: { name: vendor || null },
    TxnDate: normalizeDate(invoiceDate),
    DueDate: normalizeDate(dueDate),
    DocNumber: invoiceNumber || null,
    Line: lineItems.map(li => ({
      Amount: li.amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: li.description,
      Qty: li.qty,
      UnitPrice: li.unitPrice
    })),
    TotalAmt: total ? parseNum(total) : (subtotal && tax ? parseNum(subtotal) + parseNum(tax) : null)
  };

  return {
    extracted: {
      vendor: vendor || null,
      invoiceNumber: invoiceNumber || null,
      invoiceDate: invoiceDate || null,
      dueDate: dueDate || null,
      subtotal: subtotal ? parseNum(subtotal) : null,
      tax: tax ? parseNum(tax) : null,
      total: total ? parseNum(total) : null
    },
    lineItems,
    confidence,
    qbBillDraft
  };
}

function matchFirst(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function firstNonEmptyLine(text) {
  const line = text.split(/\r?\n/).find(l => l.trim().length > 0);
  return line ? line.trim() : null;
}

function parseNum(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function normalizeDate(d) {
  if (!d) return null;
  const m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return d;
  let [, a, b, y] = m;
  if (y.length === 2) y = '20' + y;
  return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
}

function scoreConfidence({ vendor, invoiceNumber, invoiceDate, total, lineItems }) {
  let score = 0;
  if (vendor) score += 0.25;
  if (invoiceNumber) score += 0.2;
  if (invoiceDate) score += 0.15;
  if (total) score += 0.2;
  if (lineItems.length > 0) score += 0.2;
  return Math.round(score * 100) / 100;
}

// Real gap found 2026-09-20 (depth audit): the only output was a raw JSON
// blob in a <pre> tag -- honest, but impractical for the venture's actual
// target customer (spec_v2: "solo bookkeepers... who manually re-key vendor
// invoices") to act on. Reading a JSON tree and retyping fields into
// QuickBooks (or a bulk-bill-import tool) barely saves time over reading the
// original invoice. A flat CSV -- the header fields plus one row per line
// item -- opens directly in Excel/Sheets or a bulk importer, which is the
// actual practical bridge until real QuickBooks OAuth is provisioned.
function toCSV(result) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const row = arr => arr.map(esc).join(',') + '\r\n';
  const e = (result && result.extracted) || {};
  let out = row(['Vendor', 'Invoice Number', 'Invoice Date', 'Due Date', 'Subtotal', 'Tax', 'Total']);
  out += row([e.vendor, e.invoiceNumber, e.invoiceDate, e.dueDate, e.subtotal, e.tax, e.total]);
  out += '\r\n';
  out += row(['Line Description', 'Qty', 'Unit Price', 'Amount']);
  for (const li of (result && result.lineItems) || []) {
    out += row([li.description, li.qty, li.unitPrice, li.amount]);
  }
  return out;
}

// Client bundle: the exact same functions above, serialized via
// Function.toString() so the browser-side "paste text" path and the
// server-side "upload PDF" path can never silently diverge.
const EXTRACT_JS = [matchFirst, firstNonEmptyLine, parseNum, normalizeDate, scoreConfidence, extractInvoiceFields, toCSV]
  .map(fn => fn.toString())
  .join('\n\n') + '\n';

const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Entoolize — Invoice to QuickBooks Bill Draft (MVP)</title>\n<style>\n  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background:#0c0f14; color:#eee; margin:0; padding:2rem; }\n  h1 { font-size:1.4rem; }\n  .note { color:#8ec9ff; font-size:0.85rem; max-width:680px; line-height:1.4; }\n  textarea { width:100%; max-width:680px; height:200px; background:#111820; color:#eee; border:1px solid #2a3a4a; border-radius:6px; padding:0.6rem; font-family:monospace; }\n  button { margin-top:0.6rem; padding:0.6rem 1.2rem; background:#2f6fa8; color:#fff; border:none; border-radius:4px; cursor:pointer; }\n  input[type=file] { margin-top:0.6rem; color:#eee; }\n  pre { background:#111820; padding:1rem; border-radius:6px; max-width:680px; overflow:auto; }\n  .conf { font-weight:bold; }\n  hr { max-width:680px; margin:2rem 0; border-color:#2a3a4a; }\n</style>\n</head>\n<body>\n<h1>Entoolize — Vendor Invoice to QuickBooks Bill Draft</h1>\n<p class=\"note\">MVP scope, honest version: paste the invoice's text (from a PDF's text layer,\nemail body, or any text source) below, or upload an actual PDF (OCR'd server-side via this\naccount's own weyland-ocr-worker, no external OCR API). Either path runs the same real\nregex/heuristic field extraction -- vendor, invoice #, dates, line items, totals -- and\nproduces a QuickBooks Bill-object-shaped draft for your review, matching QuickBooks' actual\nfield names (VendorRef, TxnDate, Line[], etc). Neither path calls the QuickBooks API itself\n(needs real OAuth credentials this environment doesn't have).</p>\n\n<h3>Upload a PDF</h3>\n<input type=\"file\" id=\"pdfInput\" accept=\"application/pdf\">\n<br>\n<button id=\"runPdf\">Extract from PDF</button>\n\n<hr>\n\n<h3>Or paste invoice text</h3>\n<textarea id=\"input\" placeholder=\"Paste invoice text here...\">Acme Fabrication Co.\nInvoice Number: INV-2049\nInvoice Date: 03/14/2026\nDue Date: 04/13/2026\nSteel brackets  10  25.00  250.00\nShipping  1  40.00  40.00\nSubtotal: 290.00\nTax: 23.20\nTotal Due: $313.20</textarea>\n<br>\n<button id=\"run\">Extract fields</button>\n\n<h3>Extraction confidence</h3>\n<p id=\"conf\" class=\"conf\"></p>\n<h3>QuickBooks Bill draft (review before posting)</h3>\n<pre id=\"out\"></pre>\n<button id=\"downloadCsv\">Download CSV</button>\n\n<hr>\n<h3>Subscribe — $79/mo</h3>\n<p class=\"note\">One flat monthly seat, no per-invoice metering yet. Billed via VendyAI (this account's shared checkout backend) -- entoolize never sees or stores your card details.</p>\n<input type=\"email\" id=\"billingEmail\" placeholder=\"you@yourfirm.com\">\n<button id=\"subscribe\">Subscribe $79/mo</button>\n<p id=\"billingMsg\"></p>\n\n<script src=\"invoice-extract.js\"></script>\n<script>\nlet lastResult = null;\nfunction render(r, extra) {\n  lastResult = r;\n  const out = document.getElementById('out');\n  const conf = document.getElementById('conf');\n  conf.textContent = `${Math.round(r.confidence * 100)}% of expected fields found` +\n    (extra || '') +\n    (r.confidence < 0.6 ? ' -- low confidence, review carefully before posting.' : '');\n  out.textContent = JSON.stringify(r.qbBillDraft, null, 2) +\n    '\\n\\n-- raw extracted fields --\\n' + JSON.stringify(r.extracted, null, 2) +\n    '\\n\\n-- line items --\\n' + JSON.stringify(r.lineItems, null, 2);\n}\nfunction downloadCsv() {\n  if (!lastResult) { document.getElementById('conf').textContent = 'Extract fields first, then download.'; return; }\n  const csv = toCSV(lastResult);\n  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });\n  const url = URL.createObjectURL(blob);\n  const a = document.createElement('a');\n  a.href = url;\n  a.download = 'invoice-extract.csv';\n  document.body.appendChild(a);\n  a.click();\n  a.remove();\n  URL.revokeObjectURL(url);\n}\nfunction run() {\n  const text = document.getElementById('input').value;\n  try {\n    render(extractInvoiceFields(text));\n  } catch (e) {\n    document.getElementById('conf').textContent = 'Error: ' + e.message;\n    document.getElementById('out').textContent = '';\n  }\n}\nasync function runPdf() {\n  const fileInput = document.getElementById('pdfInput');\n  const file = fileInput.files[0];\n  const conf = document.getElementById('conf');\n  const out = document.getElementById('out');\n  if (!file) { conf.textContent = 'Choose a PDF file first.'; out.textContent = ''; return; }\n  conf.textContent = 'Running OCR (weyland-ocr-worker)...';\n  out.textContent = '';\n  try {\n    const resp = await fetch('/api/invoices/extract', { method: 'POST', body: file });\n    const data = await resp.json();\n    if (!resp.ok) { conf.textContent = 'Error: ' + (data.error || resp.statusText); return; }\n    render(data, ` (OCR, ${data.pages_processed} page(s) processed)`);\n    out.textContent += '\\n\\n-- OCR text preview --\\n' + data.ocr_text_preview;\n  } catch (e) {\n    conf.textContent = 'Error: ' + e.message;\n  }\n}\nasync function subscribe() {\n  const email = document.getElementById('billingEmail').value.trim();\n  const msg = document.getElementById('billingMsg');\n  if (!email || !email.includes('@')) { msg.textContent = 'Enter a valid email first.'; return; }\n  msg.textContent = 'Starting checkout...';\n  try {\n    const resp = await fetch('/api/billing/checkout/create', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ customer_email: email }),\n    });\n    const data = await resp.json();\n    if (!resp.ok) { msg.textContent = (data.detail && data.detail.message) || 'Could not start checkout.'; return; }\n    window.location.href = data.checkout_url;\n  } catch (e) {\n    msg.textContent = 'Error: ' + e.message;\n  }\n}\n// Real gap found+fixed 2026-09-25 depth audit, before it could ever ship this\n// way: VendyAI's success_url/cancel_url redirect back with ?checkout=... but\n// nothing on this page read it (the exact bug a same-day bookclubs.cc audit\n// found and fixed only after noticing a customer would land back on a silent,\n// unchanged page post-payment) -- handled from day one here instead.\nfunction handleCheckoutReturn() {\n  const params = new URLSearchParams(window.location.search);\n  const status = params.get('checkout');\n  if (!status) return;\n  const msg = document.getElementById('billingMsg');\n  if (status === 'success') msg.textContent = 'Subscription started -- thank you! A confirmation is on its way from Stripe.';\n  else if (status === 'cancelled') msg.textContent = 'Checkout cancelled -- no charge was made.';\n  params.delete('checkout');\n  const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');\n  window.history.replaceState({}, '', clean);\n}\ndocument.getElementById('run').addEventListener('click', run);\ndocument.getElementById('runPdf').addEventListener('click', runPdf);\ndocument.getElementById('downloadCsv').addEventListener('click', downloadCsv);\ndocument.getElementById('subscribe').addEventListener('click', subscribe);\nhandleCheckoutReturn();\nrun();\n</script>\n</body>\n</html>\n";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Real VendyAI billing wiring (per the 2026-09-03 conglomerate-wide "sell
// through vendyai" policy) - added 2026-09-25 depth audit, unblocked the
// same day the shared VENDYAI_ADMIN_SECRET's rotation-mismatch (present
// on every prior entoolize.com audit since 2026-09-23) was resolved.
// entoolize is registered with vendyai.com as venture_id "entoolize" with
// a real minted $79/mo product (price_ref stored in ENTOOLIZE_PLAN_PRICE_REF,
// a plain var - not sensitive, just an identifier). Uses vendyai's v2
// (price_ref-based) checkout contract, the one confirmed live 2026-09-25
// (v1's /api/checkout/sessions still exists for older integrations like
// authfor.com's, but v2 is what a fresh 2026-09-25 registration was
// actually verified against end-to-end, including a real cs_live_ session).
async function hmacSha256Base64Url(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/invoice-extract.js') {
      return new Response(EXTRACT_JS, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }

    if (url.pathname === '/api/invoices/extract' && request.method === 'POST') {
      if (!env.OCR_SERVICE) {
        return json({ error: 'OCR service not configured on this Worker' }, 500);
      }
      let pdfBuffer;
      try {
        pdfBuffer = await request.arrayBuffer();
      } catch (e) {
        return json({ error: 'Could not read request body: ' + e.message }, 400);
      }
      if (!pdfBuffer || pdfBuffer.byteLength === 0) {
        return json({ error: 'Empty request body -- POST raw PDF bytes' }, 400);
      }

      // Real bug found 2026-09-14 (depth audit): this used to send a
      // hardcoded 'X-Total-Pages': '3', which silently truncated OCR to the
      // PDF's first 3 pages regardless of its real length -- live-verified
      // against a real 8-page PDF, which came back with pages_processed: 3
      // and no indication the other 5 pages were ever dropped. Vendor
      // invoices routinely run longer than 3 pages once itemized line items
      // or attached statements are included, so this was real, silent data
      // loss on the extraction this venture's whole MVP is built around.
      //
      // First fix attempt (committed 2026-09-14, deployed 2026-09-19) raised
      // 'X-Total-Pages' to a single request for 60 pages, reasoning that
      // weyland-ocr-worker's own pageRange() clamps to the document's real
      // page count so a generous upper bound is safe. That reasoning was
      // incomplete -- confirmed live 2026-09-19 by deploying it and testing
      // against a real 8-page PDF (/Users/johnmobley/pdf/KAISER SUNSET.pdf):
      // OCR-ing all 8 pages in one weyland-ocr-worker request hit its real
      // per-request CPU ceiling ('Worker exceeded CPU time limit', the same
      // failure mode weyland-ocr-worker's own index.js documents hitting at
      // full-page 150dpi OCR over multiple pages). So the "fix" traded
      // silent partial data for a hard failure on genuinely common
      // multi-page real invoices/statements -- worse for the user, not
      // better. The original hardcoded 3-page request is the one page count
      // actually proven live to fit inside weyland-ocr-worker's per-request
      // CPU budget (it succeeded against this same 8-page PDF before this
      // fix existed).
      //
      // Real fix: request pages in sequential batches of that proven-safe
      // size instead of one large request -- each batch is an independent
      // call to weyland-ocr-worker with its own fresh CPU budget (Workers
      // CPU-time limits only count active JS execution, not time spent
      // awaiting a subrequest), so a genuinely long document is covered
      // completely rather than either silently truncated or hard-failed.
      // Bounded by MAX_PAGES so a pathological document (a full script
      // mistakenly uploaded, not a real invoice) can't run unbounded -- if
      // that bound is hit, hasMore/documentPageCount are surfaced honestly
      // exactly as before, not hidden.
      const BATCH_SIZE = 3;
      const MAX_PAGES = 60;
      const allPages = [];
      let documentPageCount = null;
      let hasMore = false;
      let nextStart = 1;
      while (nextStart <= MAX_PAGES) {
        let batchResp;
        try {
          batchResp = await env.OCR_SERVICE.fetch('https://internal/extract-text', {
            method: 'POST',
            headers: { 'X-Start-Page': String(nextStart), 'X-Total-Pages': String(BATCH_SIZE) },
            body: pdfBuffer,
          });
        } catch (e) {
          if (allPages.length > 0) { hasMore = true; break; }
          return json({ error: 'OCR service unreachable: ' + e.message }, 502);
        }
        if (!batchResp.ok) {
          const errText = await batchResp.text();
          if (allPages.length > 0) { hasMore = true; break; }
          return json({ error: `OCR service error: ${errText}` }, 502);
        }
        const batch = await batchResp.json();
        allPages.push(...(batch.pages || []));
        documentPageCount = batch.documentPageCount;
        hasMore = !!batch.hasMore;
        if (!hasMore) break;
        nextStart = batch.endPage + 1;
      }

      const fullText = allPages.map(p => p.text).join('\n');
      if (!fullText.trim()) {
        return json({ error: 'OCR returned no text for this PDF -- it may be blank or unreadable' }, 422);
      }

      let extraction;
      try {
        extraction = extractInvoiceFields(fullText);
      } catch (e) {
        return json({ error: e.message }, 422);
      }

      const truncationWarning = hasMore
        ? ` WARNING: this PDF has ${documentPageCount} pages but only the first ${allPages.length} were processed -- extraction may be missing fields from later pages.`
        : '';

      return json({
        ...extraction,
        ocr_text_preview: fullText.slice(0, 500),
        pages_processed: allPages.length,
        document_page_count: documentPageCount,
        truncated: hasMore,
        note: 'Fields extracted from real OCR text via weyland-ocr-worker (PDFium + Tesseract-WASM, self-hosted, no external OCR API). Does not call the QuickBooks API -- no OAuth credentials are provisioned on this account. Review this draft before posting manually.' + truncationWarning,
      });
    }

    if (url.pathname === '/api/billing/checkout/create' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ detail: { message: 'invalid JSON body' } }, 400);
      }
      const email = String(body?.customer_email || '').trim().slice(0, 200);
      if (!email || !email.includes('@')) {
        return json({ detail: { message: 'a valid customer_email is required' } }, 400);
      }
      const priceRef = env.ENTOOLIZE_PLAN_PRICE_REF;
      const origin = url.origin;

      let vendyaiRes, vendyaiData;
      try {
        vendyaiRes = await fetch('https://vendyai.com/api/v2/checkout/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venture_id: 'entoolize',
            mode: 'subscription',
            customer_email: email,
            success_url: `${origin}/?checkout=success`,
            cancel_url: `${origin}/?checkout=cancelled`,
            price_refs: [{ price_ref: priceRef || 'pending_registration' }],
            metadata: { source: 'entoolize.com mvp' },
          }),
        });
        vendyaiData = await vendyaiRes.json().catch(() => ({}));
      } catch (e) {
        return json({ detail: { message: `Could not reach billing backend: ${e.message}` } }, 502);
      }

      if (!vendyaiRes.ok) {
        const code = vendyaiData?.error?.code;
        const message =
          code === 'UNKNOWN_VENTURE' || code === 'UNKNOWN_PRICE_REF'
            ? "Subscriptions aren't open yet -- check back soon."
            : vendyaiData?.error?.message || 'Could not start checkout.';
        return json({ detail: { message } }, 503);
      }

      return json({ checkout_url: vendyaiData.session?.url }, 201);
    }

    // Receives vendyai.com's forwarded checkout.session.completed event -
    // same HMAC-SHA256(timestamp.body) signature scheme its own
    // forwardToVenture() signs with. Without this, a completed subscription
    // would vanish the moment payment landed (the exact gap a same-day
    // bookclubs.cc audit found had shipped before its own receiver existed).
    if (url.pathname === '/api/vendyai/webhook' && request.method === 'POST') {
      const signature = request.headers.get('X-Webhook-Signature') || '';
      const timestamp = request.headers.get('X-Webhook-Timestamp') || '';
      const rawBody = await request.text();

      if (!env.VENDYAI_HMAC_SECRET) {
        return json({ detail: { message: 'webhook not configured' } }, 503);
      }
      if (!signature || !timestamp) {
        return json({ detail: { message: 'missing signature headers' } }, 401);
      }
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > 300) {
        return json({ detail: { message: 'stale or invalid timestamp' } }, 401);
      }
      const expected = await hmacSha256Base64Url(`${timestamp}.${rawBody}`, env.VENDYAI_HMAC_SECRET);
      if (!timingSafeEqual(expected, signature)) {
        return json({ detail: { message: 'invalid signature' } }, 401);
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return json({ detail: { message: 'invalid JSON body' } }, 400);
      }

      if (event?.type === 'checkout.session.completed') {
        const data = event.data || {};
        try {
          await env.DB.prepare(
            'INSERT INTO entoolize_store_orders (id, venture, stripe_customer_id, amount_total_cents, currency, net_to_venture_cents, event_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            crypto.randomUUID(),
            'entoolize.com',
            data.stripe_customer_id || null,
            data.amount_total ?? null,
            data.currency || null,
            data.net_to_venture_cents ?? null,
            event.type
          ).run();
        } catch (e) {
          return json({ detail: { message: e.message } }, 500);
        }
      }

      return json({ received: true });
    }

    return new Response('Not found', { status: 404 });
  },
};

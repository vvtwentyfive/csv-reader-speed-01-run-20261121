// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answer as csv-reader's readCsv for every input {text, header}:
// {columns, rows, errors}. The reference reads one character at a time and
// builds every field with `value += c`; this one scans with native indexOf
// searches and slices fields out, so the common path (plain unquoted fields,
// plain quoted fields) never touches a character at a time. The slow paths
// (lone CRs, multi-line quoted fields, unterminated quotes) stay exact, they
// are just rare by construction of the generator.
//
// Semantics, kept exactly (see the reference, vendor/csv-reader/index.js):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr, and the
//   line is NOT advanced by it).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote; each CRLF or lone CR inside it is read as LF
//   (and advances the line); what follows its closing quote up to the next
//   comma or line break is appended as it stands (quote_junk, when the field
//   ends, iff any junk characters were kept); a quote that never closes is a
//   literal character and the text after it is read again as unquoted
//   (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it, each padded with "" (short_row, with fields: its count)
//   or cut (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on (every LF, CRLF and lone CR inside quotes
//   counted), row its record's index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. One case is answered alone. No caching between cases.
//
// Speed notes (measured on the kit's practice set, 6 cases, ~11.1 MB):
// - The unquoted-field scan takes the nearer of the next ',' / LF with two
//   indexOf calls, then checks for a CR inside that short span only (a slice
//   view, no copy). An unbounded indexOf('\r') was measured slower, and a
//   regex delimiter search slower still.
// - Field results travel in a shared slot (uEnded/uAdded) instead of a fresh
//   array per field, so the hot loop allocates nothing but the answer itself.

/** Ended codes for a field: comma, line break, end of text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null:
  // the header). Errors raised while reading it carry these two.
  let recordLine = 1;
  let recordRow = null;

  // The last field's ending and kept-character count, shared so the hot loop
  // allocates no result array per field. Read immediately after each call.
  let uEnded = 0;
  let uAdded = 0;

  // Count the line breaks in `s` (each LF, each CRLF, each lone CR is one)
  // and return `s` with every CRLF / lone CR replaced by LF. Only called for
  // quoted segments that hold a break, which the generator makes rare.
  function foldBreaks(s) {
    let out = s;
    if (s.indexOf('\r') !== -1) out = s.replace(/\r\n?/g, '\n');
    let breaks = 0;
    let i = out.indexOf('\n');
    while (i !== -1) {
      breaks++;
      i = out.indexOf('\n', i + 1);
    }
    return [out, breaks];
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field value;
  // its ending lands in uEnded, the characters kept in uAdded (the
  // quote_junk test reads it; it counts this call's kept characters only).
  function readUnquoted(value, added) {
    let start = pos;
    let segs = null; // kept pieces, once a lone CR has been dropped
    for (;;) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let end = len;
      let kind = END;
      if (ci !== -1 && (ni === -1 || ci < ni)) {
        end = ci;
        kind = COMMA;
      } else if (ni !== -1) {
        end = ni;
        kind = LINE_BREAK;
      }
      // A CR before that end is either the CRLF that ends the record or a
      // lone CR to drop; look only inside this field's short span.
      let ri = -1;
      if (end > pos) ri = text.slice(pos, end).indexOf('\r');
      if (ri !== -1) {
        const ridx = pos + ri;
        if (ridx + 1 < len && text.charCodeAt(ridx + 1) === 10) {
          // CRLF: the field and the record end here.
          if (segs === null) value += text.slice(start, ridx);
          else {
            segs.push(text.slice(start, ridx));
            value = segs.join('');
          }
          added += ridx - start;
          pos = ridx + 2;
          line += 1;
          uEnded = LINE_BREAK;
          uAdded = added;
          return value;
        }
        // Lone CR: dropped, and the scan goes on from just after it.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (segs === null) segs = [value, text.slice(start, ridx)];
        else segs.push(text.slice(start, ridx));
        added += ridx - start;
        pos = ridx + 1;
        start = pos;
        continue;
      }
      if (kind === END) {
        if (segs === null) value += text.slice(start);
        else {
          segs.push(text.slice(start));
          value = segs.join('');
        }
        added += len - start;
        pos = len;
        uEnded = END;
        uAdded = added;
        return value;
      }
      if (segs === null) value += text.slice(start, end);
      else {
        segs.push(text.slice(start, end));
        value = segs.join('');
      }
      added += end - start;
      if (kind === COMMA) {
        pos = end + 1;
        uEnded = COMMA;
      } else {
        pos = end + 1;
        line += 1;
        uEnded = LINE_BREAK;
      }
      uAdded = added;
      return value;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // value; its ending lands in uEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    const parts = [];
    let closed = false;
    let closeAt = -1;
    for (;;) {
      const qi = text.indexOf('"', pos);
      if (qi === -1) break;
      if (qi + 1 < len && text.charCodeAt(qi + 1) === 34) {
        // Doubled quote: one literal quote.
        const seg = text.slice(start, qi);
        if (seg !== '') {
          if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) parts.push(seg);
          else {
            const fb = foldBreaks(seg);
            line += fb[1];
            parts.push(fb[0]);
          }
        }
        parts.push('"');
        pos = qi + 2;
        start = pos;
        continue;
      }
      closeAt = qi;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"', 0);
    }
    const seg = text.slice(start, closeAt);
    let value;
    if (parts.length === 0) {
      if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
        // Fast path: no line break inside the quotes at all.
        value = seg;
      } else {
        const fb = foldBreaks(seg);
        line += fb[1];
        value = fb[0];
      }
    } else {
      if (seg !== '') {
        if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) parts.push(seg);
        else {
          const fb = foldBreaks(seg);
          line += fb[1];
          parts.push(fb[0]);
        }
      }
      value = parts.join('');
    }
    pos = closeAt + 1;
    if (pos >= len) {
      uEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      uEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      uEnded = LINE_BREAK;
      return value;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      uEnded = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value, 0);
    if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted('', 0));
    } while (uEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

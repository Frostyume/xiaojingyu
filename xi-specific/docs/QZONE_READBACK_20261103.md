# Changes

## compareQzoneText: add `line-end-space-folding` mode

`compareQzoneText(expected, actual)` now classifies string pairs in this order:

1. `exact` — identical.
2. `line-break-folding` — identical after removing CRLF/CR/LF (unchanged precedence).
3. `line-end-space-folding` — identical after additionally removing ASCII U+0020
   spaces immediately before a CRLF/CR/LF on both strings, then applying the same
   line-break removal.
4. `different` — otherwise, or if either input is not a string.

Only spaces directly adjacent to a line break are discarded. The following are
still `different`:

- trailing spaces at end of EOF (no line break after them)
- interior spaces, tabs, NBSP (U+00A0) and other whitespace
- word or punctuation differences

Counts (character / UTF-16 / CRLF / CR / LF) and raw lengths are reported from the
original strings, untouched. `qzoneReadback` receipts remain free of raw body text;
`text_basis` is now `exact-CRLF-CR-LF-removal-or-line-end-space-folding`. The
`trustedSelfId` parameter stays configurable via `installation-config.mjs`; no
account id is hardcoded.

## Tests: `test-qzone-public.mjs`

Synthetic-only (self id `123450001`, no network, no real identity). Covers
positive exact / CRLF-fold / spaces+newline-fold cases and negative EOF, interior
space, tab, NBSP, word and punctuation cases; plus `qzoneReadback` verification
with same id and a trusted-matching source, and rejection for a wrong configured
id, mismatched source, missing config and a non-unique list entry.

Run: `node --test test-qzone-public.mjs` — 17 tests, 17 pass, 0 fail.

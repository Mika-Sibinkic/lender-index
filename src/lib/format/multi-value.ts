/**
 * Free-text ⇄ string[] for multi-value fields (Geographic target, etc).
 *
 * Reported symptom: "Geographic Target area will not allow spaces."
 *
 * The cause was a controlled input whose value was re-derived on every
 * keystroke: `value={arr.join(', ')}` with `onChange={split(',').map(trim)}`.
 * Type a space and it is trimmed straight back out before the character can
 * render, so multi-word entries like "United States" or "New York" were
 * literally untypable. The field was only usable by people who already knew to
 * paste.
 *
 * Two rules follow, and they generalise to every free-text→array field:
 *   1. Hold a RAW text buffer while the user types. Never normalise mid-entry.
 *      Commit to the array on blur (see MultiValueInput).
 *   2. Normalise LIBERALLY on commit. `parseUsageCodes` already sets the house
 *      pattern — accept comma, semicolon, slash and newline — so a user typing
 *      "US / Brazil" or pasting a column out of Excel gets what they meant
 *      instead of one nonsense entry. A silent format expectation is a
 *      data-entry error waiting to happen.
 */

/** Delimiters accepted between values. NOT space — values contain spaces. */
const DELIMITERS = /[,;/\n\r\t]+/

export function splitMultiValue(text: string): string[] {
  return text
    .split(DELIMITERS)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Canonical display form of a committed array. */
export function joinMultiValue(values: readonly string[]): string {
  return values.join(', ')
}

/**
 * True when `text` still says exactly what `values` says. Used to decide whether
 * an externally-changed array (an AI parse landing in the card) should overwrite
 * what the user currently has in the box — it should not clobber live typing.
 */
export function multiValueMatches(text: string, values: readonly string[]): boolean {
  const a = splitMultiValue(text)
  return a.length === values.length && a.every((v, i) => v === values[i])
}

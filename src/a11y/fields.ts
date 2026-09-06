/**
 * Error-to-field wiring shared by the interactive workspaces.
 *
 * A blocking message is rendered exactly once, in the place a sighted user
 * expects it (the requirement aside, the edit alert). The control that caused
 * it points at that text with `aria-describedby`, so assistive technology
 * announces the reason while the field has focus, and `aria-invalid` marks the
 * field itself as the thing to fix.
 */
export interface FieldDescription {
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

/**
 * Builds the pair of attributes for one control. Empty and duplicate ids are
 * dropped so callers can pass conditional values without guarding each one,
 * and a control with nothing wrong with it stays unmarked.
 */
export function describeField(
  ids: readonly (string | false | undefined | null)[],
): FieldDescription {
  const listed = ids.filter((id): id is string => Boolean(id));
  const unique = [...new Set(listed)];
  if (unique.length === 0) return {};
  return { "aria-invalid": true, "aria-describedby": unique.join(" ") };
}

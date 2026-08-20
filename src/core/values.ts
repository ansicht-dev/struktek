/**
 * Checking the values a caller supplied, before they become a prompt.
 *
 * `analyze()` already refuses a pinned default that is not a real option or a
 * real block instance — `validatePin` has done that since the beginning. The
 * same rule was never applied to values arriving at compose time, which is the
 * one place a typo actually comes from: a person picks from a dropdown, but an
 * agent types the value.
 *
 * Left unchecked, the two closed types failed in different and equally quiet
 * ways. An unknown block instance rendered as nothing, leaving a dangling
 * sentence behind it. An unknown choice rendered verbatim, so `focus=bananas`
 * produced a perfectly plausible prompt asking for the wrong thing.
 *
 * Only `choice` and `blockType` are checked, because only they have a knowable
 * set of legal values. `text`, `block`, `file` and `number` accept whatever the
 * caller meant, and guessing at what a number ought to look like would reject
 * input somebody had a reason for.
 */

import type { Field } from './types';

export interface ValueProblem {
  readonly field: string;
  readonly value: string;
  /** Written for whoever passed the value, and naming what would have worked. */
  readonly message: string;
}

export interface ValidateValuesOptions {
  /** Block type name to its instance names. Without it, block values pass. */
  readonly blockTypes?: ReadonlyMap<string, readonly string[]>;
}

export function validateValues(
  fields: readonly Field[],
  values: Readonly<Record<string, string | undefined>>,
  opts: ValidateValuesOptions = {},
): ValueProblem[] {
  const problems: ValueProblem[] = [];

  for (const field of fields) {
    const value = values[field.name]?.trim();
    // Absent is not wrong: an optional field may be omitted, and an omitted
    // field with a pin uses a default `analyze()` has already validated.
    if (value === undefined || value.length === 0) continue;

    if (field.type.kind === 'choice') {
      if (!field.type.options.includes(value)) {
        problems.push({
          field: field.name,
          value,
          message:
            '"' + value + '" is not one of the options for "' + field.name + '". ' +
            'Use one of: ' + field.type.options.join(', ') + '.',
        });
      }
      continue;
    }

    if (field.type.kind === 'blockType') {
      const instances = opts.blockTypes?.get(field.type.name);
      // No library scanned means nothing to check against, which is not the
      // same as the value being wrong.
      if (!instances) continue;
      if (!instances.includes(value)) {
        problems.push({
          field: field.name,
          value,
          message:
            '"' + value + '" is not a value of "' + field.type.name + '". ' +
            'Use one of: ' +
            (instances.length > 0 ? instances.join(', ') : '(none defined yet)') +
            '.',
        });
      }
    }
  }

  return problems;
}

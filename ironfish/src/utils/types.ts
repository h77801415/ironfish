/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Equivilent to the builtin Partial<T> just recursive.
 *
 * @see https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype
 */
export type PartialRecursive<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? PartialRecursive<U>[]
    : T[P] extends Record<string, unknown>
    ? PartialRecursive<T[P]>
    : T[P]
}

/**
 * Converts a type from Promise<T> to T.
 *
 * This does not unwrap recursively.
 */
export type UnwrapPromise<T> = T extends Promise<infer U>
  ? U
  : T extends (...args: unknown[]) => Promise<infer U>
  ? U
  : T extends (...args: unknown[]) => infer U
  ? U
  : T

/**
 * The return type of setTimeout, this type be used with clearTimeout
 *
 * This exists because the return type is different on the web versus node
 * */
export type SetTimeoutToken = ReturnType<typeof setTimeout>

export function IsNodeTimeout(timer: number | NodeJS.Timeout): timer is NodeJS.Timeout {
  return typeof timer !== 'number'
}

import { Maybe } from "./models/types";

export function isDefined<T>(type: Maybe<T>): type is T {
  return type !== null && type !== undefined;
}

export function isNotDefined<T>(type: Maybe<T>): type is null | undefined {
  return type === null || type === undefined;
}

import { Maybe } from "./models/types";

type FillableStructure = string | unknown[] | object;

export function isDefined<T>(type: Maybe<T>): type is T {
  return type !== null && type !== undefined;
}

export function isNotDefined<T>(type: Maybe<T>): type is null | undefined {
  return type === null || type === undefined;
}

export function isEmptyOrNotDefined(param: Maybe<FillableStructure>): boolean {
  return isNotDefined(param) || isEmpty(param);
}

export function isEmpty(param: FillableStructure): boolean {
  if (typeof param === "string") {
    return param === "";
  } else if (Array.isArray(param)) {
    return param.length === 0;
  } else {
    return Object.keys(param).length === 0;
  }
}

export function isEmptyOrNotDefined2(param: unknown): boolean {
  switch (typeof param) {
    case "undefined":
      return true;
    case "number":
      return isNaN(param);
    case "string":
      return param === "";
    case "object": {
      if (param === null) {
        return true;
      } else if (Array.isArray(param)) {
        return param.length === 0;
      } else {
        return Object.keys(param).length === 0;
      }
    }
    default:
      return false;
  }
}

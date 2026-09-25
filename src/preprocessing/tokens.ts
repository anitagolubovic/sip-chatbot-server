import { getEncoding, type Tiktoken, type TiktokenEncoding } from "js-tiktoken";
import { Maybe } from "../models/types";
import { isNotDefined } from "../helper";

const LEGACY_ENCODING_MODELS = /^(gpt-4(?![.o])|gpt-3\.5|text-embedding-)/;
const DEFAULT_ENCODING: TiktokenEncoding = "o200k_base";

const encoders = new Map<TiktokenEncoding, Tiktoken>();

export function encodingForModel(model: Maybe<string>): TiktokenEncoding {
  if (isNotDefined(model) || model.trim().length === 0) {
    return DEFAULT_ENCODING;
  }
  return LEGACY_ENCODING_MODELS.test(model.trim())
    ? "cl100k_base"
    : DEFAULT_ENCODING;
}

function getEncoder(encoding: TiktokenEncoding): Tiktoken {
  const cached = encoders.get(encoding);
  if (isNotDefined(cached)) {
    const encoder = getEncoding(encoding);
    encoders.set(encoding, encoder);
    return encoder;
  }
  return cached;
}

export function countTokens(
  text: string,
  model: Maybe<string> = process.env.OPENAI_MODEL,
): number {
  if (isNotDefined(text)) {
    return 0;
  }
  return getEncoder(encodingForModel(model)).encode(text).length;
}

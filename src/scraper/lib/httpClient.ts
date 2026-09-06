import axios from "axios";
import { Maybe } from "../../models/types";
import { isNotDefined } from "../../helper";

export const SITE_ORIGIN = "https://sip.elfak.ni.ac.rs";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export function getAbsoluteUrl(
  href: Maybe<string>,
  base: string = SITE_ORIGIN,
): Maybe<string> {
  if (isNotDefined(href) || href.startsWith("#")) {
    return null;
  }
  if (/^(mailto|tel|sms|javascript):/i.test(href)) {
    return null;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function fetchHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: { "User-Agent": USER_AGENT },
    responseType: "text",
    timeout: 30000,
  });
  return response.data;
}

export async function fetchPdf(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    headers: { "User-Agent": USER_AGENT },
    responseType: "arraybuffer",
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

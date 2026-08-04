import axios from "axios";

export const SITE_ORIGIN = "https://sip.elfak.ni.ac.rs";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export function absoluteUrl(
  href: string | undefined,
  base: string = SITE_ORIGIN,
): string | null {
  if (!href || href.startsWith("#")) {
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
    timeout: 30_000,
  });
  return response.data;
}

export async function fetchPdf(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, {
    headers: { "User-Agent": USER_AGENT },
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  return Buffer.from(response.data);
}

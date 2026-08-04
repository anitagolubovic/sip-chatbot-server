import * as cheerio from "cheerio";
import { absoluteUrl } from "./httpClient";
import { cleanText } from "./textNormalization";

export type PdfLink = { label: string; url: string };

export function pdfLinks($: cheerio.CheerioAPI, base?: string): PdfLink[] {
  const links: PdfLink[] = [];
  $('a[href$=".pdf"]').each((_, element) => {
    const url = absoluteUrl($(element).attr("href"), base);
    if (url) {
      links.push({ label: cleanText($(element).text()), url });
    }
  });
  return links;
}

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { absoluteUrl } from "./httpClient";
import { cleanText, latinSearchText } from "./textNormalization";

export type ArticleLink = { label: string; url: string };

export type ArticleContent = {
  text: string;
  paragraphs: string[];
  listItems: string[];
  links: ArticleLink[];
};

function contentScore($: cheerio.CheerioAPI, element: AnyNode): number {
  const candidate = $(element);
  const textLength = cleanText(candidate.text()).length;
  const contentBlocks = candidate.find("p, li, table, blockquote").length;
  const linkTextLength = cleanText(candidate.find("a").text()).length;
  const nestedContainers = candidate.find("div, section, article, main").length;

  if (contentBlocks === 0 || textLength < 80) return Number.NEGATIVE_INFINITY;
  return textLength + contentBlocks * 120 - linkTextLength * 0.5 - nestedContainers * 25;
}

/** Finds the article by document semantics, then by content density. */
function findArticleScope($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const bestCandidate = (selector: string) => {
    const candidates = $(selector).toArray();
    if (!candidates.length) return null;
    return candidates.reduce((best, candidate) =>
      contentScore($, candidate) > contentScore($, best) ? candidate : best,
    );
  };

  const semantic = bestCandidate('article, main, [role="main"]');
  if (semantic && Number.isFinite(contentScore($, semantic))) {
    return $(semantic);
  }

  const denseContent = bestCandidate("section, div");
  return denseContent && Number.isFinite(contentScore($, denseContent))
    ? $(denseContent)
    : $("body");
}

function isPublicationTimestamp(text: string): boolean {
  const value = latinSearchText(text);
  return /^(?:(?:pon|uto|sre|cet|pet|sub|ned),?\s+)?\d{1,2}\.\s+\S+,?\s+20\d{2}\.?\s+(?:u\s+)?\d{1,2}:\d{2}$/.test(
    value,
  );
}

export function extractArticle(
  html: string,
  pageUrl: string,
): ArticleContent {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const scope = findArticleScope($);

  scope.find("p, time").each((_, element) => {
    if (isPublicationTimestamp($(element).text())) {
      $(element).remove();
    }
  });

  const links: ArticleLink[] = [];
  const seen = new Set<string>();
  scope.find("a[href]").each((_, element) => {
    const url = absoluteUrl($(element).attr("href"), pageUrl);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    links.push({
      label: cleanText($(element).text()) || url.split("/").pop() || url,
      url,
    });
  });

  const textFrom = (selector: string): string[] =>
    scope
      .find(selector)
      .toArray()
      .map((element) => cleanText($(element).text()))
      .filter(Boolean);

  return {
    text: cleanText(scope.text()),
    paragraphs: textFrom("p"),
    listItems: textFrom("li"),
    links,
  };
}

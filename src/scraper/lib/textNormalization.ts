export function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(text: string): string {
  return latinSearchText(text)
    .replace(/đ/g, "dj")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function latinSearchText(text: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    ђ: "dj",
    е: "e",
    ж: "z",
    з: "z",
    и: "i",
    ј: "j",
    к: "k",
    л: "l",
    љ: "lj",
    м: "m",
    н: "n",
    њ: "nj",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    ћ: "c",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "c",
    џ: "dz",
    ш: "s",
  };
  return cleanText(text)
    .toLowerCase()
    .split("")
    .map((character) => map[character] ?? character)
    .join("")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

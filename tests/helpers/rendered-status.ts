/** The visible label in the Status definition on a work or approval page. */
export function statusOn(html: string): string | undefined {
  return /<dt\b[^>]*>Status<\/dt>\s*<dd\b[^>]*>\s*<span\b[^>]*>([^<]+)<\/span>/
    .exec(html.replaceAll('<!-- -->', ''))?.[1]
    ?.trim();
}

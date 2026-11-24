// A Graph continuation link, reduced to a path on graph.microsoft.com under one of the paths it may continue.
// Anything else is refused, so a link in a response can never send a token to another host or resource.
import { SyncUnavailable } from '../index';
import { requiredText } from '../runtime/provider-oauth';

export function graphLink(value: unknown, paths: readonly string[]): string {
  try {
    const raw = requiredText(value, 16_384),
      url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'graph.microsoft.com' ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      url.hash ||
      !paths.some(
        (path) =>
          url.pathname === path ||
          (url.pathname.startsWith(path + '(') &&
            /^\([^/]*\)$/.test(url.pathname.slice(path.length))),
      )
    )
      throw new Error('INVALID_LINK');
    return url.pathname + url.search;
  } catch {
    throw new SyncUnavailable('PROVIDER_RESPONSE_INVALID');
  }
}

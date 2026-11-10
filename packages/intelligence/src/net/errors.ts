// What the guard throws. Apart from guard.ts so an adapter can recognize them without importing undici,
// which lint keeps inside this folder's guard. The messages are fixed, and name no host, address or URL:
// the adapter maps these to a code, but nothing here should be worth reading if one ever escaped.

/** The guard would not let this request go out, or a provider tried to send it somewhere else. */
export class EndpointRefused extends Error {
  override name = 'EndpointRefused';
  /** True only for a redirect: the provider had already read the request to answer with one. */
  readonly afterRequest: boolean;
  constructor(input: { afterRequest: boolean } = { afterRequest: false }) {
    super('Endpoint refused');
    this.afterRequest = input.afterRequest;
  }
}

/** The name did not resolve, so nothing was sent. */
export class EndpointUnreachable extends Error {
  override name = 'EndpointUnreachable';
  constructor() {
    super('Endpoint unreachable');
  }
}

/** A response went over the guard's limit, so a hostile endpoint cannot fill this process's memory. */
export class ResponseTooLarge extends Error {
  override name = 'ResponseTooLarge';
  constructor() {
    super('Response too large');
  }
}

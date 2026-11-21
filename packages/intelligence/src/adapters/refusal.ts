// Thrown inside an adapter before any request goes out, when a call cannot be made as it was asked: a model
// ID or a key of the wrong shape for its kind, or a kind with no chat protocol. It carries no text, so the
// adapter's catch reports it as `bad_request`, with nothing billed, like any other failure before a send.
export class ProviderCallRefused extends Error {
  override name = 'ProviderCallRefused';
  constructor() {
    super('PROVIDER_CALL_REFUSED');
  }
}

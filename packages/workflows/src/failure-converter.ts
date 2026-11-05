// Loaded by path, in the worker and inside the workflow sandbox. Temporal ignores a converter object
// passed directly in dataConverter, which would leave error messages readable in its database.
import { DefaultFailureConverter } from '@temporalio/common';

export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });

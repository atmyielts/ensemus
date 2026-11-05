import { getRuntime } from '@/server/runtime';

export const GET = (request: Request) => getRuntime().auth.handler(request);
export const POST = (request: Request) => getRuntime().auth.handler(request);

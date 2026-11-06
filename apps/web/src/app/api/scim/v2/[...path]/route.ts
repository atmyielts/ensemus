import { handleScim } from '@/server/scim';
export const runtime = 'nodejs';
const handle = (request: Request) => handleScim(request, undefined, true);
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

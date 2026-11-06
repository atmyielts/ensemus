import { handleScim } from '@/server/scim';
export const runtime = 'nodejs';
export const GET = (request: Request) => handleScim(request);
export const POST = (request: Request) => handleScim(request, undefined, true);
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;

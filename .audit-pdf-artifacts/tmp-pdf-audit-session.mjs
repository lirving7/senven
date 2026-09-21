// READ-ONLY audit: create a temp session via the real API + a test resume, then
// drive authenticated browser checks on /resumes/[id]/pdf. Writes only: 1 User+Session.
// Cleanup is performed by tmp-pdf-audit-cleanup.mjs
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();
const email = `pdf-audit-${Date.now()}@example.com`;
const password = 'audit-password-1234';

try {
  const res = await fetch('http://127.0.0.1:3001/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  console.log('register status:', res.status);

  const setCookie = res.headers.get('set-cookie') || '';
  const m = /jp_session=([^;]+)/.exec(setCookie);
  console.log('session cookie present:', Boolean(m));

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  console.log('USER_ID:', user?.id);
  console.log('SESSION_TOKEN:', m ? m[1] : null);

  // pick a resume that has conf>0 so the PDF page has realistic data
  const resume = await prisma.resume.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });
  console.log('OWN_RESUME:', resume?.id ?? null);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

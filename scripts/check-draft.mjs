import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const rows = await prisma.jobApplication.groupBy({ by: ['stage'], _count: { _all: true } });
console.log(JSON.stringify(rows, null, 2));
await prisma.$disconnect();

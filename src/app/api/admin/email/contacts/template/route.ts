import { auth } from '@clerk/nextjs/server';
import * as XLSX from 'xlsx';

const HEADERS = ['Company Name', 'Last name , first name', 'Role', 'Notes', 'email', 'phone'];

const SAMPLES = [
  ['Cambria USA',  'Armitage, Brad',  'Oracle EBS Database Administrator',          'Attended Oracle OpenWorld 2024',  'brad.armitage@cambriausa.com',  '9528735184'],
  ['Cambria USA',  'Dobie, Terry',    'Data Architect & Senior Database Administrator', '',                             'terry.dobie@cambriausa.com',    '(952) 873-5148'],
  ['Alorica',      'Daza, Jayarr',    'Senior Database Administrator',               'Primary DBA Contact',             'jayarr.daza@alorica.com',       '+639178948698'],
  ['Seagate',      'Calhoun, Mike',   'Senior Manager, IT Enterprise Applications',  '',                               'michael.calhoun@seagate.com',   ''],
];

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...SAMPLES]);

  // Column widths (characters)
  ws['!cols'] = [
    { wch: 22 }, // Company Name
    { wch: 26 }, // Last name , first name
    { wch: 46 }, // Role
    { wch: 34 }, // Notes
    { wch: 36 }, // email
    { wch: 18 }, // phone
  ];

  // Freeze the header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');

  const rawBuf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const ab = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);

  return new Response(ab as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="contacts_template.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
}

import { auth, currentUser } from '@clerk/nextjs/server';
import { db } from '@/db';
import { emailContacts } from '@/db/schema';
import { sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';

// Normalize spreadsheet column headers to our field names
function normalizeHeader(h: string): string {
  const s = h.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['email', 'emailaddress', 'e-mail'].includes(s)) return 'email';
  if (['firstname', 'first', 'fname', 'givenname'].includes(s)) return 'firstName';
  if (['lastname', 'last', 'lname', 'surname', 'familyname'].includes(s)) return 'lastName';
  if (['tags', 'tag', 'labels', 'groups'].includes(s)) return 'tags';
  if (['notes', 'note', 'comments', 'comment'].includes(s)) return 'notes';
  if (['status', 'subscriptionstatus', 'substatus'].includes(s)) return 'status';
  return h.trim();
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await currentUser();
  if (user?.publicMetadata?.role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return Response.json({ error: 'No file provided' }, { status: 400 });

  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !['csv', 'xlsx', 'xls'].includes(ext)) {
    return Response.json({ error: 'File must be .csv, .xlsx, or .xls' }, { status: 400 });
  }

  // Parse with SheetJS
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    return Response.json({ error: 'Spreadsheet is empty or has no data rows' }, { status: 400 });
  }

  // Normalize headers on the first row to detect column mapping
  const firstRow = rows[0];
  const headerMap: Record<string, string> = {};
  for (const key of Object.keys(firstRow)) {
    headerMap[key] = normalizeHeader(key);
  }

  const VALID_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained'];

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    // Re-map keys using header normalization
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      row[headerMap[k] ?? k] = String(v ?? '').trim();
    }

    const email = row.email?.toLowerCase();
    if (!email || !email.includes('@')) {
      errors.push(`Row ${i + 2}: missing or invalid email "${row.email ?? ''}"`);
      continue;
    }

    const status = VALID_STATUSES.includes(row.status) ? row.status : 'subscribed';
    const referralCode = crypto.randomUUID().slice(0, 8).toUpperCase();

    try {
      const result = await db
        .insert(emailContacts)
        .values({
          email,
          firstName: row.firstName || null,
          lastName: row.lastName || null,
          tags: row.tags || null,
          notes: row.notes || null,
          status,
          referralCode,
        })
        .onConflictDoNothing({ target: emailContacts.email });

      // onConflictDoNothing returns undefined rows if skipped
      const insertedCount = (result as { rowCount?: number })?.rowCount ?? 1;
      if (insertedCount === 0) {
        skipped++;
      } else {
        imported++;
      }
    } catch (err) {
      errors.push(`Row ${i + 2} (${email}): ${err instanceof Error ? err.message : 'insert failed'}`);
    }
  }

  return Response.json({ imported, skipped, errors, total: rows.length });
}

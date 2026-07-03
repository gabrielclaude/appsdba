import { auth, currentUser } from '@clerk/nextjs/server';
import { db } from '@/db';
import { emailContacts } from '@/db/schema';
import * as XLSX from 'xlsx';

function normalizeHeader(h: string): string {
  const s = h.trim().toLowerCase().replace(/[\s_\-]+/g, '');
  if (['email', 'emailaddress', 'e-mail'].includes(s)) return 'email';
  if (['firstname', 'first', 'fname', 'givenname'].includes(s)) return 'firstName';
  if (['lastname', 'last', 'lname', 'surname', 'familyname'].includes(s)) return 'lastName';
  // CRM-style columns: Company | Name (Last, First) | Title | POC Roles | Email | Phone
  if (['name', 'company', 'organization', 'org', 'account', 'accountname', 'client', 'clientname'].includes(s)) return 'company';
  if (['role', 'contactname', 'contact', 'fullname', 'person', 'personname', 'contactperson'].includes(s)) return 'contactName';
  if (['poc', 'jobtitle', 'title', 'position', 'jobfunction', 'function', 'jobdescription', 'jobrole'].includes(s)) return 'jobTitle';
  if (['tags', 'tag', 'labels', 'groups', 'pocroles', 'pocs', 'roles', 'pocrole', 'pointofcontact'].includes(s)) return 'pocRoles';
  if (['notes', 'note', 'comments', 'comment'].includes(s)) return 'notes';
  if (['status', 'subscriptionstatus', 'substatus'].includes(s)) return 'status';
  if (['phone', 'telephone', 'mobile', 'phonenumber', 'tel', 'cell', 'cellphone', 'ph'].includes(s)) return 'phone';
  return h.trim();
}

// Parse "Last, First" or "First Last" into parts
function parseContactName(name: string): { firstName: string; lastName: string } {
  if (!name) return { firstName: '', lastName: '' };
  const commaIdx = name.indexOf(',');
  if (commaIdx !== -1) {
    return {
      lastName: name.substring(0, commaIdx).trim(),
      firstName: name.substring(commaIdx + 1).trim(),
    };
  }
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
  }
  return { firstName: name.trim(), lastName: '' };
}

// Strip country prefixes and Excel errors; return null if unusable
function cleanPhone(raw: string): string | null {
  if (!raw || raw.includes('ERROR') || raw === '#ERROR!') return null;
  const stripped = raw.trim()
    .replace(/^(US|CA|PH|AU|UK|IN|SG)\s+/i, '')
    .replace(/^\+\d{1,3}\s*/, '');
  const digits = stripped.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  return stripped.trim();
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

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    return Response.json({ error: 'Spreadsheet is empty or has no data rows' }, { status: 400 });
  }

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
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      row[headerMap[k] ?? k] = String(v ?? '').trim();
    }

    const email = row.email?.toLowerCase();
    if (!email || !email.includes('@')) {
      errors.push(`Row ${i + 2}: missing or invalid email "${row.email ?? ''}"`);
      continue;
    }

    // Resolve firstName / lastName — contactName (Last, First) takes precedence
    let firstName = row.firstName || '';
    let lastName = row.lastName || '';
    if (row.contactName) {
      const parsed = parseContactName(row.contactName);
      firstName = parsed.firstName;
      lastName = parsed.lastName;
    }

    // Tags: company name + semicolon-delimited POC roles
    const tagParts: string[] = [];
    if (row.company) tagParts.push(row.company.trim());
    if (row.pocRoles) {
      row.pocRoles.split(/[;,]/).map(r => r.trim()).filter(Boolean).forEach(r => tagParts.push(r));
    }
    if (row.tags) tagParts.push(...row.tags.split(/[;,]/).map(r => r.trim()).filter(Boolean));
    const tags = tagParts.length > 0 ? tagParts.join('; ') : null;

    // Notes: job title + phone
    const noteParts: string[] = [];
    if (row.jobTitle) noteParts.push(row.jobTitle.trim());
    const phone = cleanPhone(row.phone || '');
    if (phone) noteParts.push(`Phone: ${phone}`);
    if (row.notes) noteParts.push(row.notes.trim());
    const notes = noteParts.length > 0 ? noteParts.join(' | ') : null;

    const status = VALID_STATUSES.includes(row.status) ? row.status : 'subscribed';
    const referralCode = crypto.randomUUID().slice(0, 8).toUpperCase();

    try {
      const result = await db
        .insert(emailContacts)
        .values({ email, firstName: firstName || null, lastName: lastName || null, tags, notes, status, referralCode })
        .onConflictDoNothing({ target: emailContacts.email });

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

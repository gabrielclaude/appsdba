import { config } from 'dotenv';
config({ path: '.env.local' });

const ADMIN_EMAILS = ['gabriel.claude@gmail.com', 'anastasia.gabriel@gmail.com'];

async function main() {
  const { createClerkClient } = await import('@clerk/backend');
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

  const result = await clerk.users.getUserList({ emailAddress: ADMIN_EMAILS });

  if (!result.data.length) {
    console.log('No matching users found. Each address must sign in at least once before the role can be set.');
    console.log('Looked for:', ADMIN_EMAILS.join(', '));
    return;
  }

  for (const user of result.data) {
    await clerk.users.updateUserMetadata(user.id, {
      publicMetadata: { role: 'admin' },
    });
    console.log(`Admin role set for ${user.emailAddresses[0]?.emailAddress} (${user.id})`);
  }

  const found = result.data.map(u => u.emailAddresses[0]?.emailAddress);
  const missing = ADMIN_EMAILS.filter(e => !found.includes(e));
  if (missing.length) {
    console.log('Not yet signed up (run again after they log in):', missing.join(', '));
  }
}

main().catch(console.error);

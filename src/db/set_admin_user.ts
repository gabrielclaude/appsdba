import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { createClerkClient } = await import('@clerk/backend');
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

  const users = await clerk.users.getUserList({ emailAddress: ['gabriel.claude@gmail.com'] });
  if (!users.data.length) {
    console.log('User not found. Make sure gabriel.claude@gmail.com has signed up.');
    return;
  }

  const user = users.data[0];
  await clerk.users.updateUserMetadata(user.id, {
    publicMetadata: { role: 'admin' },
  });

  console.log(`Admin role set for ${user.emailAddresses[0]?.emailAddress} (${user.id})`);
}

main().catch(console.error);

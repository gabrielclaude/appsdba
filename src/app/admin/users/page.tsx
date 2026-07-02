export const dynamic = 'force-dynamic';
import { getAllUsers, getAllSubscriptions } from '@/lib/admin';
import { SetRoleButton } from './SetRoleButton';

export default async function UsersPage() {
  const [allUsers, allSubs] = await Promise.all([getAllUsers(), getAllSubscriptions()]);
  const subsMap = new Map(allSubs.map(s => [s.clerkUserId, s]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Users</h1>
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <p className="text-sm text-gray-500 mb-4">Showing {allUsers.length} registered users</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 text-gray-500">Email</th>
              <th className="text-left py-2 text-gray-500">Name</th>
              <th className="text-left py-2 text-gray-500">Subscription</th>
              <th className="text-left py-2 text-gray-500">Joined</th>
              <th className="text-right py-2 text-gray-500">Role</th>
            </tr>
          </thead>
          <tbody>
            {allUsers.map((u) => {
              const sub = subsMap.get(u.clerkUserId);
              return (
                <tr key={u.id} className="border-b border-gray-50">
                  <td className="py-2 text-gray-700">{u.email}</td>
                  <td className="py-2 text-gray-600">{u.firstName} {u.lastName}</td>
                  <td className="py-2">
                    {sub ? (
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        sub.status === 'active' ? 'bg-green-100 text-green-700' :
                        sub.status === 'canceled' ? 'bg-gray-100 text-gray-500' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>{sub.status}</span>
                    ) : (
                      <span className="text-xs text-gray-400">None</span>
                    )}
                  </td>
                  <td className="py-2 text-gray-400 text-xs">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 text-right">
                    <SetRoleButton clerkUserId={u.clerkUserId} email={u.email ?? ''} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

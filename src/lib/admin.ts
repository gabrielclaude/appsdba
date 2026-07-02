import { auth, currentUser } from '@clerk/nextjs/server';
import { db } from '@/db';
import { subscriptions, users, marketingExpenses } from '@/db/schema';
import { eq, gte, and, sql, desc, count, sum } from 'drizzle-orm';

export async function requireAdmin() {
  const { userId, sessionClaims } = await auth();
  if (!userId) throw new Error('Unauthenticated');
  const role = (sessionClaims?.metadata as { role?: string } | undefined)?.role;
  if (role !== 'admin') throw new Error('Forbidden');
  return userId;
}

export async function isAdminUser(): Promise<boolean> {
  try {
    const { sessionClaims } = await auth();
    const role = (sessionClaims?.metadata as { role?: string } | undefined)?.role;
    return role === 'admin';
  } catch {
    return false;
  }
}

export async function getSubscriberStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [activeResult] = await db
    .select({ count: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.status, 'active'), gte(subscriptions.currentPeriodEnd, now)));

  const [newThisMonthResult] = await db
    .select({ count: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.status, 'active'), gte(subscriptions.createdAt, startOfMonth)));

  const [newLastMonthResult] = await db
    .select({ count: count() })
    .from(subscriptions)
    .where(and(
      eq(subscriptions.status, 'active'),
      gte(subscriptions.createdAt, startOfLastMonth),
      sql`${subscriptions.createdAt} < ${startOfMonth}`,
    ));

  const [totalUsersResult] = await db.select({ count: count() }).from(users);

  const [canceledResult] = await db
    .select({ count: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.status, 'canceled'), gte(subscriptions.updatedAt, startOfMonth)));

  return {
    activeSubscribers: activeResult.count,
    newThisMonth: newThisMonthResult.count,
    newLastMonth: newLastMonthResult.count,
    totalUsers: totalUsersResult.count,
    canceledThisMonth: canceledResult.count,
  };
}

export async function getExpenseStats() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [monthResult] = await db
    .select({ total: sum(marketingExpenses.amount) })
    .from(marketingExpenses)
    .where(gte(marketingExpenses.expenseDate, startOfMonth));

  const [yearResult] = await db
    .select({ total: sum(marketingExpenses.amount) })
    .from(marketingExpenses)
    .where(gte(marketingExpenses.expenseDate, startOfYear));

  const byCategory = await db
    .select({
      category: marketingExpenses.category,
      total: sum(marketingExpenses.amount),
    })
    .from(marketingExpenses)
    .where(gte(marketingExpenses.expenseDate, startOfYear))
    .groupBy(marketingExpenses.category)
    .orderBy(desc(sum(marketingExpenses.amount)));

  return {
    thisMonth: Number(monthResult.total ?? 0),
    thisYear: Number(yearResult.total ?? 0),
    byCategory,
  };
}

export async function getRecentExpenses(limit = 20) {
  return db
    .select()
    .from(marketingExpenses)
    .orderBy(desc(marketingExpenses.expenseDate))
    .limit(limit);
}

export async function getAllUsers() {
  return db.select().from(users).orderBy(desc(users.createdAt)).limit(100);
}

export async function getAllSubscriptions() {
  return db.select().from(subscriptions).orderBy(desc(subscriptions.createdAt)).limit(200);
}

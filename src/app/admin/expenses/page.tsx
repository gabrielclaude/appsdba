export const dynamic = 'force-dynamic';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { marketingExpenses } from '@/db/schema';
import { getRecentExpenses } from '@/lib/admin';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';

const CATEGORIES = ['ads', 'content', 'tools', 'events', 'other'];

async function createExpense(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const description = formData.get('description') as string;
  const amountStr = formData.get('amount') as string;
  const category = formData.get('category') as string;
  const expenseDateStr = formData.get('expenseDate') as string;
  const notes = formData.get('notes') as string;

  if (!description || !amountStr || !category || !expenseDateStr) return;

  const amountCents = Math.round(parseFloat(amountStr) * 100);
  await db.insert(marketingExpenses).values({
    description,
    amount: amountCents,
    category,
    expenseDate: new Date(expenseDateStr),
    notes: notes || null,
    createdBy: userId,
  });

  revalidatePath('/admin/expenses');
  revalidatePath('/admin/accounting');
  revalidatePath('/admin');
}

async function deleteExpense(id: number) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');
  await db.delete(marketingExpenses).where(eq(marketingExpenses.id, id));
  revalidatePath('/admin/expenses');
  revalidatePath('/admin/accounting');
  revalidatePath('/admin');
}

export default async function ExpensesPage() {
  const expenses = await getRecentExpenses(50);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Marketing Expenses</h1>

      {/* Add expense form */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Expense</h2>
        <form action={createExpense} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Description *</label>
            <input
              name="description"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="Google Ads — July campaign"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Amount (USD) *</label>
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="150.00"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Category *</label>
            <select
              name="category"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Date *</label>
            <input
              name="expenseDate"
              type="date"
              required
              defaultValue={new Date().toISOString().split('T')[0]}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <textarea
              name="notes"
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="Optional notes"
            />
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Add Expense
            </button>
          </div>
        </form>
      </div>

      {/* Expense list */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Expenses</h2>
        {expenses.length === 0 ? (
          <p className="text-sm text-gray-400">No expenses recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500">Date</th>
                <th className="text-left py-2 text-gray-500">Description</th>
                <th className="text-left py-2 text-gray-500">Category</th>
                <th className="text-right py-2 text-gray-500">Amount</th>
                <th className="text-right py-2 text-gray-500"></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp) => (
                <tr key={exp.id} className="border-b border-gray-50">
                  <td className="py-2 text-gray-500 text-xs">{new Date(exp.expenseDate).toLocaleDateString()}</td>
                  <td className="py-2 text-gray-800">{exp.description}</td>
                  <td className="py-2">
                    <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 capitalize">{exp.category}</span>
                  </td>
                  <td className="py-2 text-right font-medium text-red-600">${(exp.amount / 100).toFixed(2)}</td>
                  <td className="py-2 text-right">
                    <form action={deleteExpense.bind(null, exp.id)}>
                      <button type="submit" className="text-xs text-gray-400 hover:text-red-500 transition-colors">Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="pt-3 text-xs text-gray-500 font-medium">Total</td>
                <td className="pt-3 text-right font-bold text-gray-900">
                  ${(expenses.reduce((s, e) => s + e.amount, 0) / 100).toFixed(2)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

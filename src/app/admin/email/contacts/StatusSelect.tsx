'use client';

export function StatusSelect({
  id,
  status,
  updateAction,
}: {
  id: number;
  status: string;
  updateAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={updateAction}>
      <input type="hidden" name="id" value={id} />
      <select
        name="status"
        defaultValue={status}
        onChange={(e) => {
          const form = e.currentTarget.closest('form') as HTMLFormElement;
          form?.requestSubmit();
        }}
        className="text-xs border border-gray-200 rounded px-1 py-0.5 text-gray-600 focus:outline-none focus:ring-1 focus:ring-orange-400"
      >
        <option value="subscribed">subscribed</option>
        <option value="unsubscribed">unsubscribed</option>
        <option value="bounced">bounced</option>
        <option value="complained">complained</option>
      </select>
    </form>
  );
}

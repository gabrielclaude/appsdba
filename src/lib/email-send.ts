import { Resend } from 'resend';
import { wrapInTemplate } from './email-template';

export async function sendEmail({
  to,
  subject,
  html,
  previewText,
}: {
  to: string | string[];
  subject: string;
  html: string;
  previewText?: string | null;
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM ?? 'AppsDBA <onboarding@resend.dev>';
  const wrappedHtml = wrapInTemplate({ subject, bodyHtml: html, previewText });
  const { data, error } = await resend.emails.send({ from, to, subject, html: wrappedHtml });
  if (error) throw new Error(error.message);
  return data;
}

const SITE_URL = process.env.NEXT_PUBLIC_URL ?? 'https://appsdba.vercel.app';

export function wrapInTemplate({
  subject,
  bodyHtml,
  previewText,
}: {
  subject: string;
  bodyHtml: string;
  previewText?: string | null;
}): string {
  const preview = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${previewText}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  ${preview}

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#0F1D38;border-radius:12px 12px 0 0;padding:28px 40px;">
              <a href="${SITE_URL}" style="text-decoration:none;">
                <div style="font-size:20px;font-weight:700;color:#FFE4A0;letter-spacing:-0.3px;">21st Century Apps DBA</div>
                <div style="font-size:11px;color:#FFCB8E;margin-top:3px;">Oracle · EBS · WebLogic · GoldenGate · RAC</div>
              </a>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:36px 40px;">
              <div style="color:#1e293b;font-size:15px;line-height:1.7;">
                ${bodyHtml}
              </div>
            </td>
          </tr>

          <!-- CTA bar -->
          <tr>
            <td style="background-color:#FFF3B0;border:1px solid #C8A84B;padding:20px 40px;text-align:center;">
              <a href="${SITE_URL}" style="display:inline-block;background-color:#E8693C;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 28px;border-radius:8px;">
                Browse All Articles →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#0F1D38;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;color:#FFCB8E;">
                © ${new Date().getFullYear()} 21st Century Apps DBA
              </p>
              <p style="margin:0;font-size:11px;color:#8899aa;">
                You're receiving this because you opted in to AppsDBA updates.
                &nbsp;·&nbsp;
                <a href="${SITE_URL}/unsubscribe" style="color:#FFCB8E;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

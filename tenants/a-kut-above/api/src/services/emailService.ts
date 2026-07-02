import nodemailer from 'nodemailer';
import { env } from '../config/env';

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

// ⚠️ DEAD SCAFFOLD — superseded by the shared growth-os platform (which sends
// via integrations/email.js behind the tenant-identity gate). This standalone
// per-tenant API is NOT deployed. Fail-safe guard (P0 2026-07-01): refuse to
// send unless SMTP is explicitly enabled AND the From is a real A Kut Above
// address — so it can NEVER silently ship First Gen Automate identity if
// accidentally deployed. Recommended: delete tenants/*/api scaffolds.
function assertSafeSender() {
  const from = String(env.SMTP_FROM || env.SMTP_USER || '');
  if (process.env.SMTP_ENABLED !== 'true') {
    throw new Error('emailService disabled (dead scaffold): set SMTP_ENABLED=true only after configuring an A Kut Above sender.');
  }
  if (/firstgenautomate\.com/i.test(from) || !/akutabovetreeservices\.com/i.test(from)) {
    throw new Error(`Refusing to send: From "${from}" is not an A Kut Above address (no FGA / cross-tenant identity).`);
  }
}

export const emailService = {
  async send(to: string, subject: string, body: string, html?: string) {
    try {
      assertSafeSender();
      const result = await transporter.sendMail({
        from: env.SMTP_FROM || env.SMTP_USER,
        to,
        subject,
        text: body,
        html: html || body.replace(/\n/g, '<br>'),
      });
      return { success: true, messageId: result.messageId };
    } catch (error: any) {
      console.error('Email send error:', error.message);
      return { success: false, error: error.message };
    }
  },
};

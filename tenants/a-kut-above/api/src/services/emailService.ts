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

export const emailService = {
  async send(to: string, subject: string, body: string, html?: string) {
    try {
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

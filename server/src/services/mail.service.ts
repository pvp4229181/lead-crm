import { Resend } from 'resend';
import { ApiError } from '../utils/http.js';

const configured = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
let client: Resend | undefined;

function getClient() {
  if (!configured()) throw new ApiError(503, 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM in the server environment.');
  client ??= new Resend(process.env.RESEND_API_KEY);
  return client;
}

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]!);

export function invitationUrl(token: string) {
  const appUrl = (process.env.APP_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${appUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}

export async function sendInvitationEmail(input: { to:string; name:string; role:string; inviter:string; token:string; expiresAt:Date }) {
  const link = invitationUrl(input.token);
  // Resolved before the try so a configuration error keeps its own 503 instead of
  // being caught below and masked as a generic delivery failure.
  const resend = getClient();
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to: input.to,
    subject: `You are invited to Lead CRM as ${input.role}`,
    text: `${input.inviter} invited you to Lead CRM as ${input.role}. Set your password before ${input.expiresAt.toISOString()}: ${link}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1e293b"><div style="background:#0ea5e9;color:white;padding:18px 22px;font-size:18px;font-weight:700">Lead CRM</div><div style="border:1px solid #e2e8f0;border-top:0;padding:24px"><h2 style="font-size:20px">Welcome, ${escapeHtml(input.name)}</h2><p>${escapeHtml(input.inviter)} invited you to join Lead CRM with the <strong>${escapeHtml(input.role)}</strong> role.</p><p style="margin:26px 0"><a href="${link}" style="background:#0284c7;color:white;text-decoration:none;padding:11px 18px;border-radius:4px;font-weight:600">Accept invitation</a></p><p style="font-size:12px;color:#64748b">This private link expires on ${input.expiresAt.toUTCString()}. If you did not expect this invitation, you can ignore this email.</p></div></div>`,
  });
  if (error) {
    console.error('Invitation email failed', error);
    throw new ApiError(502, 'The invitation could not be sent. Check the Resend settings and try again.');
  }
}

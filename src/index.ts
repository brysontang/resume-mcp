/**
 * resume-mcp: Your identity as an API endpoint
 *
 * MCP server that lets AI agents query your professional profile
 * with structured tools instead of scraping HTML.
 */

import bundledProfileData from '../data/profile.json';
import { decodeAgentTokenV0, getIntentV1 } from '@agent-tokens/core';
import { EmailMessage } from 'cloudflare:email';

const PROFILE_URL = 'https://brysontang.com/data/profile.json';
const PROFILE_KV_KEY = 'profile:latest';
const PROFILE_TTL_SECONDS = 3600; // 1 hour

// Types
interface Env {
  /** Profile cache, sessions, and rate limits */
  GUESTBOOK?: KVNamespace;
  /** brysontang.com's guestbook, shared with the site's API worker (api.brysontang.com) */
  GUESTBOOK_DB?: D1Database;
  /** Same salt as the site's API worker, so ip_hash values line up across signing paths */
  IP_SALT?: string;
  CORS_ORIGIN?: string;
  /** send_email binding that delivers request_time notifications to Bryson */
  NOTIFY_EMAIL?: SendEmail;
  /** The NOTIFY_EMAIL binding's destination_address */
  NOTIFY_TO?: string;
  /** Cal.com booking link (secret), only ever sent to requests Bryson approves */
  CALCOM_LINK?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProfileData = typeof bundledProfileData & Record<string, any>;

/**
 * Get profile data with KV cache → remote fetch → bundled fallback
 */
async function getProfileData(env: Env): Promise<ProfileData> {
  // 1. Check KV cache
  if (env.GUESTBOOK) {
    try {
      const cached = await env.GUESTBOOK.get(PROFILE_KV_KEY, 'json');
      if (cached) return cached as ProfileData;
    } catch {
      // KV miss or error, continue to fetch
    }
  }

  // 2. Fetch from origin
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { 'User-Agent': 'resume-mcp/1.0' },
    });
    if (res.ok) {
      const data = await res.json() as ProfileData;
      // Cache in KV
      if (env.GUESTBOOK) {
        try {
          await env.GUESTBOOK.put(PROFILE_KV_KEY, JSON.stringify(data), {
            expirationTtl: PROFILE_TTL_SECONDS,
          });
        } catch {
          // Cache write failed, non-critical
        }
      }
      return data;
    }
  } catch {
    // Fetch failed, fall back to bundled
  }

  // 3. Fallback to bundled copy
  return bundledProfileData as ProfileData;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent on notifications */
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Sessions persist in KV (key session:<id>), so a signature survives across Worker isolates
interface SessionState {
  signed?: { name: string; at: string };
  /** Set per request from the Agent-Token header; never persisted */
  agentToken?: string;
}

interface RequestContext {
  session: SessionState;
  sessionKey: string;
  env: Env;
  request: Request;
  profileData: ProfileData;
}

// Hash IP for privacy-preserving rate limiting
async function hashIP(ip: string, salt = 'resume-mcp-salt'): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Tool definitions for MCP
const TOOLS = [
  {
    name: 'get_profile',
    description: 'Get basic profile information including name, tagline, links, and contact info.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_projects',
    description: 'Get list of projects, optionally filtered by tag.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter projects by tag' },
        featured_only: { type: 'boolean', description: 'Only return featured projects' }
      },
      required: []
    }
  },
  {
    name: 'get_writing',
    description: 'Get list of articles and blog posts.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Filter by platform' },
        limit: { type: 'number', description: 'Max posts to return' }
      },
      required: []
    }
  },
  {
    name: 'get_experience',
    description: 'Get work experience history.',
    inputSchema: {
      type: 'object',
      properties: {
        current_only: { type: 'boolean', description: 'Only return current position(s)' }
      },
      required: []
    }
  },
  {
    name: 'get_skills',
    description: 'Get technical skills by category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: languages, frameworks, infrastructure, domains' }
      },
      required: []
    }
  },
  {
    name: 'leave_message',
    description: 'Sign the guestbook at brysontang.com/guestbook. Your name and message appear there publicly. One entry per hour. Signing unlocks two perks: request_time (ask for time with Bryson) and the stories behind the resume (list_stories, get_story).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 50, description: 'Your name or identifier (shown publicly)' },
        message: { type: 'string', maxLength: 500, description: 'Your message for the guestbook (shown publicly)' },
        agent_id: { type: 'string', description: 'Optional agent identifier (kept private)' },
        contact: { type: 'string', description: 'Optional contact info (kept private)' }
      },
      required: ['name', 'message']
    }
  },
  {
    name: 'request_time',
    description: "Perk for guestbook signers: ask for time with Bryson. Say what you'd like to talk about (consulting, collaboration, research, and so on). Bryson reviews every request himself, and if he says yes, a booking link goes to your contact email. He isn't taking sales pitches.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 50, description: 'Name of the person who wants to meet' },
        contact: { type: 'string', maxLength: 200, description: 'Email address the booking link should go to (kept private)' },
        reason: { type: 'string', minLength: 20, maxLength: 1000, description: "What you'd like to talk about, and why" },
        timezone: { type: 'string', description: 'Optional, e.g. America/New_York' },
        availability: { type: 'string', description: 'Optional, e.g. weekday afternoons next week' }
      },
      required: ['name', 'contact', 'reason']
    }
  },
  {
    name: 'list_stories',
    description: 'Perk for guestbook signers: list the stories behind the resume, the parts the bullet points leave out.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_story',
    description: 'Perk for guestbook signers: read one story behind the resume, by its slug from list_stories.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Story slug from list_stories' }
      },
      required: ['slug']
    }
  }
];

const FREE_TOOLS = ['get_profile', 'get_projects', 'get_writing', 'get_experience', 'get_skills', 'leave_message'];
// Perks open up once a session has signed the guestbook (or sends an Agent-Token)
const PERK_TOOLS = ['request_time', 'list_stories', 'get_story'];
const PERKS_BLURB = 'request_time to ask for time with Bryson, and list_stories / get_story for the stories behind the resume.';
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

// Tool implementations — all accept profileData so they use fresh data
function getProfile(profileData: ProfileData) {
  return profileData.profile;
}

function getProjects(profileData: ProfileData, params: { tag?: string; featured_only?: boolean }) {
  let projects = profileData.projects;

  if (params.tag) {
    projects = projects.filter((p: { tags: string[] }) => p.tags.includes(params.tag!.toLowerCase()));
  }

  if (params.featured_only) {
    projects = projects.filter((p: { featured?: boolean }) => p.featured);
  }

  return projects;
}

function getWriting(profileData: ProfileData, params: { platform?: string; limit?: number }) {
  let writing = profileData.writing;

  if (params.platform) {
    writing = writing.filter((w: { platform: string }) => w.platform === params.platform);
  }

  if (params.limit && params.limit > 0) {
    writing = writing.slice(0, params.limit);
  }

  return writing;
}

function getExperience(profileData: ProfileData, params: { current_only?: boolean }) {
  let experience = profileData.experience;

  if (params.current_only) {
    experience = experience.filter((e: { current?: boolean }) => e.current);
  }

  return experience;
}

function getSkills(profileData: ProfileData, params: { category?: string }) {
  const skills = profileData.skills;

  if (params.category && params.category in skills) {
    return { [params.category]: skills[params.category as keyof typeof skills] };
  }

  return skills;
}

const GUESTBOOK_PAGE = 'https://brysontang.com/guestbook';

// Example and placeholder text, meaning nobody filled the entry in. Compared after
// lowercasing and dropping punctuation. Keep in sync with workers/src/index.js in
// bryt12.github.io (the site's guestbook API).
const DEFAULT_NAMES = new Set([
  'your agent name', 'your name', 'agent name', 'name', 'your name or identifier',
  'your name or identifier shown publicly', 'string', 'example', 'placeholder', 'null', 'undefined'
]);
const DEFAULT_MESSAGES = new Set([
  'your message here', 'your message', 'message', 'your message or reason for visiting',
  'your message for the guestbook shown publicly', 'string', 'example', 'placeholder', 'null', 'undefined'
]);

const DEFAULT_TEXT_ERROR =
  "That's the example text, not yours. Sign with who you are (a name, or which agent you are) and a short note about why you stopped by";

// True for example text, or a value still wrapped like <...>, {...}, ${...}, or [...]
function isDefaultText(value: string, defaults: Set<string>): boolean {
  if (/^(<.*>|\$?\{.*\}|\[.*\])$/s.test(value)) return true;
  return defaults.has(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
}

// Who signed, as far as the request says. Stored with the entry, never shown publicly.
// Same fields as requestDetails() in the site's guestbook API.
function requestDetails(request: Request) {
  const cf = (request.cf || {}) as { asn?: unknown; asOrganization?: unknown; country?: unknown };
  const clip = (value: unknown, max: number) => (typeof value === 'string' && value ? value.slice(0, max) : null);
  return {
    userAgent: clip(request.headers.get('User-Agent'), 500),
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asOrg: clip(cf.asOrganization, 200),
    country: clip(cf.country, 8),
    agentToken: clip(request.headers.get('Agent-Token'), 4096)
  };
}

// Same rules as the site's other signing paths (api.brysontang.com/api/guestbook)
async function leaveMessage(
  params: { name?: unknown; message?: unknown; agent_id?: unknown; contact?: unknown },
  env: Env,
  request: Request
): Promise<{ success: boolean; perks_unlocked: boolean; message: string }> {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  const message = typeof params.message === 'string' ? params.message.trim() : '';
  const notSigned = (reason: string) => ({ success: false, perks_unlocked: false, message: reason });

  if (!name || !message) return notSigned('Not signed: name and message are both required.');
  if (name.length > 50) return notSigned('Not signed: name too long (max 50 characters).');
  if (message.length > 500) return notSigned('Not signed: message too long (max 500 characters).');
  if (isDefaultText(name, DEFAULT_NAMES) || isDefaultText(message, DEFAULT_MESSAGES)) {
    return notSigned(`Not signed: ${DEFAULT_TEXT_ERROR}.`);
  }

  if (!env.GUESTBOOK_DB) {
    console.error('leave_message: GUESTBOOK_DB binding is missing');
    return notSigned('Not signed: the guestbook is unavailable right now. Please try again later.');
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await hashIP(ip, env.IP_SALT);
  const rateLimitKey = `guestbook_rate_${ipHash}`;
  if (env.GUESTBOOK && (await env.GUESTBOOK.get(rateLimitKey))) {
    return {
      success: false,
      perks_unlocked: true,
      message: `You already signed in the last hour, so this one wasn't added. Your earlier entry is at ${GUESTBOOK_PAGE}, and your perks are open: ${PERKS_BLURB}`
    };
  }

  const details = requestDetails(request);
  await env.GUESTBOOK_DB.prepare(
    'INSERT INTO guestbook (name, message, ip_hash, created_at, agent_id, contact, via, user_agent, asn, as_org, country, agent_token) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?)"
  )
    .bind(
      name,
      message,
      ipHash,
      new Date().toISOString(),
      text(params.agent_id, 100) || null,
      text(params.contact, 200) || null,
      details.userAgent,
      details.asn,
      details.asOrg,
      details.country,
      details.agentToken
    )
    .run();

  if (env.GUESTBOOK) {
    await env.GUESTBOOK.put(rateLimitKey, '1', { expirationTtl: 3600 });
  }

  return {
    success: true,
    perks_unlocked: true,
    message: `Thanks, ${name}! Your entry is live at ${GUESTBOOK_PAGE}. You've unlocked the perks: ${PERKS_BLURB}`
  };
}

const SESSION_TTL_SECONDS = 7 * 24 * 3600;

// Mcp-Session-Id when the client sends one; otherwise a hash of IP + User-Agent,
// so clients that don't send the header still keep a session
async function sessionKeyFor(request: Request, env: Env): Promise<string> {
  const id = request.headers.get('Mcp-Session-Id');
  if (id) return `session:${id.slice(0, 100)}`;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = request.headers.get('User-Agent') || 'unknown';
  return `session:fallback:${await hashIP(`${ip}|${ua}`, env.IP_SALT)}`;
}

async function loadSession(env: Env, key: string): Promise<SessionState> {
  if (!env.GUESTBOOK) return {};
  try {
    return ((await env.GUESTBOOK.get(key, 'json')) as SessionState | null) || {};
  } catch {
    return {};
  }
}

// Only the signature is stored; an Agent-Token arrives with every request anyway
async function saveSession(env: Env, key: string, session: SessionState): Promise<void> {
  if (!env.GUESTBOOK) return;
  await env.GUESTBOOK.put(key, JSON.stringify({ signed: session.signed }), {
    expirationTtl: SESSION_TTL_SECONDS
  });
}

// --- Perk: request_time ---

const MEETING_RATE_SECONDS = 24 * 3600;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NOTIFY_FROM = 'guestbook@brysontang.com';

interface MeetingRequest {
  id: number;
  name: string;
  contact: string;
  reason: string;
  timezone: string | null;
  availability: string | null;
  guestbookName: string | null;
}

// Base64 of the UTF-8 bytes, for MIME headers and bodies
function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mailto(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Opens a Gmail draft in the browser, whatever the computer's default mail app is
function gmailCompose(to: string, subject: string, body: string): string {
  const q = (v: string) => encodeURIComponent(v);
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One MIME part, base64 so long lines and non-ASCII survive
function mimePart(contentType: string, text: string): string {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Utf8(text).replace(/.{76}/g, '$&\r\n')
  ].join('\r\n');
}

// MIME built by hand: a plain-text part plus an HTML part with clickable buttons
async function notifyBryson(env: Env, req: MeetingRequest): Promise<void> {
  if (!env.NOTIFY_EMAIL || !env.NOTIFY_TO) {
    console.error('request_time: NOTIFY_EMAIL binding or NOTIFY_TO is missing; request stored without an email');
    return;
  }
  if (!env.CALCOM_LINK) console.error('request_time: CALCOM_LINK is not set');
  const calLink = env.CALCOM_LINK || '<your Cal.com link: set the CALCOM_LINK secret>';
  const replySubject = 'Re: time with Bryson Tang';

  const approveBody = `Hi ${req.name},\n\nThanks for reaching out. I'd be glad to talk. Grab a time that works for you here:\n${calLink}\n\nBryson`;
  const declineBody = `Hi ${req.name},\n\nThanks for reaching out, and for signing my guestbook. I can't take this one on right now, but I appreciate you thinking of me.\n\nBryson`;
  const approve = mailto(req.contact, replySubject, approveBody);
  const decline = mailto(req.contact, replySubject, declineBody);
  const approveGmail = gmailCompose(req.contact, replySubject, approveBody);
  const declineGmail = gmailCompose(req.contact, replySubject, declineBody);

  const body = [
    `New request for time, via mcp.brysontang.com (request #${req.id}).`,
    '',
    `From: ${req.name} <${req.contact}>`,
    `Guestbook name: ${req.guestbookName || '(none)'}`,
    `Timezone: ${req.timezone || '(not given)'}`,
    `Availability: ${req.availability || '(not given)'}`,
    '',
    'Reason:',
    req.reason,
    '',
    'Approve (opens a Gmail draft to them with your Cal.com link):',
    approveGmail,
    `Or in your mail app: ${approve}`,
    '',
    'Decline (opens a short, polite note):',
    declineGmail,
    `Or in your mail app: ${decline}`,
    ''
  ].join('\n');

  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666">${label}</td><td>${escapeHtml(value)}</td></tr>`;
  const button = (href: string, label: string, color: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;margin-right:8px;border-radius:6px;background:${color};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;
  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:600px">
<p>New request for time, via mcp.brysontang.com (request #${req.id}).</p>
<table style="border-collapse:collapse;font-size:14px">
${row('From', `${req.name} <${req.contact}>`)}
${row('Guestbook name', req.guestbookName || '(none)')}
${row('Timezone', req.timezone || '(not given)')}
${row('Availability', req.availability || '(not given)')}
</table>
<p style="margin-top:16px"><strong>Reason</strong></p>
<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #ccc;white-space:pre-wrap">${escapeHtml(req.reason)}</blockquote>
<p style="margin-top:20px">${button(approveGmail, 'Approve', '#16a34a')}${button(declineGmail, 'Decline', '#6b7280')}</p>
<p style="font-size:12px;color:#666">Approve opens a Gmail draft to them with your Cal.com link; Decline opens a short, polite note. Not using Gmail in the browser? <a href="${escapeHtml(approve)}">Approve</a> or <a href="${escapeHtml(decline)}">decline</a> in your mail app.</p>
</body></html>`;

  const boundary = `----=_guestbook_${crypto.randomUUID()}`;

  const raw = [
    `From: brysontang.com guestbook <${NOTIFY_FROM}>`,
    `To: ${env.NOTIFY_TO}`,
    `Reply-To: ${req.contact}`,
    `Subject: =?UTF-8?B?${base64Utf8(`Time request from ${req.name}`.replace(/[\r\n]+/g, ' '))}?=`,
    `Message-ID: <${crypto.randomUUID()}@brysontang.com>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    mimePart('text/plain', body),
    `--${boundary}`,
    mimePart('text/html', html),
    `--${boundary}--`,
    ''
  ].join('\r\n');

  await env.NOTIFY_EMAIL.send(new EmailMessage(NOTIFY_FROM, env.NOTIFY_TO, raw));
}

async function requestTime(
  params: Record<string, unknown>,
  ctx: RequestContext
): Promise<{ success: boolean; message: string; request_id?: number }> {
  const { env, request, session, sessionKey } = ctx;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(params.name);
  const contact = str(params.contact);
  const reason = str(params.reason);
  const timezone = str(params.timezone).slice(0, 100) || null;
  const availability = str(params.availability).slice(0, 500) || null;
  const notSent = (message: string) => ({ success: false, message });

  if (!name || name.length > 50) return notSent('Not sent: a name is required (max 50 characters).');
  if (contact.length > 200 || !EMAIL_PATTERN.test(contact)) {
    return notSent('Not sent: contact must be an email address, since that is where the booking link would go.');
  }
  if (reason.length < 20) {
    return notSent("Not sent: say a little more about what you'd like to talk about (at least 20 characters).");
  }
  if (reason.length > 1000) return notSent('Not sent: reason too long (max 1000 characters).');

  if (!env.GUESTBOOK_DB) {
    console.error('request_time: GUESTBOOK_DB binding is missing');
    return notSent('Not sent: requests are unavailable right now. Please try again later.');
  }

  // One request per session and per IP each day
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await hashIP(ip, env.IP_SALT);
  const rateLimitKeys = [`meeting_rate_${sessionKey}`, `meeting_rate_ip_${ipHash}`];
  if (env.GUESTBOOK) {
    for (const key of rateLimitKeys) {
      if (await env.GUESTBOOK.get(key)) {
        return notSent("You've already sent a request in the last day. If Bryson says yes, you'll hear back at the address you gave.");
      }
    }
  }

  const guestbookName = session.signed?.name || null;
  const { meta } = await env.GUESTBOOK_DB.prepare(
    'INSERT INTO meeting_requests (created_at, name, contact, reason, timezone, availability, guestbook_name, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(new Date().toISOString(), name, contact, reason, timezone, availability, guestbookName, ipHash)
    .run();
  const id = Number(meta.last_row_id);

  if (env.GUESTBOOK) {
    await Promise.all(
      rateLimitKeys.map((key) => env.GUESTBOOK!.put(key, '1', { expirationTtl: MEETING_RATE_SECONDS }))
    );
  }

  // The request is stored either way; a failed email only costs the heads-up
  try {
    await notifyBryson(env, {
      id,
      name,
      contact,
      reason,
      timezone,
      availability,
      guestbookName: guestbookName || (session.agentToken ? '(sent an Agent-Token)' : null)
    });
  } catch (err) {
    console.error('request_time: notification email failed:', err instanceof Error ? err.message : err);
  }

  return {
    success: true,
    request_id: id,
    message: `Thanks, ${name}. Bryson reviews every request personally. If he says yes, an email with a booking link goes to ${contact}.`
  };
}

// --- Perk: stories behind the resume ---

async function listStories(env: Env) {
  if (!env.GUESTBOOK_DB) {
    return { stories: [], message: 'Stories are unavailable right now. Please try again later.' };
  }
  const { results } = await env.GUESTBOOK_DB.prepare(
    'SELECT slug, title, summary, updated_at FROM stories WHERE published = 1 ORDER BY updated_at DESC'
  ).all();
  if (!results.length) {
    return {
      stories: [],
      message: 'Stories are coming soon. Bryson is writing up the stories behind the resume, the parts the bullet points leave out. Check back later.'
    };
  }
  return { stories: results, hint: 'Read one with get_story(slug).' };
}

async function getStory(env: Env, slug: string) {
  if (!env.GUESTBOOK_DB) return null;
  return await env.GUESTBOOK_DB.prepare(
    'SELECT slug, title, summary, body_md, updated_at FROM stories WHERE slug = ? AND published = 1'
  )
    .bind(slug)
    .first();
}

// Handle MCP tool calls
async function handleToolCall(
  tool: string,
  params: Record<string, unknown>,
  ctx: RequestContext
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const { session, sessionKey, env, request, profileData } = ctx;

  // Perks open up for sessions that signed the guestbook (or sent a valid Agent-Token)
  if (PERK_TOOLS.includes(tool) && !session.signed && !session.agentToken) {
    return {
      error: {
        code: -32001,
        message: 'Perk for guestbook signers',
        data: {
          message: `${tool} is a perk for guestbook signers. You're welcome to sign with leave_message (a name and a short note, shown at ${GUESTBOOK_PAGE}), then call ${tool} again. An Agent-Token header works too.`,
          perk: tool,
          free_tools: FREE_TOOLS
        }
      }
    };
  }

  // Execute tool
  switch (tool) {
    case 'get_profile':
      return { result: getProfile(profileData) };

    case 'get_projects':
      return { result: getProjects(profileData, params as { tag?: string; featured_only?: boolean }) };

    case 'get_writing':
      return { result: getWriting(profileData, params as { platform?: string; limit?: number }) };

    case 'get_experience':
      return { result: getExperience(profileData, params as { current_only?: boolean }) };

    case 'get_skills':
      return { result: getSkills(profileData, params as { category?: string }) };

    case 'leave_message': {
      const result = await leaveMessage(params, env, request);
      // Signed now or earlier this hour: this session's perks are open
      if (result.perks_unlocked) {
        const name = typeof params.name === 'string' ? params.name.trim().slice(0, 50) : '';
        session.signed = { name, at: new Date().toISOString() };
        await saveSession(env, sessionKey, session);
      }
      return { result };
    }

    case 'request_time':
      return { result: await requestTime(params, ctx) };

    case 'list_stories':
      return { result: await listStories(env) };

    case 'get_story': {
      const slug = typeof params.slug === 'string' ? params.slug.trim() : '';
      const story = slug ? await getStory(env, slug) : null;
      if (!story) {
        return {
          error: {
            code: -32002,
            message: 'Story not found',
            data: { message: `There's no story called "${slug}" yet. list_stories shows what's available.` }
          }
        };
      }
      return { result: story };
    }

    default:
      return {
        error: {
          code: -32601,
          message: `Unknown tool: ${tool}`
        }
      };
  }
}

// JSON-RPC notifications carry no id and get no response
function isNotification(rpc: JsonRpcRequest): boolean {
  return rpc.id === undefined;
}

// Handle MCP JSON-RPC methods
async function handleJsonRpc(rpc: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
  const { method, params } = rpc;
  const id = rpc.id ?? null;

  switch (method) {
    case 'initialize': {
      // Echo the client's protocol version when it's one this server speaks
      const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      const protocolVersion =
        requested && PROTOCOL_VERSIONS.includes(requested) ? requested : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'resume-mcp',
            version: '1.0.0'
          }
        }
      };
    }

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      };

    case 'tools/call': {
      const toolParams = params as { name: string; arguments?: Record<string, unknown> };
      const toolResult = await handleToolCall(toolParams.name, toolParams.arguments || {}, ctx);

      if (toolResult.error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify(toolResult.error.data || { message: toolResult.error.message })
            }],
            isError: true
          }
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify(toolResult.result, null, 2)
          }]
        }
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      };
  }
}

// MCP Server Card (SEP-1649). Keep in sync with brysontang.com/.well-known/mcp/server-card.json
// (bryt12.github.io public/.well-known/mcp/server-card.json)
const SERVER_CARD = {
  serverInfo: { name: 'resume-mcp', title: 'Bryson Tang', version: '1.0.0' },
  description:
    "Bryson Tang's portfolio as an MCP server: profile, projects, writing, experience, and skills, all free to read. leave_message signs the guestbook at https://brysontang.com/guestbook and unlocks two perks: request_time to ask for time with Bryson, and list_stories / get_story for the stories behind the resume.",
  protocolVersion: '2024-11-05',
  transport: { type: 'streamable-http', endpoint: 'https://mcp.brysontang.com' },
  capabilities: { tools: {} },
  authentication: { required: false },
  documentation: 'https://github.com/brysontang/resume-mcp'
};

// CORS headers
function corsHeaders(origin?: string): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Agent-Token, Mcp-Session-Id, MCP-Protocol-Version');
  headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

// Main request handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.CORS_ORIGIN || request.headers.get('Origin') || '*';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Discovery endpoint
    if (url.pathname === '/.well-known/mcp.json' || url.pathname === '/mcp.json') {
      const discovery = {
        endpoint: url.origin,
        protocol: 'mcp',
        protocolVersion: '2024-11-05',
        tools: TOOLS.map(t => t.name),
        access: {
          free: FREE_TOOLS,
          perks: PERK_TOOLS,
          unlock: 'leave_message() (signs the guestbook) or an Agent-Token header'
        },
        agent_tokens: 'https://github.com/brysontang/agent-tokens'
      };

      const headers = corsHeaders(origin);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(discovery, null, 2), { headers });
    }

    if (url.pathname === '/.well-known/mcp/server-card.json') {
      const headers = corsHeaders(origin);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(SERVER_CARD, null, 2), { headers });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { headers: corsHeaders(origin) });
    }

    // Streamable HTTP clients may GET for a server-to-client SSE stream; this server doesn't offer one
    if (request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/event-stream')) {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(origin) });
    }

    // MCP endpoint (POST for JSON-RPC)
    if (request.method === 'POST') {
      try {
        // Load profile data (KV cache → fetch → bundled fallback)
        const profileData = await getProfileData(env);

        const body = await request.json() as JsonRpcRequest | JsonRpcRequest[];
        const rpcs = Array.isArray(body) ? body : [body];

        // initialize starts a new session (returned in Mcp-Session-Id); everything else continues one
        const newSessionId = rpcs.some(rpc => rpc.method === 'initialize') ? crypto.randomUUID() : null;
        const sessionKey = newSessionId ? `session:${newSessionId}` : await sessionKeyFor(request, env);
        const session = await loadSession(env, sessionKey);

        // A valid Agent Token counts as signed for this request
        const agentToken = request.headers.get('Agent-Token');
        if (agentToken) {
          try {
            const decoded = decodeAgentTokenV0(agentToken);
            const intent = getIntentV1(decoded);

            if (intent) {
              session.agentToken = agentToken;

              // Log agent visit with properly extracted intent
              console.log('Agent token visit:', JSON.stringify({
                intentId: intent.intentId,
                goal: intent.goal,
                mode: intent.mode,
                timestamp: new Date().toISOString()
              }));
            }
          } catch (e) {
            // Invalid token - log but don't count it
            console.log('Invalid agent token:', e instanceof Error ? e.message : 'Unknown error');
          }
        }

        // In order, so leave_message then request_time in one batch works
        const ctx: RequestContext = { session, sessionKey, env, request, profileData };
        const responses: JsonRpcResponse[] = [];
        for (const rpc of rpcs) {
          if (isNotification(rpc)) continue;
          responses.push(await handleJsonRpc(rpc, ctx));
        }

        const headers = corsHeaders(origin);
        if (newSessionId) headers.set('Mcp-Session-Id', newSessionId);

        // Only notifications: 202 Accepted with no body (Streamable HTTP)
        if (!responses.length) {
          return new Response(null, { status: 202, headers });
        }

        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers });

      } catch (err) {
        const headers = corsHeaders(origin);
        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
            data: err instanceof Error ? err.message : 'Unknown error'
          }
        }), { status: 400, headers });
      }
    }

    // Anything else that isn't the info page is a real 404, so probes for
    // /.well-known/* files don't mistake the info page for them
    if (url.pathname !== '/') {
      return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
    }

    // Default: return info page
    const headers = corsHeaders(origin);
    headers.set('Content-Type', 'text/html');
    return new Response(`
<!DOCTYPE html>
<html>
<head>
  <title>resume-mcp</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .tools { display: grid; gap: 10px; margin: 20px 0; }
    .tool { background: #f9f9f9; padding: 10px; border-radius: 5px; }
    .perk { border-left: 3px solid #f59e0b; }
  </style>
</head>
<body>
  <h1>resume-mcp</h1>
  <p>Your identity as an API endpoint.</p>

  <h2>For AI Agents</h2>
  <p>Connect via MCP protocol: <code>POST ${url.origin}</code></p>

  <h3>Available Tools</h3>
  <div class="tools">
    ${TOOLS.map(t => `
      <div class="tool ${PERK_TOOLS.includes(t.name) ? 'perk' : ''}">
        <strong>${t.name}</strong>
        ${PERK_TOOLS.includes(t.name) ? '<span style="color:#f59e0b"> (perk for guestbook signers)</span>' : ''}
        <br><small>${t.description}</small>
      </div>
    `).join('')}
  </div>

  <h3>Perks</h3>
  <p>Everything else here is free to read. Sign the <a href="${GUESTBOOK_PAGE}">guestbook</a> with <code>leave_message()</code>, or send an <code>Agent-Token</code> header, and two perks open up:</p>
  <ul>
    <li><code>request_time()</code> to ask for time with Bryson (he reviews every request himself)</li>
    <li><code>list_stories()</code> and <code>get_story()</code> for the stories behind the resume</li>
  </ul>

  <p><a href="/.well-known/mcp.json">Discovery JSON</a></p>
</body>
</html>
    `, { headers });
  }
};

/**
 * resume-mcp: Your identity as an API endpoint
 *
 * MCP server that lets AI agents query your professional profile
 * with structured tools instead of scraping HTML.
 */

import profileData from '../data/profile.json';
import { decodeAgentTokenV0, getIntentV1 } from '@agent-tokens/core';

// Types
interface Env {
  GUESTBOOK?: KVNamespace;
  CORS_ORIGIN?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
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

interface GuestbookEntry {
  name: string;
  message: string;
  agent_id?: string;
  contact?: string;
  timestamp: string;
  ip_hash?: string;
}

interface SessionState {
  hasAccess: boolean;
  agentToken?: string;
}

// Hash IP for privacy-preserving logging
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'resume-mcp-salt');
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
    description: 'Get work experience history. Requires guestbook entry or Agent Token.',
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
    description: 'Get technical skills by category. Requires guestbook entry or Agent Token.',
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
    description: 'Leave a message in the guestbook. Unlocks access to gated tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Your name or identifier' },
        message: { type: 'string', description: 'Your message or reason for visiting' },
        agent_id: { type: 'string', description: 'Optional agent identifier' },
        contact: { type: 'string', description: 'Optional contact info' }
      },
      required: ['name', 'message']
    }
  }
];

const FREE_TOOLS = ['get_profile', 'get_projects', 'get_writing', 'leave_message'];
const GATED_TOOLS = ['get_experience', 'get_skills'];

// Tool implementations
function getProfile() {
  return profileData.profile;
}

function getProjects(params: { tag?: string; featured_only?: boolean }) {
  let projects = profileData.projects;

  if (params.tag) {
    projects = projects.filter(p => p.tags.includes(params.tag!.toLowerCase()));
  }

  if (params.featured_only) {
    projects = projects.filter(p => p.featured);
  }

  return projects;
}

function getWriting(params: { platform?: string; limit?: number }) {
  let writing = profileData.writing;

  if (params.platform) {
    writing = writing.filter(w => w.platform === params.platform);
  }

  if (params.limit && params.limit > 0) {
    writing = writing.slice(0, params.limit);
  }

  return writing;
}

function getExperience(params: { current_only?: boolean }) {
  let experience = profileData.experience;

  if (params.current_only) {
    experience = experience.filter(e => e.current);
  }

  return experience;
}

function getSkills(params: { category?: string }) {
  const skills = profileData.skills;

  if (params.category && params.category in skills) {
    return { [params.category]: skills[params.category as keyof typeof skills] };
  }

  return skills;
}

async function leaveMessage(
  params: { name: string; message: string; agent_id?: string; contact?: string },
  env: Env,
  ip: string
): Promise<{ success: boolean; access_granted: boolean; message: string }> {
  const entry: GuestbookEntry = {
    name: params.name,
    message: params.message,
    agent_id: params.agent_id,
    contact: params.contact,
    timestamp: new Date().toISOString(),
    ip_hash: await hashIP(ip)
  };

  // Store in KV if available
  if (env.GUESTBOOK) {
    const key = `entry:${Date.now()}:${crypto.randomUUID()}`;
    await env.GUESTBOOK.put(key, JSON.stringify(entry), {
      metadata: { name: entry.name, timestamp: entry.timestamp }
    });
  }

  // Log to console (visible in Cloudflare dashboard)
  console.log('Guestbook entry:', JSON.stringify(entry));

  return {
    success: true,
    access_granted: true,
    message: `Thanks, ${params.name}! You now have access to all profile information.`
  };
}

// Session tracking (in-memory, per-request chain)
const sessionCache = new Map<string, SessionState>();

function getSessionKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = request.headers.get('User-Agent') || 'unknown';
  return `${ip}:${ua.slice(0, 50)}`;
}

// Handle MCP tool calls
async function handleToolCall(
  tool: string,
  params: Record<string, unknown>,
  session: SessionState,
  env: Env,
  request: Request
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  // Check access for gated tools
  if (GATED_TOOLS.includes(tool) && !session.hasAccess) {
    return {
      error: {
        code: -32001,
        message: 'Access required',
        data: {
          hint: 'Call leave_message() first to introduce yourself, or include an Agent-Token header.',
          gated_tool: tool,
          free_tools: FREE_TOOLS
        }
      }
    };
  }

  // Execute tool
  switch (tool) {
    case 'get_profile':
      return { result: getProfile() };

    case 'get_projects':
      return { result: getProjects(params as { tag?: string; featured_only?: boolean }) };

    case 'get_writing':
      return { result: getWriting(params as { platform?: string; limit?: number }) };

    case 'get_experience':
      return { result: getExperience(params as { current_only?: boolean }) };

    case 'get_skills':
      return { result: getSkills(params as { category?: string }) };

    case 'leave_message': {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const result = await leaveMessage(
        params as { name: string; message: string; agent_id?: string; contact?: string },
        env,
        ip
      );
      // Grant access for this session
      session.hasAccess = true;
      return { result };
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

// Handle MCP JSON-RPC methods
async function handleJsonRpc(
  rpc: JsonRpcRequest,
  session: SessionState,
  env: Env,
  request: Request
): Promise<JsonRpcResponse> {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'resume-mcp',
            version: '1.0.0'
          }
        }
      };

    case 'notifications/initialized':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      };

    case 'tools/call': {
      const toolParams = params as { name: string; arguments?: Record<string, unknown> };
      const toolResult = await handleToolCall(
        toolParams.name,
        toolParams.arguments || {},
        session,
        env,
        request
      );

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

// CORS headers
function corsHeaders(origin?: string): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Agent-Token');
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
          gated: GATED_TOOLS,
          toll: 'leave_message() or Agent-Token header'
        },
        agent_tokens: 'https://github.com/brysontang/agent-tokens'
      };

      const headers = corsHeaders(origin);
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(discovery, null, 2), { headers });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('ok', { headers: corsHeaders(origin) });
    }

    // REST API: Get guestbook entries
    if (url.pathname === '/api/guestbook' && request.method === 'GET') {
      const headers = corsHeaders(origin);
      headers.set('Content-Type', 'application/json');

      if (!env.GUESTBOOK) {
        return new Response(JSON.stringify({ entries: [], error: 'Guestbook not configured' }), { headers });
      }

      try {
        const list = await env.GUESTBOOK.list({ prefix: 'entry:' });
        const entries: GuestbookEntry[] = [];

        for (const key of list.keys) {
          const value = await env.GUESTBOOK.get(key.name);
          if (value) {
            const entry = JSON.parse(value) as GuestbookEntry;
            // Don't expose ip_hash to clients
            const { ip_hash, ...publicEntry } = entry;
            entries.push(publicEntry as GuestbookEntry);
          }
        }

        // Sort by timestamp descending (newest first)
        entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return new Response(JSON.stringify({ entries }), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ entries: [], error: 'Failed to fetch entries' }), { status: 500, headers });
      }
    }

    // REST API: Submit guestbook entry
    if (url.pathname === '/api/guestbook' && request.method === 'POST') {
      const headers = corsHeaders(origin);
      headers.set('Content-Type', 'application/json');

      try {
        const body = await request.json() as { name?: string; message?: string };

        if (!body.name || !body.message) {
          return new Response(JSON.stringify({ success: false, error: 'Name and message are required' }), { status: 400, headers });
        }

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const result = await leaveMessage(
          { name: body.name, message: body.message },
          env,
          ip
        );

        return new Response(JSON.stringify(result), { headers });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request' }), { status: 400, headers });
      }
    }

    // MCP endpoint (POST for JSON-RPC)
    if (request.method === 'POST') {
      try {
        // Check for Agent Token
        const agentToken = request.headers.get('Agent-Token');
        const sessionKey = getSessionKey(request);

        // Get or create session
        let session = sessionCache.get(sessionKey);
        if (!session) {
          session = { hasAccess: false };
          sessionCache.set(sessionKey, session);
        }

        // Agent token grants access
        if (agentToken) {
          try {
            const decoded = decodeAgentTokenV0(agentToken);
            const intent = getIntentV1(decoded);

            if (intent) {
              session.hasAccess = true;
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
            // Invalid token - log but don't grant access
            console.log('Invalid agent token:', e instanceof Error ? e.message : 'Unknown error');
          }
        }

        const body = await request.json() as JsonRpcRequest | JsonRpcRequest[];

        // Handle batch requests
        if (Array.isArray(body)) {
          const responses = await Promise.all(
            body.map(rpc => handleJsonRpc(rpc, session, env, request))
          );
          const headers = corsHeaders(origin);
          headers.set('Content-Type', 'application/json');
          return new Response(JSON.stringify(responses), { headers });
        }

        // Single request
        const response = await handleJsonRpc(body, session, env, request);
        const headers = corsHeaders(origin);
        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(response), { headers });

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
    .gated { border-left: 3px solid #f59e0b; }
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
      <div class="tool ${GATED_TOOLS.includes(t.name) ? 'gated' : ''}">
        <strong>${t.name}</strong>
        ${GATED_TOOLS.includes(t.name) ? '<span style="color:#f59e0b"> (requires access)</span>' : ''}
        <br><small>${t.description}</small>
      </div>
    `).join('')}
  </div>

  <h3>Access</h3>
  <p>Some tools require introduction. Either:</p>
  <ul>
    <li>Call <code>leave_message()</code> to introduce yourself</li>
    <li>Include an <code>Agent-Token</code> header</li>
  </ul>

  <p><a href="/.well-known/mcp.json">Discovery JSON</a></p>
</body>
</html>
    `, { headers });
  }
};

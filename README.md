# resume-mcp

Your identity as an API endpoint.

Traditional portfolios are HTML pages that agents scrape and parse. This is a structured interface where agents can query you directly.

## Why?

When a recruiter's AI assistant visits your site, it:
1. Scrapes HTML
2. Guesses at structure
3. Extracts what it can
4. Loses context

With resume-mcp:
1. Connects to MCP endpoint
2. Calls `get_profile()`, `get_projects()`
3. Gets structured JSON
4. Leaves a trace in your guestbook

You get signal on who's looking. They get clean data.

## Tools

| Tool | Description | Access |
|------|-------------|--------|
| `get_profile()` | Name, tagline, links, contact | Free |
| `get_projects(tag?)` | Projects, optionally filtered | Free |
| `get_writing()` | Articles and blog posts | Free |
| `get_experience()` | Work history | Gated |
| `get_skills()` | Technical skills by category | Gated |
| `leave_message(name, message)` | Sign the guestbook | Free |

## The Toll

Some information requires introduction. Call `leave_message()` or send an Agent Token to unlock extended access.

This isn't gatekeeping - it's relationship building. If you want to know about me, tell me who you are.

```json
{
  "error": "access_required",
  "message": "Leave a message or provide an Agent Token to access this information.",
  "hint": "Call leave_message() first, or include Agent-Token header"
}
```

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/yourusername/resume-mcp
cd resume-mcp
npm install
```

### 2. Add your data

Edit `data/profile.json` with your information:

```json
{
  "profile": {
    "name": "Your Name",
    "tagline": "What you do",
    "links": { "github": "...", "linkedin": "..." },
    "contact": { "email": "..." }
  },
  "projects": [...],
  "experience": [...],
  "skills": {...}
}
```

### 3. Configure Cloudflare Workers

```bash
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your settings
```

Optional: Create KV namespace for persistent guestbook:
```bash
wrangler kv:namespace create "GUESTBOOK"
# Add the returned binding to wrangler.toml
```

### 4. Deploy

```bash
npm run dev      # Local development
npm run deploy   # Deploy to Cloudflare
```

## Discovery

Help agents find your MCP endpoint by adding hints to your portfolio:

### robots.txt
```
# MCP endpoint: https://mcp.yourdomain.dev
# Tools: get_profile, get_projects, get_experience, leave_message
# Agent Tokens accepted for extended access
```

### .well-known/mcp.json
The server automatically serves this at `/.well-known/mcp.json`

### HTML comment
```html
<!--
  AI Agent? Query me directly: https://mcp.yourdomain.dev
  Tools: get_profile(), get_projects(), get_experience()
  Leave a message to introduce yourself. Agent Tokens welcome.
-->
```

## Agent Tokens

This server accepts [Agent Tokens](https://github.com/brysontang/agent-tokens) via the `Agent-Token` header. Tokens that decode successfully grant full access and are logged with their declared intent.

```typescript
// Token provides:
{
  intentId: "recruiting-scan",
  goal: "Find candidates for senior engineering role",
  mode: "read-only"
}
```

## Protocol

Standard MCP over HTTP:

```bash
# Initialize
curl -X POST https://mcp.yourdomain.dev \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl -X POST https://mcp.yourdomain.dev \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST https://mcp.yourdomain.dev \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}'
```

## Fork This

1. Clone
2. Update `data/profile.json` with your info
3. Deploy to Cloudflare Workers
4. Add discovery hints to your portfolio

Your identity, your endpoint, your terms.

## License

MIT

// My Brain MCP server — gives the agent (Codex via Hermes) direct, mid-task access to the
// user's memory and Documents. Each tool call proxies to the app's /api/agent/tools/* REST
// endpoints (authenticated as the owner). Runs on the host as a stdio MCP server spawned by codex.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';

const BASE = process.env.MYBRAIN_URL || 'https://mybrain.1site.ai';

function creds() {
  const env = readFileSync('/home/sandy/mybrain/.claude/checks/secrets.env', 'utf8');
  const g = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
  return { email: g('ADMIN_EMAIL'), password: g('ADMIN_PASSWORD') };
}

let cookie = null;
async function login() {
  const { email, password } = creds();
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
}
async function api(path, body) {
  if (!cookie) await login();
  const mk = () => ({ method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  let r = await fetch(BASE + path, mk());
  if (r.status === 401) { await login(); r = await fetch(BASE + path, mk()); }
  return r.json();
}
async function apiGet(path) {
  if (!cookie) await login();
  let r = await fetch(BASE + path, { headers: { cookie } });
  if (r.status === 401) { await login(); r = await fetch(BASE + path, { headers: { cookie } }); }
  return r.json();
}

const TOOLS = [
  { name: 'search_brain', description: "Search the user's entire second brain (notes, documents, saved memories) by meaning. Use whenever you need context about the user, their people, projects, or anything they've saved.", inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'what to look for' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'save_document', description: "Save a markdown document into the user's Documents library. Set remember:true to also index it into their searchable memory.", inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, remember: { type: 'boolean' } }, required: ['title', 'content'] } },
  { name: 'remember', description: "Store a durable fact in the user's long-term memory (RAG + SuperMemory) for later recall.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] } },
  { name: 'ask_user', description: "Ask the user a question mid-task and wait for their reply. Use for a real decision, preference, or fact only the user knows. Pass the runId you were given in your instructions. If the reply says the user is not available, END YOUR TURN immediately with a one-line note — the run is paused safely and you will be resumed with their answer.", inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'the run id from your instructions' }, question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'optional multiple-choice options' }, defaultValue: { type: 'string', description: 'optional fallback applied if the user never answers' } }, required: ['runId', 'question'] } },
  { name: 'get_answer', description: 'Check whether the user has answered a previously asked question, by its token.', inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } },
];

const server = new Server({ name: 'mybrain', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = req.params.arguments || {};
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  try {
    if (name === 'search_brain') {
      const res = await api('/api/agent/tools/search-brain', { query: args.query, limit: args.limit });
      const lines = (res.results || []).map((h, i) => `${i + 1}. [${h.source}] ${h.title}: ${h.snippet}`).join('\n');
      return text(lines || 'No matching memory found.');
    }
    if (name === 'save_document') {
      const res = await api('/api/agent/tools/save-document', { title: args.title, content: args.content, tags: args.tags, remember: args.remember });
      return text(res?.id ? `Saved "${res.title}" -> ${res.url}` : 'Could not save the document.');
    }
    if (name === 'remember') {
      const res = await api('/api/agent/tools/remember', { text: args.text, tags: args.tags });
      return text(res?.ok ? `Remembered: ${res.remembered}` : 'Could not remember that.');
    }
    if (name === 'ask_user') {
      // Durable ask (BEA-795): creates a Waitpoint (run → awaiting_input). Fast path: if the user
      // is watching the run screen, their answer lands in seconds — wait up to 90s in-turn. Slow
      // path: tell the model to end its turn; the app parks the run and resumes it on the answer.
      const kind = Array.isArray(args.choices) && args.choices.length ? 'choice' : 'free_text';
      const res = await api('/api/agent/tools/ask-user', { runId: args.runId, question: args.question, kind, options: args.choices || [], defaultValue: args.defaultValue });
      if (!res?.token) return { ...text('Could not ask: ' + (res?.message || 'unknown error')), isError: true };
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        const a = await apiGet('/api/agent/tools/answer?token=' + encodeURIComponent(res.token)).catch(() => null);
        if (a && a.status === 'answered') return text('The user answered: ' + (typeof a.answer === 'string' ? a.answer : JSON.stringify(a.answer)));
        if (a && (a.status === 'expired' || a.status === 'cancelled')) return text('The question was ' + a.status + '. Proceed with your best judgment.');
      }
      return text('The user is not available right now. The question is saved and the run is paused. END YOUR TURN NOW with a one-line note that you are waiting for the user. Do NOT continue the task or give a final answer — you will be resumed with their answer.');
    }
    if (name === 'get_answer') {
      const a = await apiGet('/api/agent/tools/answer?token=' + encodeURIComponent(args.token));
      return text(JSON.stringify(a));
    }
    return { ...text('Unknown tool: ' + name), isError: true };
  } catch (e) {
    return { ...text('Tool error: ' + (e?.message || String(e))), isError: true };
  }
});

await server.connect(new StdioServerTransport());

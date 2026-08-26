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
  { name: 'create_agent', description: "Create a whole agent in the user's My Brain app from one spec: an area (name, icon, description, tools) plus its jobs (each with a plain-English task, optional outcome, schedule and settings). Use ONLY after the user has confirmed the final spec.", inputSchema: { type: 'object', properties: { area: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, description: { type: 'string' }, tools: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', description: 'skill | api | mcp | cli' }, name: { type: 'string' }, note: { type: 'string' } } } } }, required: ['name'] }, jobs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, task: { type: 'string' }, outcome: { type: 'string' }, schedule: { type: 'object' }, scheduleText: { type: 'string' }, autonomy: { type: 'string' }, depth: { type: 'string' }, notifyWhatsApp: { type: 'boolean' }, keepDays: { type: 'number' }, evals: { type: 'array', items: { type: 'string' } } }, required: ['name', 'task'] } } }, required: ['area', 'jobs'] } },
  // THE TOOL DOCUMENTS (BEA-1468). The owner: "Each tool should have a document… Codex should have
  // full access to all the tools and actions… If the context is not proper, it cannot create the
  // right agent that we are looking for." So Codex PULLS what it needs, at three levels — what
  // exists, one tool's whole action list, one action's exact detail — instead of being handed a
  // selection somebody else made.
  { name: 'list_tools', description: "Every tool connected to the user's My Brain, with how many actions each has. Start here when you need to know what is available — do not guess a service name, and do not assume something is connected.", inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_doc', description: "One tool's document: what it is, and EVERY action it has with its exact id. Ask for this before choosing an action, using the service id from list_tools (for example 'gmail', 'notion').", inputSchema: { type: 'object', properties: { service: { type: 'string', description: "the service id, e.g. 'gmail'" } }, required: ['service'] } },
  { name: 'action_doc', description: "The full detail of ONE action: its exact parameters, the fields real answers have carried, what it has cost, whether it is failing right now, and any trap recorded about it. Ask for this before calling an action you have not called before — guessing a parameter name is the most common way a build produces a program that runs and returns nothing.", inputSchema: { type: 'object', properties: { actionId: { type: 'string', description: "the exact id, e.g. 'svc:gmail.fetch_emails'" } }, required: ['actionId'] } },
  // TRY IT WHILE YOU BUILD (BEA-1484). The console Codex never had: a real call against his real
  // account, so it writes the program from what it SAW instead of from what the docs implied.
  { name: 'try_action', description: "Make a REAL call against the user's actual connected account and see the real answer. Use this while designing, BEFORE you write the call into the program: check the field names, the shape of what comes back, how big it is, and whether the account is set up for it. Reads AND writes — you may create, update, send and delete, and nothing is refused for what it does. Two things to weigh yourself: prefer things that can be taken back, and archive or delete any test item you create so you do not leave litter in his account. A message to a person cannot be taken back, so prefer his own number if you must prove a send. Limited to 25 tries per build.", inputSchema: { type: 'object', properties: { actionId: { type: 'string', description: "the exact id, e.g. 'svc:gmail.fetch_emails'" }, args: { type: 'object', description: 'the arguments to send, exactly as the action names them' } }, required: ['actionId'] } },
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
    // The tool documents (BEA-1468). Read-only, cheap, and the thing to reach for BEFORE choosing
    // or calling any action — thin context is what made the first real build write a program that
    // could not find Gmail.
    if (name === 'list_tools') {
      const res = await apiGet('/api/tools/docs?as=text');
      return text(res.text || 'No tools are connected yet.');
    }
    if (name === 'tool_doc') {
      const slug = String(args.service || '').toLowerCase().trim();
      if (!slug) return text('Give the service id, for example "gmail". Use list_tools to see them.');
      const res = await apiGet(`/api/tools/docs/${encodeURIComponent(slug)}`);
      if (!res || res.statusCode === 404 || res.message) return text(`There is no tool called "${slug}". Use list_tools to see what exists.`);
      return text(res.text || '');
    }
    if (name === 'action_doc') {
      const id = String(args.actionId || '').trim();
      if (!id) return text('Give the exact action id, for example "svc:gmail.fetch_emails".');
      const res = await apiGet(`/api/tools/docs/action/${encodeURIComponent(id)}`);
      if (!res || res.statusCode === 404 || res.message) return text(`Nothing in the catalog is called ${id}. Use tool_doc to see a tool's actions.`);
      return text(res.text || '');
    }

    if (name === 'try_action') {
      const id = String(args.actionId || '').trim();
      if (!id) return text('Give the exact action id, for example "svc:gmail.fetch_emails".');
      const res = await api('/api/tools/docs/try', { actionId: id, args: args.args || {}, build: process.env.MYBRAIN_BUILD_KEY || 'build' });
      if (res && res.refused) return text(`Refused: ${res.refused}`);
      if (res && res.ok === false) return text(`${id} answered an error: ${res.error || 'unknown'}${res.droppedArgs && res.droppedArgs.length ? `\n\nNote: ${res.droppedArgs.join(', ')} — this action does not take those, so they were never sent. Check the spelling against its card.` : ''}${typeof res.left === 'number' ? `\n\n(${res.left} tries left)` : ''}`);
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
      return text(`${id} really answered:\n\n${body}${res.droppedArgs && res.droppedArgs.length ? `\n\nNote: ${res.droppedArgs.join(', ')} were NOT sent — this action does not take them.` : ''}${typeof res.left === 'number' ? `\n\n(${res.left} tries left)` : ''}`);
    }

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
    if (name === 'create_agent') {
      const res = await api('/api/agent/areas/spec', { area: args.area, jobs: args.jobs });
      if (!res?.ok) return { ...text('Could not create the agent: ' + (res?.message || 'unknown error')), isError: true };
      return text('Created "' + args.area.name + '" with ' + res.jobs.length + ' job(s). Open it: https://mybrain.1site.ai' + res.url);
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

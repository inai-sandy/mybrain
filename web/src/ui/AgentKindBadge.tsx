import { agentKind, kindLook } from './agentKind';

/**
 * TOOLS OR RESEARCH, ON EVERY ROW (BEA-1504).
 *
 * Until now an agent's badge said where it came from — "💬 chat", "🎙 voice" — which tells you how you
 * made it and nothing about what it is. His goal-built email agent, which reads his Gmail and writes
 * to Notion every night, wore the same "chat" badge as his Meshtastic research agent.
 *
 * What you want at a glance is which kind of machine it is: one acts in your accounts, the other
 * reads the web. Where it came from is still there, in the tooltip, because it is worth knowing and
 * not worth a second badge.
 */
export function AgentKindBadge({ agent, origin, className = '' }: { agent: any; origin?: string | null; className?: string }) {
  const look = kindLook(agent);
  const from = origin || agent?.origin;
  const title = from ? `${look.title} · made ${fromWords(String(from))}` : look.title;
  return (
    <span
      title={title}
      data-testid={`kind-${agentKind(agent)}`}
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${look.cls} ${className}`}
    >
      {look.label}
    </span>
  );
}

/** Where it came from, in words, for the tooltip. An origin we do not know is simply not mentioned. */
function fromWords(origin: string): string {
  const m: Record<string, string> = {
    chat: 'in the chat',
    voice: 'by voice',
    goal: 'from a goal you approved',
    social: 'from a Social result',
    import: 'by importing it',
  };
  return m[origin] || `from ${origin}`;
}

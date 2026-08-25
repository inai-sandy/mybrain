import { goalPrompt, transcriptText, toolsText, isQuestion, nothingCameBack, speaker } from './goal';

/**
 * THE GOAL (BEA-1463).
 *
 * These tests exist to stop the app quietly becoming an interpreter again. That is not a
 * hypothetical worry — it is what the previous three designs did, and each one put a defect in front
 * of the owner: a row count where he wanted summaries, "Read it here:" with no link, and a sentence
 * with no verb in it. Every one came from the app writing something it did not understand.
 *
 * So most of what follows asserts an ABSENCE: nothing summarised, nothing dropped, nothing scored,
 * nothing invented.
 */

const turns = [
  { who: 'you', text: 'I want my important emails every night at 10.' },
  { who: 'assistant', text: 'Which mailbox?' },
  { who: 'you', text: 'Gmail. And send it to my WhatsApp — I want to read it there, not click a link.' },
  { who: 'you', text: 'ok' },
];

const tools = [
  { actionId: 'svc:gmail.fetch_emails', name: 'Fetch emails', card: '# Fetch emails\nWhat it does: reads a mailbox.' },
];

describe('the conversation goes over whole', () => {
  it('keeps every turn, in order, with nothing removed', () => {
    const t = transcriptText(turns);
    expect(t).toContain('important emails every night at 10');
    expect(t).toContain('Which mailbox?');
    expect(t).toContain('read it there, not click a link');
    expect(t.indexOf('important emails')).toBeLessThan(t.indexOf('Which mailbox?'));
  });

  it('keeps a turn a summariser would throw away', () => {
    // "ok" carries no information to a summariser and is the entire trigger to this owner. A design
    // that drops short turns is a design that loses requirements hiding in throwaway lines.
    expect(transcriptText(turns)).toContain('ok');
  });

  it('labels who is speaking and does NOT say what a turn meant', () => {
    const t = transcriptText(turns);
    expect(t).toContain('**HIM:**');
    expect(t).toContain('**THE ASSISTANT:**');
    // No interpretation anywhere — no "he decided", no "the requirement is", no section headings.
    expect(t).not.toMatch(/he (decided|wants|asked for)|the requirement|in summary|## /i);
  });

  it('says plainly when there is nothing, rather than inventing a conversation', () => {
    expect(transcriptText([])).toContain('the conversation is empty');
  });

  it('knows which side is him', () => {
    expect(speaker('you')).toBe('HIM');
    expect(speaker('owner')).toBe('HIM');
    expect(speaker('assistant')).toBe('THE ASSISTANT');
  });
});

describe('only the tools he named', () => {
  it('sends each one with whatever the catalog really knows', () => {
    const t = toolsText(tools);
    expect(t).toContain('svc:gmail.fetch_emails');
    expect(t).toContain('reads a mailbox');
  });

  it('says so honestly when there is no fact card, instead of making one up', () => {
    expect(toolsText([{ actionId: 'svc:x.y' }])).toContain('no fact card is available');
  });

  it('carries a real saved answer, and never a fabricated one', () => {
    const t = toolsText([{ actionId: 'svc:x.y', sample: { messages: [{ id: 'm1' }] } }]);
    expect(t).toContain('A real answer this action gave');
    expect(t).toContain('"m1"');
  });

  it('tells Codex to ask rather than guess when he named nothing', () => {
    // The owner's rule: he picks the tools in the chat. Silence is not permission to go shopping.
    expect(toolsText([])).toContain('ask him which — do not guess');
  });
});

describe('what Codex is asked for at this step', () => {
  const prompt = () => goalPrompt({ transcript: turns, tools });

  it('asks for the goal and NOTHING else — no code, no plan, no design', () => {
    const p = prompt();
    expect(p).toContain('One thing: the goal');
    expect(p).toContain('Do not write any code yet');
    expect(p).toMatch(/He approves it\s*first, and then you build/);
  });

  it('says plainly that nobody has interpreted the conversation for it', () => {
    const p = prompt();
    expect(p).toContain('Nobody has interpreted it for you');
    expect(p).toContain('There is no brief, no plan, no summary and no form');
    // …and why, so a later version does not helpfully add one back.
    expect(p).toContain('every one of them quietly changed what he asked for');
  });

  it('asks it to write for HIM, not for a parser', () => {
    // Matched loosely across line wraps — the prompt is prose, and hard-wrapping it is not a change
    // in meaning that a test should fail on.
    expect(prompt()).toMatch(/Write it for HIM to read and approve,\s+not for\s+a machine to parse/);
  });

  it('makes the goal something a real run can be judged against', () => {
    // The owner: "verify the goal and the output". A goal too vague to check is not a goal.
    expect(prompt()).toMatch(/hold a real run's output next to this and say\s+honestly\s+whether it did the job/);
  });

  it('tells it to name its assumptions rather than quietly picking one', () => {
    const p = prompt();
    expect(p).toContain('name the assumption you are making');
    expect(p).toContain('Do not quietly pick one reading');
  });

  it('lets a question BE the whole answer', () => {
    expect(prompt()).toMatch(/reply with a question and\s+nothing else/);
  });

  it('says the web is open, both while building and while running', () => {
    expect(prompt()).toContain('open web');
    expect(prompt()).toContain('Nothing is blocked');
  });

  it('carries his correction back in his own words when he sent one back', () => {
    const p = goalPrompt({ transcript: turns, tools, sentBack: { text: 'Old goal text', note: 'you missed that it must be readable on the phone' } });
    expect(p).toContain('He sent your last goal back');
    expect(p).toContain('readable on the phone');
    expect(p).toContain('the most direct information you have');
  });

  it('does not mention a brief, a plan or a contract anywhere', () => {
    // The three things that were deleted. If any of them creeps back into the prompt, the app has
    // started interpreting again.
    const p = prompt().toLowerCase();
    expect(p).not.toContain('contract.json');
    expect(p).not.toContain('plan.json');
    expect(p).not.toContain('brief.md');
  });
});

describe('telling a goal from a question', () => {
  it('reads a short question as a question', () => {
    expect(isQuestion('Which Gmail account should it read — the work one or the personal one?')).toBe(true);
  });

  it('reads a long goal that happens to contain a question as a goal', () => {
    const goal = `This agent reads your Gmail every night at 22:00 and sends the important messages to WhatsApp.\n\nWhat counts as important? Anything from a person rather than a system, and anything mentioning an invoice.\n\n${'x'.repeat(700)}`;
    expect(isQuestion(goal)).toBe(false);
  });

  it('errs towards showing him a goal he can send back, rather than hiding a question', () => {
    // Wrong in this direction costs one tap. Wrong the other way buries a real question in a wall of
    // text and he never sees that Codex needed him.
    expect(isQuestion('Here is the goal.\n\nIt reads Gmail.\n\nIs that right?')).toBe(false);
    expect(isQuestion('')).toBe(false);
  });
});

describe('when nothing comes back', () => {
  it('says so plainly and promises nothing was built', () => {
    expect(nothingCameBack('')).toContain('Nothing has been built');
  });

  it('is silent when there IS an answer', () => {
    expect(nothingCameBack('the goal')).toBeNull();
  });
});

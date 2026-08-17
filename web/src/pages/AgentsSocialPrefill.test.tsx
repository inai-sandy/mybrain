import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NewAgentForm, readSocialPrefill, socialAgentName } from './Agents';
import { KEEP_AS_FETCHED, coerce } from '../ui/agentJobFields';

/**
 * BEA-1357 — "Make it an agent": the builder opens PRE-FILLED with the tool and the exact arguments
 * the Social page just ran, and saving creates an ordinary Agent (origin social, svc: tool, pinned
 * args, an output destination). BEA-1358 adds the mode choice (fetch · watch · alert + condition).
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));

const params = (q: string) => new URLSearchParams(q);

describe('readSocialPrefill — the URL the Social page navigates to', () => {
  it('reads tool + args + label off /agent?builder=1&tool=&args=&label=', () => {
    const p = readSocialPrefill(params(`builder=1&tool=${encodeURIComponent('svc:instagram.search')}&args=${encodeURIComponent(JSON.stringify({ query: 'smarthomeindia' }))}&label=${encodeURIComponent('Instagram · Search')}`));
    expect(p).toEqual({ tool: 'svc:instagram.search', args: { query: 'smarthomeindia' }, label: 'Instagram · Search' });
  });
  it('is null without builder=1 or without a real svc: id, and survives bad args', () => {
    expect(readSocialPrefill(params('tool=svc:instagram.search'))).toBeNull();
    expect(readSocialPrefill(params('builder=1'))).toBeNull(); // plain "open the builder"
    expect(readSocialPrefill(params('builder=1&tool=web_search'))).toBeNull();
    expect(readSocialPrefill(params('builder=1&tool=svc:instagram.search&args=%7Bnot-json'))?.args).toEqual({});
  });
  it('suggests a name in the owner\'s words: label · the argument values', () => {
    expect(socialAgentName({ tool: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia', date_posted: 'last-month' }, label: 'Instagram · Search Hashtag' })).toBe('Instagram · Search Hashtag · smarthomeindia · last-month');
    expect(socialAgentName({ tool: 'svc:instagram.profile', args: { handle: 'legrand_in' } })).toBe('instagram · profile · legrand_in');
  });
});

describe('NewAgentForm with a Social prefill', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; });
  afterEach(() => cleanup());

  const social = { tool: 'svc:instagram.search', args: { query: 'smarthomeindia', page: 1 }, label: 'Instagram · Search' };

  it('opens on the form step, pre-filled: name, tool + args, "as fetched" task, Google Sheet as the destination', () => {
    render(<MemoryRouter><NewAgentForm social={social} onCreated={() => undefined} onCancel={() => undefined} /></MemoryRouter>);
    expect((screen.getByPlaceholderText('Agent name (e.g. Morning Brief)') as HTMLInputElement).value).toBe('Instagram · Search · smarthomeindia · 1');
    expect(screen.getByTestId('tool-args')).toHaveTextContent('svc:instagram.search');
    expect((screen.getByLabelText('query') as HTMLInputElement).value).toBe('smarthomeindia');
    expect((screen.getByLabelText('page') as HTMLInputElement).value).toBe('1');
    expect((screen.getByPlaceholderText('What should it do each time it runs?') as HTMLTextAreaElement).value).toBe(KEEP_AS_FETCHED);
    expect((screen.getByLabelText('Where the result goes') as HTMLSelectElement).value).toBe('sheet');
    expect(screen.getByLabelText('Append to sheet')).toBeTruthy();
    // engine-only fields are not shown for a direct-fetch job
    expect(screen.queryByText(/Eval cases/)).toBeNull();
    expect(screen.queryByText(/Outcome — what does a good result look like/)).toBeNull();
  });

  it('saving POSTs an ordinary Agent: origin social, tools [svc id], toolArgs pinned, outputDest, sheetId, WhatsApp — then hands back the id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'ag-new' }) });
    const onCreated = vi.fn();
    render(<MemoryRouter><NewAgentForm social={social} onCreated={onCreated} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'legrand' } }); // the args stay editable
    fireEvent.change(screen.getByLabelText('Append to sheet'), { target: { value: 'https://docs.google.com/spreadsheets/d/SHEET1/edit' } });
    fireEvent.blur(screen.getByLabelText('Append to sheet'));
    fireEvent.click(screen.getByLabelText('Send to WhatsApp when it finishes'));
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ag-new'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent/agents');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: 'Instagram · Search · smarthomeindia · 1',
      prompt: KEEP_AS_FETCHED,
      category: 'Social',
      origin: 'social',
      tools: ['svc:instagram.search'],
      toolArgs: { 'svc:instagram.search': { query: 'legrand', page: 1 } }, // a number stays a number
      outputDest: 'sheet',
      sheetId: 'SHEET1', // a pasted link is cleaned to its id
      notifyWhatsApp: true,
      ui: { headline: 'Instagram · Search · smarthomeindia · 1', inputs: [], view: 'report', runLabel: 'Fetch now →' }, // no engine turn to design a screen
    });
  });

  it('Watch / Alert (BEA-1358): the mode choice is on the form; "Alert when…" shows the condition + threshold and they are POSTed', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'ag-alert' }) });
    const onCreated = vi.fn();
    render(<MemoryRouter><NewAgentForm social={social} onCreated={onCreated} onCancel={() => undefined} /></MemoryRouter>);
    const modeSel = screen.getByLabelText('Each run') as HTMLSelectElement;
    expect(modeSel.value).toBe('run'); // fetch every time, by default
    expect(screen.queryByTestId('alert-fields')).toBeNull();
    fireEvent.change(modeSel, { target: { value: 'alert' } });
    expect(screen.getByTestId('alert-fields')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Alert condition'), { target: { value: 'a new post mentions a price' } });
    fireEvent.change(screen.getByLabelText('Threshold field'), { target: { value: 'follower_count' } });
    fireEvent.change(screen.getByLabelText('Threshold direction'), { target: { value: 'below' } });
    fireEvent.change(screen.getByLabelText('Threshold value'), { target: { value: '10,000' } });
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ag-alert'));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      mode: 'alert',
      alertCondition: 'a new post mentions a price',
      threshold: { field: 'follower_count', dir: 'below', value: 10000 },
      ui: { runLabel: 'Check now →' },
    });
  });

  it('a Watch has no condition fields, and the URL can pre-pick the mode (?mode=watch)', async () => {
    expect(readSocialPrefill(params('builder=1&tool=svc:instagram.profile&mode=watch'))).toMatchObject({ mode: 'watch' });
    expect(readSocialPrefill(params('builder=1&tool=svc:instagram.profile&mode=bogus'))!.mode).toBeUndefined();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'ag-w' }) });
    render(<MemoryRouter><NewAgentForm social={{ ...social, mode: 'watch' }} onCreated={() => undefined} onCancel={() => undefined} /></MemoryRouter>);
    expect((screen.getByLabelText('Each run') as HTMLSelectElement).value).toBe('watch');
    expect(screen.queryByTestId('alert-fields')).toBeNull();
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ mode: 'watch', alertCondition: null, threshold: null });
  });

  it('without a prefill the ordinary form still starts on "describe it" and defaults to a Document', () => {
    render(<MemoryRouter><NewAgentForm onCreated={() => undefined} onCancel={() => undefined} /></MemoryRouter>);
    expect(screen.getByText('Fill it in myself')).toBeTruthy();
    fireEvent.click(screen.getByText('Fill it in myself'));
    expect((screen.getByLabelText('Where the result goes') as HTMLSelectElement).value).toBe('document');
    expect(screen.queryByTestId('tool-args')).toBeNull();
  });
});

describe('ToolArgsEditor keeps the type the endpoint was given', () => {
  it('number stays number, yes/no stays boolean, a list stays a list', () => {
    expect(coerce(1, '3')).toBe(3);
    expect(coerce(true, 'no')).toBe(false);
    expect(coerce(['a'], 'x, y ,z')).toEqual(['x', 'y', 'z']);
    expect(coerce([1, 2], '4,5')).toEqual([4, 5]);
    expect(coerce('s', 'text')).toBe('text');
  });
});

/* eslint-disable no-console */
/**
 * BEA-1351 — prove the ServiceProvider road produces the SAME Google data as the gws bridge, side by
 * side, on the same inbox, before the bridge is retired.
 *
 * Nothing here writes to any database. Both roads are read for the same days / thread / files and
 * the results are compared field by field; where a baseline dump exists (what the bridge stored
 * for real — see the ship notes) the seam's output is compared with that too.
 *
 *   COMPOSIO_API_KEY=… npx ts-node --transpile-only -O '{"rootDir":"."}' scripts/compare-google-roads.ts \
 *       [--baseline /tmp/baseline.json] [--days 2026-08-13,2026-08-14] [--thread <id>] [--drive <fileId>,…]
 */
import { createHash } from 'crypto';
import AdmZip from 'adm-zip';
import { readFileSync } from 'fs';
import { GoogleService } from '../src/google/google.service';
import { GoogleWorkspaceService } from '../src/google/google-workspace.service';
import { ComposioProvider } from '../src/tools/composio.provider';

type Upload = { originalname: string; mimetype?: string; buffer: Buffer };
function fakeLibrary() {
  const saved: { file: Upload; sourceUrl?: string | null }[] = [];
  return {
    saved,
    findImported: async () => null,
    replaceContent: async (id: string) => ({ id, title: 'refreshed' }),
    refreshFromUpload: async (id: string) => ({ id, title: 'refreshed' }),
    ensureCollection: async (name: string) => `col-${name}`,
    createFromUpload: async (file: Upload, opts?: { sourceUrl?: string | null }) => {
      saved.push({ file, sourceUrl: opts?.sourceUrl });
      return { id: `doc-${saved.length}`, title: file.originalname.replace(/\.[^.]+$/, '') };
    },
  };
}

function arg(name: string, dflt = ''): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || '' : dflt;
}
const sha = (b: Buffer | string) => createHash('sha1').update(b).digest('hex').slice(0, 12);
let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'MATCH ' : 'DIFF  '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const baselinePath = arg('--baseline');
  const baseline: any = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const days = arg('--days', '2026-08-13,2026-08-14,2026-08-15,2026-08-16').split(',').filter(Boolean);

  const bridgeLib = fakeLibrary();
  const seamLib = fakeLibrary();
  const bridge = new GoogleService({} as any, bridgeLib as any);
  const provider = new ComposioProvider({ get: async () => null } as any);
  const seam = new GoogleWorkspaceService(provider, seamLib as any);

  console.log('== status');
  const [bs, ss] = await Promise.all([bridge.status(), seam.status()]);
  console.log('   bridge:', JSON.stringify(bs));
  console.log('   seam:  ', JSON.stringify(ss));
  check('same account on both roads', !!bs.email && bs.email === ss.email, `${bs.email} vs ${ss.email}`);

  // ---- 1. Daily Brief inputs: unread count + the important-mail list, per day ---------------
  console.log('\n== Daily Brief — per day');
  const metaByDay = new Map<string, any[]>();
  for (const day of days) {
    const [bu, su] = await Promise.all([bridge.gmailDayUnread(day), seam.gmailDayUnread(day)]);
    const [bi, si] = await Promise.all([bridge.gmailImportantForDay(day, 25), seam.gmailImportantForDay(day, 25)]);
    metaByDay.set(day, si);
    check(`${day} unread count`, bu === su, `bridge ${bu} · seam ${su}`);
    check(`${day} important emails: count`, bi.length === si.length, `bridge ${bi.length} · seam ${si.length}`);
    check(`${day} important emails: same ids in same order`, same(bi.map((m) => m.id), si.map((m) => m.id)));
    for (const f of ['threadId', 'from', 'subject', 'date', 'snippet'] as const) {
      check(`${day} important emails: field "${f}" identical`, same(bi.map((m) => m[f]), si.map((m) => m[f])));
    }
    // The exact text the brief model is shown — same builder as gmail-brief.service.ts.
    const lines = (list: any[]) => list.map((e, i) => `${i + 1}. From: ${cleanFrom(e.from)} — ${e.subject}\n   ${(e.snippet || '').slice(0, 200)}`).join('\n');
    const bp = `=== IMPORTANT EMAILS ON ${day} (${bi.length}) ===\n${lines(bi)}`;
    const sp = `=== IMPORTANT EMAILS ON ${day} (${si.length}) ===\n${lines(si)}`;
    check(`${day} brief prompt (model input) byte-identical`, bp === sp, `sha ${sha(bp)} vs ${sha(sp)}, ${bp.length} chars`);
    if (baseline) {
      const row = (baseline.briefs || []).find((b: any) => b.day === day);
      if (row) {
        const items = JSON.parse(row.items || '[]');
        check(`${day} vs STORED brief: unread`, row.unread === su, `stored ${row.unread} · seam ${su}`);
        check(`${day} vs STORED brief: item count`, items.length === si.length, `stored ${items.length} · seam ${si.length}`);
        check(`${day} vs STORED brief: subjects+threads`, same(items.map((x: any) => [x.subject, x.threadId]), si.map((m) => [m.subject, m.threadId])));
      }
    }
  }

  // ---- 2. Email memory: the full body of every important email --------------------------------
  console.log('\n== Email memory — full bodies');
  let bodies = 0, bodiesSame = 0, storedSame = 0, storedChecked = 0;
  for (const [day, list] of metaByDay) {
    for (const m of list) {
      const [bb, sb] = await Promise.all([bridge.gmailMessageFull(m.id), seam.gmailMessageFull(m.id)]);
      bodies++;
      if (bb === sb) bodiesSame++;
      else console.log(`   DIFF body ${day} ${m.id}: bridge ${bb.length} chars sha ${sha(bb)} · seam ${sb.length} chars sha ${sha(sb)}`);
      const stored = baseline?.emails?.find((e: any) => e.id === m.id);
      if (stored) {
        storedChecked++;
        if (stored.body === sb) storedSame++;
        else console.log(`   DIFF vs STORED ${m.id}: stored ${String(stored.body).length} chars · seam ${sb.length} chars`);
      }
    }
  }
  check(`email bodies identical on both roads`, bodies > 0 && bodies === bodiesSame, `${bodiesSame}/${bodies}`);
  if (storedChecked) check(`email bodies identical to what the bridge STORED`, storedSame === storedChecked, `${storedSame}/${storedChecked}`);

  // ---- 3. Requests: search → the same threads; thread → the same text ------------------------
  console.log('\n== Requests');
  const req = baseline?.reqs?.[0];
  const threadId = arg('--thread') || req?.threadId;
  const query = req?.query || 'invoice';
  const [bt, st] = await Promise.all([bridge.gmailSearchThreads(query, 5), seam.gmailSearchThreads(query, 5)]);
  check(`search "${query}": same threads in same order`, same(bt.map((t) => t.threadId), st.map((t) => t.threadId)), `${bt.length} vs ${st.length}`);
  check(`search "${query}": subjects/from/date/snippet identical`, same(bt, st));
  if (threadId) {
    const [bth, sth] = await Promise.all([bridge.gmailThread(threadId), seam.gmailThread(threadId)]);
    check(`thread ${threadId}: subject`, bth.subject === sth.subject, bth.subject);
    check(`thread ${threadId}: message count`, bth.messages.length === sth.messages.length, `${bth.messages.length} vs ${sth.messages.length}`);
    check(`thread ${threadId}: copy byte-identical`, bth.copy === sth.copy, `${bth.copy.length} chars, sha ${sha(bth.copy)} vs ${sha(sth.copy)}`);
    if (req?.emailCopy) check(`thread ${threadId}: matches the STORED request's emailCopy`, req.emailCopy === sth.copy.slice(0, 60000), `${req.emailCopy.length} vs ${sth.copy.length} chars`);
    // Import (thread + attachments) — bytes only, into fake libraries.
    const [bi, si] = await Promise.all([bridge.gmailThreadImport(threadId), seam.gmailThreadImport(threadId)]);
    check(`thread import: attachment count`, bi.attachments === si.attachments, `${bi.attachments} vs ${si.attachments}`);
    const fp = (lib: ReturnType<typeof fakeLibrary>) => lib.saved.map((s) => `${s.file.originalname}|${s.file.mimetype}|${s.file.buffer.length}|${sha(s.file.buffer)}`);
    const bf = fp(bridgeLib), sf = fp(seamLib);
    check(`thread import: every saved file identical (name, type, size, sha1)`, same(bf, sf), `${bf.length} files`);
    for (const line of sf) console.log(`   ${line}`);
    bridgeLib.saved.length = 0; seamLib.saved.length = 0;
  }

  // ---- 4. Drive import: same bytes ------------------------------------------------------------
  console.log('\n== Drive import');
  let driveIds = arg('--drive').split(',').filter(Boolean);
  if (!driveIds.length) {
    const files = await seam.driveList();
    const pick = (pred: (f: any) => boolean) => files.find(pred)?.id;
    driveIds = [pick((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet'), pick((f) => f.mimeType === 'application/vnd.google-apps.document'), pick((f) => f.mimeType === 'application/pdf')].filter(Boolean) as string[];
  }
  const [bl, sl] = await Promise.all([bridge.driveList(), seam.driveList()]);
  check(`drive list: same files, same order`, same(bl.map((f) => f.id), sl.map((f) => f.id)), `${bl.length} vs ${sl.length}`);
  for (const id of driveIds) {
    bridgeLib.saved.length = 0; seamLib.saved.length = 0;
    const [br, sr] = await Promise.all([bridge.driveImport(id).catch((e) => ({ error: String(e?.message || e) })), seam.driveImport(id).catch((e) => ({ error: String(e?.message || e) }))]);
    const b = bridgeLib.saved[0], s = seamLib.saved[0];
    if (!b || !s) { check(`drive ${id}: both roads produced a file`, false, JSON.stringify({ br, sr })); continue; }
    check(`drive ${id} "${s.file.originalname}": name+type identical`, b.file.originalname === s.file.originalname && b.file.mimetype === s.file.mimetype);
    if (b.file.buffer.equals(s.file.buffer)) {
      check(`drive ${id}: bytes identical`, true, `${b.file.buffer.length} bytes, sha ${sha(s.file.buffer)}`);
    } else if (/officedocument/.test(String(s.file.mimetype))) {
      // A Google export is a zip whose entry timestamps are the export second — two exports of the
      // same file a second apart differ in sha even on ONE road (checked). Slides go further: the
      // pptx export numbers its media files in a different order every time (checked twice on the
      // bridge alone: same media, same slide XML, different image16.jpg/image16.png names and rels).
      // So compare what a reader gets: the multiset of entry CONTENTS, with the name-mapping
      // `.rels` files left out. The embedded font subsets (`ppt/fonts/*.fntdata`) are left out too:
      // Google hands a different BUILD of the same font depending on where the export request comes
      // from (5 of 16 differed between the VPS and the provider; each road is self-consistent), and
      // a font file is not the document — every slide, picture and theme was identical.
      const contents = (buf: Buffer) => new AdmZip(buf).getEntries().filter((e) => !e.entryName.endsWith('.rels') && !e.entryName.startsWith('ppt/fonts/')).map((e) => sha(e.getData())).sort();
      const fonts = (buf: Buffer) => new AdmZip(buf).getEntries().filter((e) => e.entryName.startsWith('ppt/fonts/'));
      const bc = contents(b.file.buffer), sc = contents(s.file.buffer);
      const fb = fonts(b.file.buffer), fs = fonts(s.file.buffer);
      const fontsSame = fb.filter((e) => fs.some((x) => x.entryName === e.entryName && x.getData().equals(e.getData()))).length;
      check(`drive ${id}: export contents identical (${bc.length} zip entries by content; timestamps, media numbering and font builds ignored)`, bc.length > 0 && same(bc, sc), `${b.file.buffer.length} vs ${s.file.buffer.length} bytes${fb.length ? `; embedded font files identical ${fontsSame}/${fb.length}` : ''}`);
    } else {
      check(`drive ${id}: bytes identical`, false, `${b.file.buffer.length} vs ${s.file.buffer.length} bytes, sha ${sha(b.file.buffer)} vs ${sha(s.file.buffer)}`);
    }
    check(`drive ${id}: link (dedupe key) identical`, b.sourceUrl === s.sourceUrl, `${b.sourceUrl}`);
  }

  // ---- 5. Calendar ------------------------------------------------------------------------------
  console.log('\n== Calendar');
  const [bc, sc] = await Promise.all([bridge.calendar(), seam.calendar()]);
  check(`calendar: same events`, same(bc, sc), `${bc.length} vs ${sc.length}`);

  console.log(`\n== ${failures === 0 ? 'ALL MATCH' : `${failures} DIFFERENCE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** "Sandeep K <s@x.com>" → "Sandeep K"; bare address kept as-is. (copied from gmail-brief.service.ts) */
function cleanFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.*>/);
  return (m ? m[1] : from).trim() || from;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

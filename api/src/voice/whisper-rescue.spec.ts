import { gptTooShort, judgeRescue, RESCUE_MIN_LOGPROB, WhisperVerbose } from './whisper-rescue';

/* The six recordings the rule switched or rejected when it was replayed over all 50 on the server
   (2026-09-10). Word counts, whisper's log-prob and detected language are the measured values; the
   texts are shortened. Two are real rescues the owner confirmed by ear; three are whisper inventing
   on near-silent audio; one is unproven and must be declined. */
const seg = (avg_logprob: number) => [{ avg_logprob, no_speech_prob: 0.4, compression_ratio: 1.3 }];
const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

const FIX: { name: string; secs: number; gpt: string; whisper: WhisperVerbose; accept: boolean }[] = [
  { name: 'the quiet 1.5 m take (owner: audible) 3→60', secs: 29, gpt: "It's just …",
    whisper: { text: 'This is just a demo recording. ' + words(54), language: 'english', segments: seg(-0.59) }, accept: true },
  { name: 'a 20 s take 0→23', secs: 20, gpt: '',
    whisper: { text: "I'm recording for 10 seconds. This is just a basic recording. " + words(12), language: 'english', segments: seg(-0.54) }, accept: true },
  { name: 'the NS-off take 6→27 (unproven: not confident)', secs: 18, gpt: 'Hey, this is just a demo',
    whisper: { text: 'Hey, this is just a demo recording, but you know, ' + words(17), language: 'english', segments: seg(-0.89) }, accept: false },
  { name: 'a 9 s near-silent take: "please subscribe" (nynorsk)', secs: 9, gpt: '',
    whisper: { text: 'If you enjoyed the video, please subscribe, like, and set notifications.', language: 'nynorsk', segments: seg(-0.99) }, accept: false },
  { name: 'a 4 s take: Korean "thanks for watching"', secs: 4, gpt: '',
    whisper: { text: '시청 해주셔서 감사합니다.', language: 'nynorsk', segments: seg(-0.78) }, accept: false },
  { name: 'the 02:18 very-low take: "end of my presentation"', secs: 22, gpt: 'This.',
    whisper: { text: 'This is the end of my presentation, and I wish you a very fine day. Thank you very much. ' + words(27), language: 'english', segments: seg(-0.98) }, accept: false },
];

describe('whisper rescue — the guard (2026-09-10)', () => {
  for (const f of FIX) {
    it(`${f.accept ? 'KEEPS' : 'declines'}: ${f.name}`, () => {
      expect(gptTooShort(f.gpt, f.secs)).toBe(true);          // every fixture is a take gpt came back near-empty on
      const v = judgeRescue(f.whisper, f.gpt, f.secs);
      expect(v.accept).toBe(f.accept);
    });
  }

  it('never consults whisper when gpt was plausible', () => {
    expect(gptTooShort('This is just a demo recording to understand how well it can record', 20)).toBe(false);
    expect(gptTooShort('one two three four five six', 20)).toBe(true);     // 6 words for 20 s: under ~1 word per 3 s
    expect(gptTooShort('one two three four five six seven eight', 20)).toBe(false);   // 8 words for 20 s: plausible, whisper is not consulted
  });

  it('the confidence bar is the measured one', () => {
    expect(RESCUE_MIN_LOGPROB).toBe(-0.7);
    const base = { text: words(30), language: 'english' as const };
    expect(judgeRescue({ ...base, segments: seg(-0.69) }, '', 20).accept).toBe(true);
    expect(judgeRescue({ ...base, segments: seg(-0.71) }, '', 20).accept).toBe(false);
  });

  it('Telugu is a language the owner speaks; anything else is not believed', () => {
    const t = words(30);
    expect(judgeRescue({ text: t, language: 'telugu', segments: seg(-0.5) }, '', 20).accept).toBe(true);
    expect(judgeRescue({ text: t, language: 'portuguese', segments: seg(-0.5) }, '', 20).accept).toBe(false);
  });

  it('the same few words repeated are not a rescue', () => {
    expect(judgeRescue({ text: 'E aí '.repeat(20), language: 'english', segments: seg(-0.3) }, '', 20).accept).toBe(false);
  });

  it('whisper must clearly beat gpt and sound like speech', () => {
    expect(judgeRescue({ text: words(5), language: 'english', segments: seg(-0.3) }, 'a b c', 20).accept).toBe(false);   // not 3x
    expect(judgeRescue({ text: words(6), language: 'english', segments: seg(-0.3) }, '', 60).accept).toBe(false);        // 0.1 words/s
  });

  it('a missing or broken length never triggers a rescue and never passes the guard', () => {
    expect(gptTooShort('', NaN)).toBe(false);
    expect(judgeRescue({ text: words(30), language: 'english', segments: seg(-0.3) }, '', NaN).accept).toBe(false);
  });
});

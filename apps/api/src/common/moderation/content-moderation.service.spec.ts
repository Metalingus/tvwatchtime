import { ContentModerationService } from './content-moderation.service';
import { ModerationService as ImageModeration } from '../../comment-images/lib/moderation';

function fixture(enabled = true) {
  const config: any = {
    get: (key: string) =>
      (
        ({
          'commentImages.openaiApiKey': enabled ? 'test-only-key' : '',
          'commentImages.openaiModerationModel': 'omni-moderation-latest',
          nodeEnv: 'test',
        }) as Record<string, unknown>
      )[key],
  };
  const result: any = { flagged: false, categories: {}, category_scores: {} };
  const http = jest.fn(async () => new Response(JSON.stringify({ results: [result] })));
  return { service: new ContentModerationService(config, http as any), config, result, http };
}
it('uses the existing key/model for text-only moderation, including text after character 2000', async () => {
  const f = fixture();
  const text = 'a'.repeat(2100) + ' tail must be checked';
  await f.service.moderateText(text);
  const args = (f.http.mock.calls as any)[0];
  expect(args[0]).toBe('https://api.openai.com/v1/moderations');
  expect(JSON.parse(args[1].body)).toEqual({
    model: 'omni-moderation-latest',
    input: [{ type: 'text', text }],
  });
  expect(args[1].redirect).toBe('error');
  expect(args[1].signal).toBeDefined();
});
it('uses the same service for image bytes and the complete caption', async () => {
  const f = fixture();
  const image = new ImageModeration(f.service);
  await image.moderate('caption', Buffer.from('image-bytes'), 'image/png');
  const input = JSON.parse((f.http.mock.calls as any)[0][1].body).input;
  expect(input).toEqual([
    { type: 'text', text: 'caption' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,' + Buffer.from('image-bytes').toString('base64') },
    },
  ]);
});
it('allows character criticism with a moderate harassment score despite the provider flag', async () => {
  const f = fixture();
  f.result.flagged = true;
  f.result.categories = { harassment: true };
  f.result.category_scores = { harassment: 0.7 };
  // Synthetic response: this tests our policy, not the live model's classification.
  expect(await f.service.moderateText('Doug is a horrible friend and husband')).toMatchObject({
    flagged: true,
    decision: 'allow',
  });
});
it.each([
  'violence',
  'violence/graphic',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'illicit',
  'illicit/violence',
])('does not automatically reject a discussion flagged only for %s', async (category) => {
  const f = fixture();
  f.result.flagged = true;
  f.result.categories = { [category]: true };
  f.result.category_scores = { [category]: 0.99 };
  expect((await f.service.moderateText('Discussion of a scene')).decision).toBe('allow');
});
it.each([
  ['sexual/minors', 0.01],
  ['sexual', 0.5],
  ['hate', 0.8],
  ['hate/threatening', 0.5],
  ['harassment', 0.9],
  ['harassment/threatening', 0.5],
] as const)('rejects %s at its cutoff but allows lower scores', async (category, cutoff) => {
  const f = fixture();
  f.result.flagged = true;
  f.result.categories = { [category]: true };
  f.result.category_scores = { [category]: cutoff };
  expect((await f.service.moderateText('Submitted text')).decision).toBe('reject');
  f.result.category_scores[category] = cutoff - 0.001;
  expect((await f.service.moderateText('Submitted text')).decision).toBe('allow');
});
it('still rejects sexual images when the caption has only a moderate harassment score', async () => {
  const f = fixture();
  f.result.flagged = true;
  f.result.categories = { sexual: true, harassment: true, violence: true };
  f.result.category_scores = { sexual: 0.95, harassment: 0.7, violence: 0.99 };
  const image = new ImageModeration(f.service);
  expect(
    (
      await image.moderate(
        'Doug is a horrible friend and husband',
        Buffer.from('image'),
        'image/png',
      )
    ).decision,
  ).toBe('reject');
});
it('allows an image/caption flagged only for fictional violence and moderate criticism', async () => {
  const f = fixture();
  f.result.flagged = true;
  f.result.categories = { violence: true, harassment: true };
  f.result.category_scores = { violence: 0.99, harassment: 0.7 };
  const image = new ImageModeration(f.service);
  expect(
    (
      await image.moderate(
        'Doug is a horrible friend and husband',
        Buffer.from('image'),
        'image/png',
      )
    ).decision,
  ).toBe('allow');
});
it('skips local checks when the existing OpenAI key is absent', async () => {
  const f = fixture(false);
  expect((await f.service.moderateText('text')).model).toBe('skipped');
  expect(f.http).not.toHaveBeenCalled();
});
it('never falls back to real HTTP in a test', async () => {
  const f = fixture();
  await expect(new ContentModerationService(f.config).moderateText('text')).rejects.toThrow(
    'mock moderation transport',
  );
});
it('does not include provider error bodies or submitted content in errors', async () => {
  const f = fixture();
  f.http.mockResolvedValue(new Response('private submitted text', { status: 500 }));
  await expect(f.service.moderateText('private submitted text')).rejects.toThrow(
    'Content moderation failed (500)',
  );
});
it.each([{}, { results: [] }, { results: [{ flagged: 'false' }] }])(
  'rejects malformed moderation output',
  async (body) => {
    const f = fixture();
    f.http.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(f.service.moderateText('text')).rejects.toThrow();
  },
);
it('reports a moderation outage to local submission', async () => {
  const f = fixture();
  f.http.mockRejectedValue(new Error('offline'));
  await expect(f.service.moderateText('draft')).rejects.toThrow('unavailable');
});

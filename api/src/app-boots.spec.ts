import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * The app can actually start.
 *
 * Added after BEA-1259 shipped a change that made `npm start` die on the first line — while 2,022
 * unit tests and `tsc --noEmit` all passed. Every spec in this repo builds its service by hand
 * (`new FlowRunnerService(a, b, c, …)`), which bypasses Nest's dependency injection completely, so
 * nothing noticed that `FlowRunnerService` now asked for a provider its module could not supply:
 *
 *     Nest can't resolve dependencies of the FlowRunnerService (…, ?).
 *     Please make sure that the argument NewsPipelineService at index [17]
 *     is available in the FlowsModule context.
 *
 * A `?` on a constructor parameter only makes TypeScript happy. Nest still treats it as required
 * unless it carries `@Optional()`. So "the types are fine and the tests are green" said nothing at
 * all about whether the thing runs.
 *
 * This compiles the real module graph. It is the cheapest possible guard against a whole class of
 * wiring mistake that is otherwise invisible until deploy.
 */
describe('the whole module graph resolves', () => {
  it('compiles AppModule — every provider can be constructed', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeTruthy();
    await moduleRef.close();
  }, 60_000);
});

import { describe, expect, it } from 'vitest';
import { sortTasksBy, taskWhen, Task } from './taskShared';

const t = (id: string, createdAt: string): Task =>
  ({ id, title: id, tags: [], priority: 'medium', pinned: false, status: 'open', rolloverCount: 0, createdAt } as Task);

describe('sortTasksBy', () => {
  const list = [t('a', '2026-06-09T08:00:00Z'), t('b', '2026-06-11T09:30:00Z'), t('c', '2026-06-10T12:00:00Z')];

  it('newest puts the most recently created task first', () => {
    expect(sortTasksBy(list, 'newest').map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('oldest puts the earliest task first', () => {
    expect(sortTasksBy(list, 'oldest').map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the original list', () => {
    sortTasksBy(list, 'newest');
    expect(list.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('taskWhen', () => {
  it('shows a time for a task created today and a date for older ones', () => {
    const now = new Date('2026-06-11T15:00:00');
    expect(taskWhen('2026-06-11T09:30:00', now)).toMatch(/9:30/);
    expect(taskWhen('2026-06-09T09:30:00', now)).toMatch(/Jun|9/);
    expect(taskWhen('not-a-date', now)).toBe('');
  });
});

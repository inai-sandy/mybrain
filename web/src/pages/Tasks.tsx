import { CheckSquare } from 'lucide-react';
import { PagePlaceholder } from './PagePlaceholder';

export function Tasks() {
  return (
    <PagePlaceholder
      title="Tasks"
      subtitle="Your daily loop — with auto-rollover and Telegram digests."
      icon={CheckSquare}
    />
  );
}

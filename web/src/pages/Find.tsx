import { Search } from 'lucide-react';
import { PagePlaceholder } from './PagePlaceholder';

export function Find() {
  return (
    <PagePlaceholder
      title="Find"
      subtitle="Search everything you've saved — fast and safe."
      icon={Search}
    />
  );
}

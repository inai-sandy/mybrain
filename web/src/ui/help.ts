// Help / support documents shown in the header "Help" dropdown.
// To add a new doc: drop a self-contained .html into web/public/help/ and add one line here.
export type HelpDoc = { title: string; href: string };

export const HELP_DOCS: HelpDoc[] = [
  { title: '✨ What is My Brain?', href: '/welcome.html' },
  { title: 'Tasks & Activity — Guide', href: '/help/tasks-and-activity.html' },
];

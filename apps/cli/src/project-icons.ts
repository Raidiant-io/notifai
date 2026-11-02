// The Project icons a User or agent can pick, grouped as the dashboard and phone apps group them.
// Keep in step with the service catalog (a private test asserts it).
export const PROJECT_ICON_GROUPS: readonly { name: string; ids: readonly string[] }[] = [
  {
    name: 'Code and agents',
    ids: [
      'terminal', 'code', 'branch', 'bug', 'robot', 'sparkle', 'cpu', 'binary', 'braces', 'command', 'git-commit', 'package', 'workflow', 'bot',
    ],
  },
  {
    name: 'Delivery and tooling',
    ids: [
      'rocket', 'bolt', 'layers', 'flask', 'wrench', 'hammer', 'settings', 'sliders', 'circle-check', 'circle-play', 'repeat', 'refresh', 'timer', 'gauge',
    ],
  },
  {
    name: 'Products and surfaces',
    ids: [
      'phone', 'layout', 'globe', 'cart', 'game', 'monitor', 'tablet', 'watch', 'app-window', 'panels', 'shopping-bag', 'radio', 'megaphone',
    ],
  },
  {
    name: 'Services and infrastructure',
    ids: [
      'server', 'cloud', 'database', 'network', 'shield', 'pulse', 'key', 'wifi', 'router', 'hard-drive', 'container', 'box', 'boxes', 'cable', 'plug', 'webhook', 'lock',
    ],
  },
  {
    name: 'Knowledge and record-keeping',
    ids: [
      'chart', 'document', 'folder', 'search', 'calendar', 'mail', 'banknote', 'book', 'bookmark', 'clipboard', 'list', 'file-text', 'notebook', 'tags', 'archive', 'inbox', 'receipt',
    ],
  },
  {
    name: 'Communication and people',
    ids: [
      'message', 'messages', 'bell', 'send', 'at-sign', 'users', 'person', 'contact', 'headphones', 'microphone', 'video',
    ],
  },
  {
    name: 'Life and creativity',
    ids: [
      'home', 'plant', 'camera', 'music', 'palette', 'image', 'cooking', 'dumbbell', 'heart', 'coffee', 'map-pin', 'plane', 'sun', 'moon',
    ],
  },
]

export const PROJECT_ICON_IDS: readonly string[] = PROJECT_ICON_GROUPS.flatMap((group) => group.ids)

export function isProjectIconId(value: string): boolean {
  return PROJECT_ICON_IDS.includes(value)
}

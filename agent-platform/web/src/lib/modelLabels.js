// Etichette del model tiering (docs/model-tiering.md), stesso alias esposto
// da GET /api/tenants/:id/agents e /api/tenants/:id/organigramma (campo
// model del manifest). Modulo condiviso (task 2cc8ade2): prima duplicato in
// AgentList.jsx, ora unica fonte per AgentList e Organigramma.
export const MODEL_LABELS = {
  'opus-5': '🚀 Opus 5',
  'fable-5': '🌟 Fable 5',
  opus: '🧭 Opus 4.8',
  sonnet: '⚙️ Sonnet 5',
  haiku: '⚡ Haiku 4.5',
};

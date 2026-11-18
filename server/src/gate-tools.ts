/** Hermes tools the approval gate (gate.ts) looks at. The hook's matcher is built from this list. */
export const GATED_TOOLS = ['terminal', 'execute_code', 'browser_exec', 'browser_cdp', 'browser_vault', 'computer_use'] as const;
export const GATE_MATCHER = `^(${GATED_TOOLS.join('|')})$`;

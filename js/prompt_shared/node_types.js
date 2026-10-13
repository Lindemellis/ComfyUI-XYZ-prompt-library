export const NODE_TYPES = new Set([
  'XYZ Prompt Library V3', 'XYZ Prompt Library V3 Monaco',
  'XYZ Prompt Library V4', 'XYZ Prompt Library V4 Monaco',
]);
export const isMonacoNode = node => node?.comfyClass?.endsWith('Monaco') ?? false;

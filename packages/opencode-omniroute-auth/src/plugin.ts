import type { Plugin } from '@opencode-ai/plugin';
import { createOmniRoutePlugin } from './plugin-core.js';

export const OmniRouteAuthPlugin: Plugin = async (input) => {
  return createOmniRoutePlugin(input);
};

export default OmniRouteAuthPlugin;

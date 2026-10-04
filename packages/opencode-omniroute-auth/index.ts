import { OmniRouteAuthPlugin } from './src/plugin.js';
import { omniRouteV2Plugin } from './src/plugin-core.js';

export { OmniRouteAuthPlugin, omniRouteV2Plugin };
export default { ...omniRouteV2Plugin, server: OmniRouteAuthPlugin };
export type {
  OmniRouteApiMode,
  OmniRouteConfig,
  OmniRouteModel,
  OmniRouteModelListConfig,
  OmniRouteModelMetadata,
  OmniRouteModelMetadataBlock,
  OmniRouteModelMetadataConfig,
  OmniRouteModelsDevConfig,
} from './src/types.js';

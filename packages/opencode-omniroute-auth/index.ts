import { OmniRouteAuthPlugin } from './src/plugin.js';

export { OmniRouteAuthPlugin };
export default { id: 'opencode-omniroute-auth', server: OmniRouteAuthPlugin };
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

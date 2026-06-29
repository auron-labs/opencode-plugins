import OmniRouteAuthPlugin from '../dist/index.js';
import { fetchModels } from '../dist/runtime.js';

function printUsage() {
  console.log(`Usage:
  OMNIROUTE_BASE_URL=http://localhost:20128/v1 npm run smoketest -- [options]

Options:
  --base-url <url>       Override OMNIROUTE_BASE_URL
  --api-key <key>        Override OMNIROUTE_API_KEY (optional)
  --api-mode <mode>      chat | responses (default: chat)
  --model-list <json>    JSON object passed to provider.omniroute.options.modelList
  --limit <n>            Number of models to print (default: 20)
  --help                 Show this message

Examples:
  npm run smoketest -- --base-url http://localhost:20128/v1\
    --model-list '{"dedupe":"primary","cleanNames":true,"sort":"name"}'
`);
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.OMNIROUTE_BASE_URL,
    apiKey: process.env.OMNIROUTE_API_KEY,
    apiMode: 'chat',
    limit: 20,
    modelList: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help') {
      options.help = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === '--base-url') {
      options.baseUrl = value;
      index += 1;
      continue;
    }

    if (arg === '--api-key') {
      options.apiKey = value;
      index += 1;
      continue;
    }

    if (arg === '--api-mode') {
      options.apiMode = value;
      index += 1;
      continue;
    }

    if (arg === '--model-list') {
      options.modelList = JSON.parse(value);
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${value}`);
      }
      options.limit = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function validateOptions(options) {
  if (!options.baseUrl) {
    throw new Error('Missing OmniRoute base URL. Set OMNIROUTE_BASE_URL or pass --base-url.');
  }

  if (options.apiMode !== 'chat' && options.apiMode !== 'responses') {
    throw new Error(`Invalid api mode: ${options.apiMode}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  validateOptions(options);
  if (options.apiKey) {
    process.env.OMNIROUTE_API_KEY = options.apiKey;
  }

  const plugin = await OmniRouteAuthPlugin({});
  const config = {
    provider: {
      omniroute: {
        options: {
          baseURL: options.baseUrl,
          apiMode: options.apiMode,
          ...(options.modelList ? { modelList: options.modelList } : {}),
        },
      },
    },
  };

  await plugin.config(config);
  let entries;
  let mode;

  if (options.apiKey) {
    const provider = config.provider.omniroute;
    const models = await plugin.provider.models(provider, {
      auth: { type: 'api', key: options.apiKey },
    });
    entries = Object.values(models);
    mode = 'plugin-provider';
  } else {
    const models = await fetchModels(
      {
        baseUrl: options.baseUrl,
        apiKey: '',
        apiMode: options.apiMode,
        ...(options.modelList ? { modelList: options.modelList } : {}),
      },
      '',
      true,
    );
    entries = models.map((model) => ({ id: model.id, name: model.name }));
    mode = 'runtime-fetch';
  }

  console.log(`Fetched ${entries.length} models from ${options.baseUrl}`);
  console.log(`apiMode=${options.apiMode}`);
  console.log(`auth=${options.apiKey ? 'api-key' : 'none'}`);
  console.log(`mode=${mode}`);
  if (options.modelList) {
    console.log(`modelList=${JSON.stringify(options.modelList)}`);
  }

  for (const model of entries.slice(0, options.limit)) {
    console.log(`${model.id} -> ${model.name}`);
  }

  if (entries.length > options.limit) {
    console.log(`... ${entries.length - options.limit} more models`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

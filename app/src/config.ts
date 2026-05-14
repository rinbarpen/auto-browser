import 'dotenv/config';

export const config = {
  hxcy: {
    baseUrl: process.env.HXCY_BASE_URL ?? 'https://hxcy.top',
    username: process.env.HXCY_USERNAME ?? 'lpout',
    password: process.env.HXCY_PASSWORD ?? 'klioud123',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    model: process.env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.2-3b-instruct:free',
  },
  captcha: {
    provider: (process.env.CAPTCHA_PROVIDER ?? '') as 'capsolver' | '2captcha' | '',
    apiKey: process.env.CAPTCHA_API_KEY ?? process.env.CAPSOLVER_API_KEY ?? '',
  },
  db: {
    path: process.env.DB_PATH ?? './data/resources.db',
  },
  server: {
    port: parseInt(process.env.PORT ?? '3000', 10),
  },
};

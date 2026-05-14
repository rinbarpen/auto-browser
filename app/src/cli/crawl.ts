#!/usr/bin/env node
import { runCrawl } from '../crawler/crawl.js';

function parseArgs(): { headless: boolean; profile?: string } {
  const argv = process.argv.slice(2);
  let headless: boolean | null = null;
  let profile: string | undefined = process.env.HXCY_PROFILE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headless') headless = true;
    else if (arg === '--no-headless' || arg === '--visible') headless = false;
    else if (arg === '--profile' && argv[i + 1]) {
      profile = argv[++i];
    }
  }

  if (headless == null) {
    const headlessEnv = process.env.HXCY_HEADLESS ?? process.env.HEADLESS;
    headless = headlessEnv == null ? true : !['0', 'false', 'no'].includes(headlessEnv.toLowerCase());
  }
  return { headless, profile };
}

async function main(): Promise<void> {
  const { headless, profile } = parseArgs();
  console.log('Starting hxcy.top crawl...', headless ? '(headless)' : '(visible - 可视化访问)');
  const { collected, skipped } = await runCrawl({ headless, profile });
  console.log(`Done. Collected: ${collected}, Skipped (duplicates): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

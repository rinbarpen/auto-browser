export type LinkPlatform = 'baidu' | 'aliyun' | 'other';

export interface ResourceLink {
  url: string;
  platform: LinkPlatform;
  extractCode?: string;
  unzipPassword?: string;
}

export interface Resource {
  id: string;
  sourceUrl: string;
  title: string;
  category: string;
  links: ResourceLink[];
  qrContent?: string;
  context: string;
  createdAt: string;
  contentHash: string;
}

export interface ExtractedResource {
  title: string;
  links: ResourceLink[];
  extractCode?: string;
  unzipPassword?: string;
  context: string;
}

export type CrawlPhase = 'idle' | 'launching' | 'logging_in' | 'navigating' | 'extracting' | 'done' | 'error';

export interface CrawlStatus {
  phase: CrawlPhase;
  currentUrl?: string;
  logs: { timestamp: string; message: string }[];
  screenshot?: string;
  collected: number;
  skipped: number;
  totalUrls?: number;
  currentUrlIndex?: number;
  error?: string;
}

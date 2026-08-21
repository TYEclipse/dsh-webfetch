/**
 * Tool definitions for dsh-webfetch: two read-only web tools exposed to every
 * agent — web_fetch (URL to clean markdown/text) and web_links (link
 * inventory of a page). Both validate the URL, follow a bounded number of
 * redirects, enforce a size cap and never send credentials.
 *
 * @module dsh-webfetch/tools
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ResolvedConfig } from './index.ts';
export interface ToolSet {
    web_fetch: ToolDefinition;
    web_links: ToolDefinition;
    web_feed: ToolDefinition;
}
/** One entry of a web_feed result (optional fields only present when known). */
export interface FeedItem {
    title: string;
    url: string;
    published?: string;
    author?: string;
    summary?: string;
    content?: string;
}
/** Build the two web tool definitions from the resolved config. */
export declare function buildWebfetchTools(config: ResolvedConfig): ToolSet;
//# sourceMappingURL=tools.d.ts.map
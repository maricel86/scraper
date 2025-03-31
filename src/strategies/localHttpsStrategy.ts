import { BaseDownloadStrategy } from './downloadStrategy';
import { DownloadResult } from '../types';
import * as cheerio from 'cheerio';
import got from 'got';
import * as https from 'https';
import { constants } from 'crypto';
import TurndownService from 'turndown';

/**
 * Strategy for downloading using local HTTPS GET request
 */
export class LocalHttpsStrategy extends BaseDownloadStrategy {
  constructor() {
    super('Local HTTPS', 'HTTPS', 'Local');
  }
  
  isApplicable(url: string): boolean {
    // Apply to all URLs, preferring HTTPS
    return true;
  }
  
  async download(url: string): Promise<DownloadResult> {
    // Ensure URL uses HTTPS
    const httpsUrl = url.replace(/^http:\/\//i, 'https://');
    
    // Fetch the HTML content
    const { html, effectiveUrl } = await this.fetchHtml(httpsUrl);
    
    // Extract links
    const $ = cheerio.load(html);
    const linksSet = new Set<string>();
    
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try {
          const absoluteUrl = new URL(href, effectiveUrl).href;
          linksSet.add(absoluteUrl);
        } catch (e) { /* ignore link parsing errors */ }
      }
    });
    
    const links = Array.from(linksSet);
    
    // Convert HTML to markdown
    const markdown = this.htmlToMarkdown(html, effectiveUrl);
    const size = Buffer.byteLength(markdown, 'utf8');
    
    return {
      content: markdown,
      effectiveUrl,
      size,
      links,
      isMarkdown: true
    };
  }
  
  /**
   * Fetch HTML content from a URL
   * @param url The URL to fetch
   * @returns A promise resolving to the HTML content and effective URL
   */
  private async fetchHtml(url: string): Promise<{ html: string; effectiveUrl: string }> {
    const agent = {
      https: new https.Agent({
        rejectUnauthorized: false,
        minVersion: 'TLSv1',
        maxVersion: 'TLSv1.3',
        secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT | constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
        ciphers: 'ALL',
        honorCipherOrder: true,
      })
    };

    try {
      const response = await got(url, {
        agent,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' },
        followRedirect: true,
        timeout: { request: 5000 }, // 5 second timeout
        throwHttpErrors: true,
        retry: { limit: 1 }
      });
      
      return { html: response.body, effectiveUrl: response.url };
    } catch (error) {
      if (this.isRetryableError(error)) {
        // For specific errors, try variations of the URL
        const potentialUrls = this.generateUrlVariations(url);
        potentialUrls.delete(url); // Don't retry the original URL
        
        for (const fbUrl of potentialUrls) {
          if (!fbUrl) continue;
          try {
            const response = await got(fbUrl, {
              agent: fbUrl.startsWith('https') ? agent : undefined,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36' },
              followRedirect: true,
              timeout: { request: 5000 }, // 5 second timeout
              throwHttpErrors: true,
              retry: { limit: 0 }
            });
            return { html: response.body, effectiveUrl: response.url };
          } catch (fallbackError) {
            // Continue trying other URLs
          }
        }
      }
      
      // If we get here, all attempts failed
      throw new Error(`All HTTPS fetch attempts failed for ${url}`);
    }
  }
  
  /**
   * Determine if an error should trigger retries with URL variations
   */
  private isRetryableError(error: any): boolean {
    return error.code === 'EPROTO' || 
           error.name === 'RequestError' || 
           error.name === 'TimeoutError' || 
           error.code === 'ENOTFOUND' || 
           error.code === 'ECONNREFUSED' || 
           error.response?.statusCode === 403;
  }
  
  /**
   * Generate variations of a URL for fallback attempts
   * (e.g., www vs. non-www variations)
   */
  private generateUrlVariations(url: string): Set<string> {
    const potentialUrls = new Set<string>();
    
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const hasWww = hostname.startsWith('www.');
      const baseHostname = hasWww ? hostname.substring(4) : hostname;
      const wwwHostname = hasWww ? hostname : 'www.' + hostname;

      urlObj.hostname = wwwHostname;
      potentialUrls.add(urlObj.toString());
      urlObj.hostname = baseHostname;
      potentialUrls.add(urlObj.toString());
    } catch (urlParseError) {
      // If URL parsing fails, we can't generate variations
    }
    
    return potentialUrls;
  }
  
  /**
   * Convert HTML to markdown
   * @param html The HTML content to convert
   * @param baseUrl The base URL for resolving relative links
   * @returns The converted markdown content
   */
  private htmlToMarkdown(html: string, baseUrl: string): string {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, link[rel="stylesheet"], noscript, iframe, header, footer, nav, img').remove();
    
    const cleanedHTML = $('body').html() || $.html();
    const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    
    // Add rule for handling links
    turndownService.addRule('links', {
      filter: 'a',
      replacement: (content, node) => {
        const href = (node as Element).getAttribute('href');
        let absoluteUrl = href;
        if (href) {
          try {
            absoluteUrl = new URL(href, baseUrl).href;
          } catch {
            // Ignore URL parsing errors
          }
        }
        return `[${content}](${absoluteUrl || ''})`;
      }
    });
    
    return turndownService.turndown(cleanedHTML);
  }
}
